import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { EngineSession, EngineSessionOptions, AgentEvent } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { userEchoEvent } from '../echo.js'
import { buildAppServerArgs } from './codex-args.js'
import { CodexRpc, CodexRpcError } from './codex-rpc.js'
import { codexItemEvents, tokenNumber, usageTotals, type CodexUsage } from './codex-items.js'
import { latestThreadForCwd, sessionsRoot } from './rollout.js'
import { loadInstructions } from '../../hermes/instructions.js'
import { codexForkParams } from '../../branch/engine-args.js'
import type { HermesOptions } from '../../claude/session.js'

/** O token de serviço do Hermes: do arquivo 0600 quando houver (é o que o servidor reescreve no revoke-all). */
function hermesToken(h: HermesOptions): string | undefined {
  if (h.serviceTokenFile) {
    try { return readFileSync(h.serviceTokenFile, 'utf8').trim() } catch { /* cai no token direto */ }
  }
  return h.serviceToken
}

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

  constructor(private opts: EngineSessionOptions & { binOverride?: string; writerWait?: { retryMs: number; deadlineMs: number } }) {
    super()
    this.model = opts.model
    this.effort = opts.effort
    this.sessionId = opts.resumeSessionId
  }
  get lastStderr(): string { return this.stderrTail.trim() }

  start(): void {
    if (!this.sessionId && this.opts.continueLatest) this.sessionId = latestThreadForCwd(sessionsRoot(), this.opts.projectPath) ?? undefined
    // Resume recupera a medição persistida sem gastar um turno do modelo.
    // A cópia (forkFrom) também abre na partida: o id dela sai antes de qualquer mensagem.
    if (this.sessionId || this.opts.forkFrom) void this.ensureReady().then(() => {
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
      // O Codex não lê as instructions dos servidores MCP (CLI 0.159): a regra
      // do terminal errado, que os outros motores recebem do Hermes, vai aqui.
      const hermes = this.opts.hermes
      const rule = hermes ? await loadInstructions({ api: hermes.apiUrl, projectId: hermes.projectId, token: hermesToken(hermes) }) : undefined
      // O parâmetro da conversa SUBSTITUI o developer_instructions do config.toml
      // do operador: as dele vêm primeiro, a regra depois.
      const own = typeof config?.config?.developer_instructions === 'string' ? config.config.developer_instructions.trim() : ''
      const developerInstructions = rule && own ? `${own}\n\n${rule}` : rule
      const params = {
        ...(developerInstructions ? { developerInstructions } : {}),
        cwd: this.opts.projectPath, approvalPolicy: 'never', sandbox: this.opts.readOnly ? 'read-only' : 'danger-full-access',
        ...(this.model ? { model: this.model } : {}),
        config: this.effort ? { model_reasoning_effort: this.effort } : {},
        ...(resumed ? { threadId: this.sessionId, excludeTurns: true } : {}),
      }
      const forkFrom = this.opts.forkFrom
      const response = forkFrom ? await this.rpc.request('thread/fork', codexForkParams(params, { ...this.opts, forkFrom }))
        : resumed ? await this.resumeWhenFree(params) : await this.rpc.request('thread/start', params)
      if (!response?.thread?.id) throw new Error('codex: thread sem identificador')
      this.sessionId = response.thread.id
      this.configuredModel ??= response.model
      this.event({ kind: 'init', sessionId: this.sessionId!, model: response.model ?? this.model ?? '', slashCommands: [], raw: {} })
      this.turnBaseline = this.total
    })()
    return this.ready
  }

  /**
   * Retoma a conversa, esperando se outro Codex estiver com ela aberta. A CLI só
   * deixa um processo gravar cada conversa, e o daemon do TUI a segura por mais
   * 60 s depois que o terminal fecha — sem esperar, voltar do terminal para o
   * chat matava a sessão. A mesma conexão serve para tentar de novo: a recusa
   * não derruba o app-server. Qualquer outro erro continua fatal na hora.
   */
  private async resumeWhenFree(params: object): Promise<any> {
    const { retryMs, deadlineMs } = this.opts.writerWait ?? { retryMs: 2000, deadlineMs: 75_000 }
    const deadline = Date.now() + deadlineMs
    for (;;) {
      try {
        return await this.rpc!.request('thread/resume', params)
      } catch (err) {
        if (!(err instanceof CodexRpcError) || !/already has an active writer/.test(err.message)) throw err
        if (Date.now() + retryMs > deadline) {
          throw new Error(`A conversa está aberta em outro Codex (terminal ou app) e não foi solta em ${Math.round(deadlineMs / 1000)} s. Feche-o e reviva a sessão.`)
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
    }
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
      if (this.turnId) this.event({ kind: 'system', subtype: 'turn_started', raw: { turnId: this.turnId } }) // âncora do desfazer
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

  // --- Desfazer: voltar a conversa (thread/revert, ou thread/fork se recusar) ---

  /** A conexão pronta para mexer na conversa. Recusa com operação em curso: o corte não pode cair no meio de um turno. */
  private async idleRpc(): Promise<CodexRpc> {
    const busy = () => !!this.operation || this.steering || this.pendingInputs.length > 0 || this.status === 'working'
    if (busy()) throw new Error('codex: há uma operação em curso; espere o turno terminar para voltar a conversa')
    if (!this.sessionId) throw new Error('codex: sem conversa para voltar')
    await this.ensureReady()
    if (this.stopping || this.status === 'dead' || this.status === 'stopped') throw new Error(`codex: sessão ${this.status}`)
    if (busy()) throw new Error('codex: há uma operação em curso; espere o turno terminar para voltar a conversa')
    return this.rpc!
  }
  /** Troca o histórico pelo trecho antes de `beforeTurnId`. O thread segue o mesmo; os arquivos não mudam. */
  async revertConversation(beforeTurnId: string): Promise<void> {
    const rpc = await this.idleRpc()
    await rpc.request('thread/revert', { threadId: this.sessionId, beforeTurnId })
  }
  /** Conversa nova com os turnos até `lastTurnId` (inclusive). Devolve o id dela; quem chama passa o terminal para ele. */
  async forkConversation(lastTurnId: string): Promise<string> {
    const rpc = await this.idleRpc()
    // excludeTurns: conversa paginada recusa o fork sem ele (CLI 0.159.2).
    const response = await rpc.request('thread/fork', {
      threadId: this.sessionId, lastTurnId, excludeTurns: true,
      cwd: this.opts.projectPath, approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
    if (!response?.thread?.id) throw new Error('codex: fork sem identificador')
    return response.thread.id
  }
  /** Os turnos da conversa, do mais antigo ao mais novo, com os textos de cada `userMessage` (o primeiro e os de steer). */
  async listTurns(): Promise<Array<{ id: string; userTexts: string[] }>> {
    const rpc = await this.idleRpc()
    const desc: Array<{ id: string; userTexts: string[] }> = []
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page: any = await rpc.request('thread/turns/list', { threadId: this.sessionId, sortDirection: 'desc', itemsView: 'full', limit: 20, cursor })
      for (const turn of Array.isArray(page?.data) ? page.data : []) {
        if (typeof turn?.id !== 'string') continue
        const userTexts = (Array.isArray(turn.items) ? turn.items : [])
          .filter((it: any) => it?.type === 'userMessage')
          .map((it: any) => (Array.isArray(it.content) ? it.content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join(''))
        desc.push({ id: turn.id, userTexts })
      }
      cursor = typeof page?.nextCursor === 'string' && !seen.has(page.nextCursor) ? page.nextCursor : null
      if (cursor) seen.add(cursor)
    } while (cursor)
    return desc.reverse()
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
