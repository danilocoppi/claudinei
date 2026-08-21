import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createLineParser } from './parser.js'
import type { ClaudeEvent } from './events.js'
import type { EngineSession } from '../engine/types.js'
import { userEchoEvent } from '../engine/echo.js'

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
  /** Caminho de um arquivo 0600 com o JWT de serviço. Preferido sobre serviceToken: só o CAMINHO vai no argv/config da engine (o token em si ficaria visível em `ps`/cmdline para qualquer usuário do SO). */
  serviceTokenFile?: string
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
            ...(opts.hermes.serviceTokenFile
              ? { CLAUDINEI_SERVICE_TOKEN_FILE: opts.hermes.serviceTokenFile }
              : opts.hermes.serviceToken ? { CLAUDINEI_SERVICE_TOKEN: opts.hermes.serviceToken } : {}),
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
  /**
   * Tasks despachadas com run_in_background que ainda rodam. O CLI manda a lista
   * COMPLETA a cada mudança (system/background_tasks_changed), então ela é a fonte
   * autoritativa — substituímos, nunca acumulamos. `task_started` chega antes e
   * traz description/subagent_type, que a lista não repete.
   */
  private bgTasks = new Map<string, { id: string; description: string; type: string; prompt: string }>()
  private bgMeta = new Map<string, { description: string; type: string; prompt: string }>()
  /** OAuth do Claude expirado (a CLI respondeu `auth_expired`). Ver detectAuthExpired. */
  private authExpiredFlag = false
  private pendingControls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  get lastStderr(): string { return this.stderrTail.join('').trim() }

  /**
   * A sessão parou por credencial expirada? A partir daqui todo turno falha até
   * reautenticar — a UI usa isto para oferecer o login em vez de mostrar mais um
   * erro genérico de API.
   */
  get authExpired(): boolean { return this.authExpiredFlag }

  /** Tasks em background ainda rodando nesta sessão. */
  get backgroundTasks(): { id: string; description: string; type: string; prompt: string }[] {
    return [...this.bgTasks.values()]
  }

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
          if (raw.response?.subtype === 'success') pending.resolve(raw.response?.response)
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
    if (evt.kind === 'system') this.trackBackgroundTasks(evt.raw)
    this.detectAuthExpired(evt)
    // A engine pode retomar SOZINHA, sem ninguém mandar mensagem: quando uma task
    // despachada com run_in_background termina, o CLI fecha o turno (result) e
    // dispara um turno NOVO por conta própria — init, conteúdo e um segundo result
    // com origin.kind='task-notification' (medido no CLI real). Como a sessão só
    // entrava em 'working' pelo send() do operador, esse turno rodava inteiro com a
    // UI dizendo "idle": conteúdo pingando na tela, bolinha apagada e o filtro
    // "somente ativos" escondendo o terminal justamente enquanto ele trabalhava.
    //
    // Só idle/needs_attention voltam a working: stopped/dead não podem ser
    // ressuscitados por um evento atrasado, e in_terminal é outra visão (o PTY é
    // que manda no status dela).
    if ((evt.kind === 'assistant' || evt.kind === 'stream') &&
        (this.status === 'idle' || this.status === 'needs_attention')) {
      this.turnSeq++
      this.setStatus('working')
    }
    // Um result com task de background ativa NÃO encerra o trabalho: só o turno
    // que a despachou acabou. Marcar needs_attention aqui mostraria o terminal
    // parado — e o filtro "somente ativos" o esconderia — enquanto o subagente
    // ainda trabalha. A lista esvazia sozinha (o CLI avisa) e o result seguinte
    // fecha normalmente.
    if (evt.kind === 'result' && this.status === 'working' && this.bgTasks.size === 0) {
      this.setStatus('needs_attention')
    }
    this.emit('event', evt)
  }

  send(text: string, opts?: { echoToClients?: boolean }): void {
    // Enviar DURANTE 'working' é válido: o CLI incorpora a mensagem no turno
    // em andamento (steering, igual à TUI) — provado empiricamente: o adendo
    // entra na mesma resposta e sai um único result. Só stopped/dead recusam.
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') {
      throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    }
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
    if (opts?.echoToClients) this.emit('event', userEchoEvent(text))
    this.turnSeq++
    this.setStatus('working')
  }

  /**
   * Inicia o fluxo OAuth de reautenticação — o mesmo que a TUI dispara no
   * `/login`. Devolve as duas URLs que a CLI oferece: a automática (o navegador
   * volta sozinho ao callback) e a manual (o usuário copia um código). Quando o
   * token expira, a CLI passa a responder `auth_expired` e a sessão vira uma
   * sequência de erros sem explicação; isto é o caminho de volta sem abrir o
   * terminal.
   *
   * `allowWorking`: a expiração costuma ser descoberta NO MEIO de um turno.
   */
  async startAuth(): Promise<{ manualUrl: string; automaticUrl: string }> {
    const res = (await this.sendControl('claude_authenticate', { loginWithClaudeAi: true }, { allowWorking: true })) as
      { manualUrl?: string; automaticUrl?: string } | undefined
    return { manualUrl: res?.manualUrl ?? '', automaticUrl: res?.automaticUrl ?? '' }
  }

  /** Entrega o código/URL que o usuário trouxe do navegador e fecha o fluxo. */
  async completeAuth(codeOrUrl: string): Promise<void> {
    await this.sendControl('claude_oauth_callback', { manualUrl: codeOrUrl }, { allowWorking: true })
    this.authExpiredFlag = false
    this.emit('status', this.status)
  }

  markRead(): void {
    if (this.status === 'needs_attention') this.setStatus('idle')
  }

  private sendControl(subtype: string, payload: object, opts?: { allowWorking?: boolean }): Promise<unknown> {
    const workingBlocked = this.status === 'working' && !opts?.allowWorking
    if (!this.proc || this.status === 'stopped' || this.status === 'dead' || workingBlocked) {
      return Promise.reject(new Error(`sessão não aceita controle no status ${this.status}`))
    }
    const request_id = `ctrl-${++this.controlSeq}`
    const proc = this.proc
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(request_id)
        reject(new Error('sem resposta do Claude ao controle (timeout)'))
      }, this.opts.controlTimeoutMs ?? 10_000)
      this.pendingControls.set(request_id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id, request: { subtype, ...payload } }) + '\n')
    })
  }

  // '' = voltar ao modelo Padrão: o protocolo de controle só troca por um modelo
  // nomeado (não tem "reset"), então no processo vivo é no-op — o Padrão vale no
  // relaunch (argv sem --model). As engines turn-based tratam '' nativamente.
  async setModel(model: string): Promise<void> { if (model) await this.sendControl('set_model', { model }) }
  async setPermissionMode(mode: string): Promise<void> { await this.sendControl('set_permission_mode', { mode }) }
  /** No-op: o Claude aplica effort via mensagem /effort do frontend (protocolo próprio, inalterado). */
  setEffort(_effort: string): Promise<void> { return Promise.resolve() }

  /** Aborta o turno em andamento. Fora de 'working' é no-op (o turno já acabou). */
  /**
   * Para uma task de background pelo id. O `interrupt` NÃO alcança essas tasks:
   * ele aborta o TURNO, e uma task de background não vive dentro do turno — é
   * justamente por isso que o turno fecha e ela continua. O protocolo tem um
   * comando próprio: { subtype: 'stop_task', task_id } — "Stops a running task."
   */
  async stopTask(taskId: string): Promise<void> {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') return
    // A CLI confirma e anuncia a saída pelo task_updated; o dropBackgroundTask é
    // rede de segurança para o caso de o anúncio não vir.
    try { await this.sendControl('stop_task', { task_id: taskId }, { allowWorking: true }) }
    finally { this.dropBackgroundTask(taskId) }
  }

  /**
   * Parar significa parar TUDO: o turno em andamento E as tasks de background que
   * ele deixou rodando. Antes só o turno era abortado, então o Stop do chat
   * deixava os subagentes de background trabalhando.
   */
  async interrupt(): Promise<void> {
    const turno = this.turnSeq
    const pending = [...this.bgTasks.keys()]
    // O guard antigo (`status !== 'working'` → no-op) deixava o Stop sem efeito e
    // sem aviso; com task pendente ainda há o que parar mesmo fora de working.
    if (this.status === 'working') {
      await this.sendControl('interrupt', {}, { allowWorking: true })
    }
    // Uma falha ao parar uma task não pode impedir as outras: são independentes.
    await Promise.allSettled(pending.map((id) => this.stopTask(id)))
    // O turno acabou porque MANDARAM parar — e é aqui que isso vira estado.
    //
    // A saída de `working` acontece num lugar só: o `result` do CLI, que é
    // ignorado enquanto há task de background em aberto (de propósito — o turno
    // que despachou o subagente acabou, o subagente não). Na interrupção isso
    // virava armadilha: o `result` chegava com a lista ainda cheia, o status não
    // mudava, e não vinha outro depois. A sessão ficava "trabalhando" para sempre,
    // com as três bolinhas girando na tela de quem acabou de mandar parar.
    //
    // O destino é `needs_attention`, o MESMO em que o `result` de interrupção já
    // deixava a sessão quando não havia task pendente: aqui só se garante que ela
    // chegue lá em todo caso, em vez de ficar pendurada em `working`.
    //
    // E só se o turno ainda for o que se mandou parar: esperar as tasks abre uma
    // janela em que a fila entrega a próxima tarefa, e derrubar o `working` DELA
    // seria interromper um trabalho que acabou de começar.
    if (this.status === 'working' && this.turnSeq === turno) this.setStatus('needs_attention')
  }

  async stop(): Promise<void> {
    // Nada continua rodando depois que o processo morre: segurar a lista deixaria
    // a sessão parecendo ocupada para sempre.
    this.bgTasks.clear()
    this.bgMeta.clear()
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') return
    this.stopping = true
    this.proc.stdin.end()
    await new Promise<void>((resolve) => {
      const proc = this.proc!
      const timer = setTimeout(() => { proc.kill('SIGKILL') }, 10_000)
      proc.once('close', () => { clearTimeout(timer); resolve() })
    })
  }

  /**
   * A CLI avisa a expiração com um texto fixo — `auth_expired`:
   * "Your session has expired. Please run /login to sign in again."
   *
   * Casar pelo texto é feio, mas é o que chega no stream: o erro vem como texto
   * de assistant marcado isApiErrorMessage, sem código de erro estruturado. A
   * frase é específica o bastante para não confundir com 529/rate limit, que são
   * os outros "API Error" que aparecem de verdade.
   */
  private detectAuthExpired(evt: ClaudeEvent): void {
    if (this.authExpiredFlag) return
    let text = ''
    if (evt.kind === 'assistant') {
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      text = blocks.map((b) => (b as { text?: string }).text ?? '').join(' ')
    } else if (evt.kind === 'result') {
      text = evt.resultText ?? ''
    }
    if (!/session has expired|Please run \/login|auth_expired/i.test(text)) return
    this.authExpiredFlag = true
    // Reusa o canal de status: é assim que o manager retransmite aos clientes.
    this.emit('status', this.status)
  }

  /**
   * Acompanha as tasks em background pelos eventos `system` do CLI:
   *  - task_started: traz description/subagent_type (a lista não repete isso)
   *  - background_tasks_changed: a lista COMPLETA do que roda agora
   *  - task_updated (completed/failed): tira a task na hora
   */
  private trackBackgroundTasks(raw: unknown): void {
    const o = raw as { subtype?: string; tasks?: unknown; task_id?: string; description?: string; subagent_type?: string; prompt?: string; patch?: { status?: string } }
    if (o?.subtype === 'task_started' && o.task_id) {
      this.bgMeta.set(o.task_id, { description: o.description ?? '', type: o.subagent_type ?? '', prompt: o.prompt ?? '' })
      return
    }
    if (o?.subtype === 'task_updated' && o.task_id) {
      const st = o.patch?.status
      if (st === 'completed' || st === 'failed') this.dropBackgroundTask(o.task_id)
      return
    }
    if (o?.subtype !== 'background_tasks_changed' || !Array.isArray(o.tasks)) return
    const before = [...this.bgTasks.keys()].join(',')
    this.bgTasks.clear()
    for (const t of o.tasks as { task_id?: string; description?: string }[]) {
      if (!t?.task_id) continue
      const meta = this.bgMeta.get(t.task_id)
      this.bgTasks.set(t.task_id, {
        id: t.task_id,
        description: t.description ?? meta?.description ?? '',
        type: meta?.type ?? '',
        // O prompt só vem no task_started; a lista de mudança não o repete.
        prompt: meta?.prompt ?? '',
      })
    }
    // A UI precisa saber que a composição mudou mesmo quando o status não muda —
    // o canal de status é o que o manager já retransmite para os clientes.
    if (before !== [...this.bgTasks.keys()].join(',')) this.emit('status', this.status)
  }

  private dropBackgroundTask(id: string): void {
    if (!this.bgTasks.delete(id)) return
    this.bgMeta.delete(id)
    this.emit('status', this.status)
  }

  /**
   * Conta os turnos. Só serve para a interrupção saber se o turno que ela abortou
   * ainda é o turno da vez: enquanto ela espera as tasks pararem, a fila pode
   * entregar a PRÓXIMA tarefa — e derrubar o `working` daquela seria parar um
   * trabalho que acabou de começar.
   */
  private turnSeq = 0

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) {
      this.status = s
      this.emit('status', s)
    }
  }
}
