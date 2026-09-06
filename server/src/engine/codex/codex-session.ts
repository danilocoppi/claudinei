import { EventEmitter } from 'node:events'
import type { EngineSession, EngineSessionOptions, AgentEvent } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { userEchoEvent } from '../echo.js'
import { buildAppServerArgs } from './codex-args.js'
import { CodexRpc, CodexRpcError } from './codex-rpc.js'
import { codexItemEvents, tokenNumber, usageTotals, type CodexUsage } from './codex-items.js'
import { latestThreadForCwd, sessionsRoot } from './rollout.js'

/** Uma conexão App Server por sessão, com o mesmo id/storage das conversas do TUI. */
export class CodexSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  compactingSince?: number
  private rpc?: CodexRpc
  private ready?: Promise<void>
  private stopping = false
  private interrupting = false
  private turnId?: string
  private operation?: 'message' | 'compact'
  private completedTurns = new Set<string>()
  private stderrTail = ''
  private model?: string
  private effort?: string
  private configuredModel?: string
  private configuredEffort?: string
  private contextTokens?: number
  private contextWindow?: number
  private total?: CodexUsage
  private turnBaseline?: CodexUsage
  private lastText = ''
  private preCompactTokens?: number
  private compactUsage?: { tokens: number; window?: number }
  private pendingInputs: { text: string }[] = []
  private steering = false
  private deferSteeringFor?: string

  constructor(private opts: EngineSessionOptions & { binOverride?: string }) {
    super()
    this.model = opts.model
    this.effort = opts.effort
    this.sessionId = opts.resumeSessionId
  }
  get lastStderr(): string { return this.stderrTail.trim() }

  start(): void {
    if (!this.sessionId && this.opts.continueLatest) this.sessionId = latestThreadForCwd(sessionsRoot(), this.opts.projectPath) ?? undefined
    // Resume recupera a medição persistida sem gastar um turno do modelo.
    if (this.sessionId) void this.ensureReady().then(() => {
      if (this.status === 'starting') this.setStatus('idle')
    }).catch((err) => this.fail(err))
    else this.setStatus('idle')
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
      this.rpc = new CodexRpc({
        bin, args: this.opts.extraArgsOverride ?? buildAppServerArgs({ hermes: this.opts.hermes }),
        cwd: this.opts.projectPath,
        notification: (method, p) => this.notification(method, p),
        failure: (err) => this.fail(err),
        stderr: (text) => { this.stderrTail = (this.stderrTail + text).slice(-16_384) },
      })
      await this.rpc.initialize()
      const config = await this.rpc.request('config/read', { includeLayers: false })
      this.configuredModel = config?.config?.model ?? undefined
      this.configuredEffort = config?.config?.model_reasoning_effort ?? undefined
      const resumed = !!this.sessionId
      const response = await this.rpc.request(resumed ? 'thread/resume' : 'thread/start', {
        cwd: this.opts.projectPath, approvalPolicy: 'never', sandbox: 'danger-full-access',
        ...(this.model ? { model: this.model } : {}),
        config: this.effort ? { model_reasoning_effort: this.effort } : {},
        ...(resumed ? { threadId: this.sessionId, excludeTurns: true } : {}),
      })
      if (!response?.thread?.id) throw new Error('codex: thread sem identificador')
      this.sessionId = response.thread.id
      this.configuredModel ??= response.model
      this.event({ kind: 'init', sessionId: this.sessionId!, model: response.model ?? this.model ?? '', slashCommands: [], raw: {} })
      this.turnBaseline = this.total
    })()
    return this.ready
  }

  send(text: string, opts?: { echoToClients?: boolean }): void {
    if (typeof text !== 'string') throw new Error('mensagem inválida')
    if (text.trim() === '/compact') { this.compact(); return }
    if (!['starting', 'idle', 'needs_attention', 'working'].includes(this.status)) throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if ((this.status === 'working' && this.operation) || this.steering || this.pendingInputs.length) {
      if (this.interrupting) throw new Error('aguarde a interrupção terminar antes de enviar outra mensagem')
      this.pendingInputs.push({ text })
      if (opts?.echoToClients) this.event(userEchoEvent(text))
      this.flushInputs()
      return
    }
    this.reserve('message')
    if (opts?.echoToClients) this.event(userEchoEvent(text))
    void this.begin(text).catch((err) => this.fail(err))
  }
  compact(): void {
    if (!this.sessionId) throw new Error('inicie uma conversa antes de compactar')
    this.reserve('compact')
    void this.begin().catch((err) => this.fail(err))
  }
  private reserve(operation: 'message' | 'compact'): void {
    if (!['idle', 'needs_attention', 'starting'].includes(this.status) || this.operation) throw new Error(`sessão não aceita operação no status ${this.status}`)
    this.operation = operation; this.turnId = undefined; this.interrupting = false
    this.lastText = ''; this.turnBaseline = this.total
    this.setStatus('working')
  }
  private async begin(text?: string): Promise<void> {
    await this.ensureReady()
    if (this.stopping || this.status === 'dead') return
    if (this.interrupting) { this.finish(true); return }
    // O resume pode publicar uso antigo antes desta operação começar.
    this.turnBaseline = this.total
    try {
      if (text === undefined) {
        await this.rpc!.request('thread/compact/start', { threadId: this.sessionId })
      } else {
        const result = await this.rpc!.request('turn/start', {
          threadId: this.sessionId, input: [{ type: 'text', text, text_elements: [] }],
          ...(this.model || this.configuredModel ? { model: this.model || this.configuredModel } : {}),
          effort: this.effort || this.configuredEffort || null,
        })
        // Um turno curto pode completar antes da confirmação do RPC.
        if (this.operation && result?.turn?.id && !this.completedTurns.has(result.turn.id)) this.turnId = result.turn.id
      }
      if (this.interrupting && this.turnId && this.operation) await this.cancelTurn()
      this.flushInputs()
    } catch (err) {
      if (!this.stopping && !['dead', 'stopped'].includes(this.status)) this.finish(false, (err as Error).message)
    }
  }

  /** Entrega em ordem ao turno ativo; durante arranque/compactação espera o ponto seguro. */
  private flushInputs(): void {
    if (this.steering || !this.pendingInputs.length || this.stopping || ['dead', 'stopped'].includes(this.status)) return
    if (!this.operation && ['idle', 'needs_attention'].includes(this.status)) {
      const { text } = this.pendingInputs.shift()!
      this.reserve('message')
      void this.begin(text).catch((err) => this.fail(err))
      return
    }
    const turnId = this.turnId
    if (this.operation !== 'message' || !turnId || !this.rpc || this.compactingSince || this.interrupting || this.deferSteeringFor === turnId) return
    const input = this.pendingInputs[0]
    const { text } = input
    this.steering = true
    void this.rpc.request('turn/steer', {
      threadId: this.sessionId, expectedTurnId: turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    }).then(() => {
      this.pendingInputs = this.pendingInputs.filter((it) => it !== input)
    }).catch((err: Error) => {
      if (!this.pendingInputs.includes(input)) return // fail/stop/interrupt já avisou sobre este envio
      if (err instanceof CodexRpcError) {
        // O turno pode ter terminado antes de o RPC chegar. Houve REJEIÇÃO,
        // então é seguro iniciar outro turno assim que chegar turn/completed.
        // Não insiste neste turno (também cobre CLIs sem suporte a steer).
        this.deferSteeringFor = turnId
      } else {
        // Timeout não prova rejeição: não reenviar silenciosamente e duplicar trabalho.
        this.pendingInputs = this.pendingInputs.filter((it) => it !== input)
        this.deliveryError(text, `Não foi possível confirmar a entrega: ${err.message}`)
      }
    }).finally(() => { this.steering = false; this.flushInputs() })
  }

  private deliveryError(text: string, error: string): void {
    this.event({ kind: 'system', subtype: 'message_error', raw: { message: `Mensagem pendente do Codex: ${text}\n\n${error}` } })
  }
  private cancelInputs(reason: string): void {
    for (const { text } of this.pendingInputs.splice(0)) this.deliveryError(text, reason)
  }

  private notification(method: string, p: any): void {
    if (!p || this.stopping || this.status === 'dead') return
    // Subagentes não podem mudar a medição nem encerrar o turno principal.
    if (p.threadId && p.threadId !== this.sessionId) return
    if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage
      const total = usageTotals(usage?.total)
      if (total) this.total = total
      if (!this.turnId) this.turnBaseline = this.total
      const last = usageTotals(usage?.last)
      this.contextTokens = last?.totalTokens
      this.contextWindow = tokenNumber(usage?.modelContextWindow) && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined
      if (this.compactingSince && this.contextTokens !== undefined) this.compactUsage = { tokens: this.contextTokens, window: this.contextWindow }
      this.publishContext()
    } else if (method === 'turn/started') {
      this.turnId = p.turn?.id
      if (!this.operation) { this.operation = 'message'; this.turnBaseline = this.total; this.lastText = '' }
      this.setStatus('working')
      this.flushInputs()
      if (this.interrupting && this.turnId) void this.cancelTurn().catch((err) => this.fail(err))
    } else if (method === 'item/agentMessage/delta') {
      if (typeof p.delta === 'string') this.event({ kind: 'stream', text: p.delta, raw: {} })
    } else if ((method === 'item/started' || method === 'item/completed') && p.item?.type === 'contextCompaction') {
      if (method === 'item/started') {
        if (!this.compactingSince) { this.preCompactTokens = this.contextTokens; this.compactUsage = undefined }
        this.compactingSince ??= Date.now()
      } else {
        this.compactingSince = undefined; this.contextTokens = undefined
        this.event({ kind: 'system', subtype: 'compact_boundary', raw: { compact_metadata: { pre_tokens: this.preCompactTokens } } })
        // A CLI 0.153 envia a medição pós-compactação ANTES do item/completed.
        if (this.compactUsage) { this.contextTokens = this.compactUsage.tokens; this.contextWindow = this.compactUsage.window }
        this.compactUsage = undefined
        this.publishContext()
      }
      this.emit('status', this.status)
      this.flushInputs()
    } else if (method === 'item/completed') {
      if (p.item?.type === 'agentMessage') this.lastText = p.item.text ?? this.lastText
      for (const event of codexItemEvents(p.item, p)) this.event(event)
    } else if (method === 'turn/completed') {
      const id = p.turn?.id
      if (!this.operation || (id && this.completedTurns.has(id))) return
      if (this.turnId && id && id !== this.turnId) return
      if (id) {
        this.completedTurns.add(id)
        if (this.completedTurns.size > 100) this.completedTurns.delete(this.completedTurns.values().next().value!)
      }
      this.finish(p.turn?.status === 'interrupted', p.turn?.status === 'failed' ? p.turn?.error?.message ?? 'codex turn failed' : undefined)
    }
  }
  private publishContext(): void {
    this.event({ kind: 'context', contextTokens: this.contextTokens, contextWindow: this.contextWindow, raw: {} })
  }
  private finish(interrupted = false, error?: string): void {
    const compact = this.operation === 'compact'
    const operation = this.operation
    this.operation = undefined; this.turnId = undefined; this.compactingSince = undefined
    if (!operation) return
    if (error) this.event({ kind: 'system', subtype: 'message_error', raw: { message: error } })
    const delta = (key: keyof CodexUsage) => Math.max(0, (this.total?.[key] ?? 0) - (this.turnBaseline?.[key] ?? 0))
    this.event({
      kind: 'result', subtype: error ? 'error' : compact ? 'compact' : interrupted ? 'interrupted' : 'success',
      isError: !!error, resultText: error ?? this.lastText, costUsd: 0, raw: {},
      tokens: this.total ? { input: delta('inputTokens'), cachedInput: delta('cachedInputTokens'), output: delta('outputTokens'), reasoning: delta('reasoningOutputTokens'), total: delta('totalTokens') } : undefined,
    })
    this.setStatus(interrupted ? 'idle' : 'needs_attention')
    this.flushInputs()
  }
  private fail(err: Error): void {
    if (this.stopping || this.status === 'dead' || this.status === 'stopped') return
    this.stderrTail = (this.stderrTail + '\n' + err.message).slice(-16_384)
    this.cancelInputs(`O processo encerrou antes da confirmação de entrega: ${err.message}`)
    this.finish(false, err.message)
    this.setStatus('dead')
    void this.rpc?.stop()
  }
  markRead(): void { if (this.status === 'needs_attention') this.setStatus('idle') }
  private async cancelTurn(): Promise<void> {
    if (this.turnId) await this.rpc!.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId })
  }
  async interrupt(): Promise<void> {
    if (this.status !== 'working') return
    this.interrupting = true
    this.cancelInputs('Envio pendente cancelado pela interrupção do usuário. Reenvie para continuar.')
    await this.cancelTurn()
  }
  async setModel(model: string): Promise<void> {
    this.model = model || undefined
    this.contextWindow = undefined; this.contextTokens = undefined
    this.publishContext()
  }
  async setEffort(effort: string): Promise<void> { this.effort = effort || undefined }
  async setPermissionMode(_mode: string): Promise<void> {} // full-access como na integração anterior
  async stop(): Promise<void> {
    this.stopping = true; this.operation = undefined; this.compactingSince = undefined
    this.cancelInputs('A sessão foi encerrada antes da confirmação de entrega. Reenvie ao retomá-la.')
    await this.rpc?.stop()
    this.setStatus('stopped')
  }
  private event(event: AgentEvent): void { this.emit('event', event) }
  private setStatus(status: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (status !== this.status) { this.status = status; this.emit('status', status) }
  }
}
