import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createLineParser } from './parser.js'
import type { ClaudeEvent } from './events.js'
import type { EngineSession } from '../engine/types.js'

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead' | 'in_terminal'

export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** Config do MCP hermes a injetar na sessão via `--mcp-config` (agente↔agente + mural). */
export interface HermesOptions {
  /** Executável que roda o MCP hermes (dev: node/process.execPath; empacotado: o binário). */
  command: string
  /** Args fixos para `command` (dev: [caminho do hermes-mcp.mjs]; empacotado: ['--hermes']). */
  args: string[]
  /** URL base da API do Termaster (para o script chamar de volta). */
  apiUrl: string
  /** Id do projeto dono desta sessão, repassado ao script via env. */
  projectId: number
  /** JWT de serviço assinado pelo servidor, repassado ao script via env (auth multi-usuário). Ausente = sem token. */
  serviceToken?: string
  /** Engine dona desta sessão (claude/codex/opencode) — marca quem despachou nas tasks. */
  engine?: string
}

export interface SessionOptions {
  projectPath: string
  resumeSessionId?: string
  claudeBin?: string
  extraArgs?: string[]
  /** Somente testes: substitui TODOS os args (para apontar para o fake-claude). */
  extraArgsOverride?: string[]
  /** @deprecated Ignorado: o launch sempre usa --dangerously-skip-permissions. Mantido para não quebrar consumidores existentes. */
  skipPermissions?: boolean
  /** Continuar a última conversa da pasta (--continue). Ignorado se resumeSessionId estiver definido. Default: false. */
  continueLatest?: boolean
  /** Se presente, injeta o servidor MCP hermes nesta sessão via --mcp-config. */
  hermes?: HermesOptions
  /** Alias do modelo a usar (--model). Vazio/ausente → não passa a flag (usa o padrão do claude). */
  model?: string
  /** Nível de effort persistido (--effort low|medium|high|xhigh|max). Ausente → padrão (auto). */
  effort?: string
  /** Modo de permissão desejado; aplicado por control_request pós-init se ≠ bypassPermissions. Default bypass. */
  permissionMode?: PermissionMode
  /** Timeout (ms) para o control_response. Default 10000. */
  controlTimeoutMs?: number
}

/** Monta a lista de args do `claude` a partir das opções de sessão. Pura e exportada para testes. */
export function buildClaudeArgs(opts: {
  continueLatest?: boolean
  resumeSessionId?: string
  hermes?: HermesOptions
  model?: string
  effort?: string
}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ]
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  else if (opts.continueLatest) args.push('--continue')
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.hermes) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        hermes: {
          command: opts.hermes.command,
          args: opts.hermes.args,
          env: {
            CLAUDINEI_API: opts.hermes.apiUrl,
            CLAUDINEI_PROJECT_ID: String(opts.hermes.projectId),
            ...(opts.hermes.serviceToken ? { CLAUDINEI_SERVICE_TOKEN: opts.hermes.serviceToken } : {}),
            ...(opts.hermes.engine ? { CLAUDINEI_ENGINE: opts.hermes.engine } : {}),
          },
        },
      },
    })
    args.push('--mcp-config', mcpConfig)
  }
  return args
}

export class ClaudeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  private proc?: ChildProcessWithoutNullStreams
  private stopping = false
  private stderrTail: string[] = []
  private controlSeq = 0
  private pendingControls = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  get lastStderr(): string { return this.stderrTail.join('').trim() }

  constructor(private opts: SessionOptions) {
    super()
  }

  start(): void {
    if (this.proc) throw new Error('sessão já iniciada')
    let args: string[]
    if (this.opts.extraArgsOverride) {
      args = this.opts.extraArgsOverride
    } else {
      args = buildClaudeArgs({
        continueLatest: this.opts.continueLatest,
        resumeSessionId: this.opts.resumeSessionId,
        hermes: this.opts.hermes,
        model: this.opts.model,
        effort: this.opts.effort,
      })
      if (this.opts.extraArgs) args.push(...this.opts.extraArgs)
    }
    this.proc = spawn(this.opts.claudeBin ?? 'claude', args, {
      cwd: this.opts.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      // EMPÍRICO (T3 — binário empacotado, ver task-3-report.md): @yao-pkg/pkg
      // faz monkey-patch de child_process.spawn (patchChildProcess) — TODO
      // spawn feito de dentro de um processo pkg ganha `PKG_EXECPATH=<execPath
      // do binário>` no env automaticamente, mesmo spawnando um binário NÃO-pkg
      // como o `claude` aqui. O `claude`, por sua vez, herda esse env e o
      // REPASSA para os MCP servers que ele spawna (comportamento normal de
      // herança de env) — quando hermes.command é o PRÓPRIO binário empacotado
      // (Task 3), o subprocesso hermes recebe PKG_EXECPATH===seu próprio
      // execPath e o bootstrap do pkg trata isso como "fui spawnado
      // deliberadamente pra rodar outro script" (mesmo mecanismo do bug do
      // speech-worker — ver transcriber.ts), tentando resolver '--hermes' como
      // caminho de arquivo real e falhando — o hermes nunca conecta (silencioso
      // do lado do claude, sem erro visível). Setar PKG_EXECPATH='' aqui evita
      // que o valor se propague por essa cadeia (pkg só injeta quando
      // `env.PKG_EXECPATH === undefined`). Fora do binário (dev/testes), isto
      // não tem efeito nenhum (var ignorada).
      env: { ...process.env, PKG_EXECPATH: '' },
    })
    const feed = createLineParser((evt) => this.handleEvent(evt))
    this.proc.stdout.on('data', feed)
    this.proc.stderr.on('data', (d) => {
      const s = d.toString()
      this.stderrTail.push(s)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      this.emit('stderr', s)
    })
    this.proc.stdin.on('error', (err) => this.emit('stderr', String(err)))
    this.proc.on('close', (code) => {
      for (const [, p] of this.pendingControls) { clearTimeout(p.timer); p.reject(new Error('sessão encerrou')) }
      this.pendingControls.clear()
      this.setStatus(this.stopping ? 'stopped' : 'dead')
      this.emit('exit', code)
    })
    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = CLI não instalada: sem isto o dead sai com stderr vazio e a UI
      // mostra só o genérico "processo encerrou inesperadamente".
      if (err.code === 'ENOENT') {
        const msg = `\`${this.opts.claudeBin ?? 'claude'}\` não encontrado no PATH — instale a Claude Code CLI (npm install -g @anthropic-ai/claude-code) ou configure CLAUDINEI_CLAUDE_BIN`
        this.stderrTail.push(msg)
        this.emit('stderr', msg)
      }
      this.setStatus('dead')
    })
  }

  private handleEvent(evt: ClaudeEvent): void {
    if (evt.kind === 'raw') {
      const raw = evt.raw as any
      if (raw?.type === 'control_response') {
        const rid = raw.response?.request_id
        const pending = rid ? this.pendingControls.get(rid) : undefined
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingControls.delete(rid)
          if (raw.response?.subtype === 'success') pending.resolve()
          else pending.reject(new Error(raw.response?.error ?? 'controle falhou'))
        }
        return // não vaza como evento de chat
      }
    }
    if (evt.kind === 'init') {
      this.sessionId = evt.sessionId
      if (this.status === 'starting') this.setStatus('idle')
      const desired = this.opts.permissionMode
      if (desired && desired !== 'bypassPermissions') {
        void this.setPermissionMode(desired).catch((err) => {
          this.emit('stderr', `[claudinei] falha ao aplicar modo de permissão "${desired}" no init: ${(err as Error).message} — a sessão pode estar em bypassPermissions\n`)
        })
      }
    }
    if (evt.kind === 'result' && this.status === 'working') this.setStatus('needs_attention')
    this.emit('event', evt)
  }

  send(text: string): void {
    // Enviar DURANTE 'working' é válido: o CLI incorpora a mensagem no turno
    // em andamento (steering, igual à TUI) — provado empiricamente: o adendo
    // entra na mesma resposta e sai um único result. Só stopped/dead recusam.
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') {
      throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    }
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
    this.setStatus('working')
  }

  markRead(): void {
    if (this.status === 'needs_attention') this.setStatus('idle')
  }

  private sendControl(subtype: string, payload: object, opts?: { allowWorking?: boolean }): Promise<void> {
    const workingBlocked = this.status === 'working' && !opts?.allowWorking
    if (!this.proc || this.status === 'stopped' || this.status === 'dead' || workingBlocked) {
      return Promise.reject(new Error(`sessão não aceita controle no status ${this.status}`))
    }
    const request_id = `ctrl-${++this.controlSeq}`
    const proc = this.proc
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(request_id)
        reject(new Error('sem resposta do Claude ao controle (timeout)'))
      }, this.opts.controlTimeoutMs ?? 10_000)
      this.pendingControls.set(request_id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id, request: { subtype, ...payload } }) + '\n')
    })
  }

  setModel(model: string): Promise<void> { return this.sendControl('set_model', { model }) }
  setPermissionMode(mode: string): Promise<void> { return this.sendControl('set_permission_mode', { mode }) }
  /** No-op: o Claude aplica effort via mensagem /effort do frontend (protocolo próprio, inalterado). */
  setEffort(_effort: string): Promise<void> { return Promise.resolve() }

  /** Aborta o turno em andamento. Fora de 'working' é no-op (o turno já acabou). */
  interrupt(): Promise<void> {
    if (this.status !== 'working') return Promise.resolve()
    return this.sendControl('interrupt', {}, { allowWorking: true })
  }

  async stop(): Promise<void> {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') return
    this.stopping = true
    this.proc.stdin.end()
    await new Promise<void>((resolve) => {
      const proc = this.proc!
      const timer = setTimeout(() => { proc.kill('SIGKILL') }, 10_000)
      proc.once('close', () => { clearTimeout(timer); resolve() })
    })
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) {
      this.status = s
      this.emit('status', s)
    }
  }
}
