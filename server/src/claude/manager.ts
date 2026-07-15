import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import type { SessionStatus, PermissionMode } from './session.js'
import type { ClaudeEvent } from './events.js'
import { getEngine, DEFAULT_ENGINE_ID, type EngineId, type EngineSession, type EngineSessionOptions } from '../engine/index.js'

export interface SessionInfo {
  localId: string
  projectId: number
  engine: EngineId
  status: SessionStatus
  engineSessionId: string | null
  updatedAt: string
  model: string | null
  permissionMode: PermissionMode
  /** Effort persistido (low..max) ou null = padrão (auto). */
  effort: string | null
}

export interface TerminalLauncherOpts {
  localId: string
  cwd: string
  file: string
  args: string[]
  onExit: () => void
}

interface Deps {
  db: Db
  // Sintaxe de método (não arrow-property): checagem bivariante do parâmetro
  // permite que os testes injetem `(opts: SessionOptions) => ClaudeSession`
  // (mais estrito que EngineSessionOptions/EngineSession) sem cast — o
  // arrow-property seria checado contravariantemente e rejeitaria essa
  // injeção mesmo sendo seguro em runtime (ClaudeSession implements EngineSession).
  sessionFactory?(opts: EngineSessionOptions): EngineSession
  broadcast: (msg: object) => void
  /** Injetável: lança o Claude interativo num PTY e retorna o token do canal. Obrigatório para openInTerminal. */
  terminalLauncher?: (opts: TerminalLauncherOpts) => string
  /** Se presente, toda sessão criada recebe o MCP hermes (agente↔agente + mural) via --mcp-config. */
  hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string }
  /** Chamado quando um evento init traz a lista de slash commands (para persistir). */
  onSlashCommands?: (cmds: string[]) => void
  /** Quantas sessões terminais (dead/stopped) manter por projeto no prune de arranque (default 5). */
  keepSessionsPerProject?: number
  /**
   * Chamado (via microtask, nunca inline) quando uma sessão do projeto vira
   * 'idle' ou 'needs_attention' — sinal de que o alvo está livre para receber
   * a próxima tarefa da fila. O adiamento evita reentrância: se disparasse
   * sincronamente dentro do próprio handler de status, um dispatchTask novo
   * poderia anexar seus listeners de 'event' a tempo de capturar o result
   * event que ainda está sendo emitido para a tarefa que acabou de terminar.
   */
  onSessionAvailable?: (projectId: number) => void
  /** Chamado quando um evento result traz tokens (Codex e demais engines que os expõem). Claude não seta tokens → nunca dispara. */
  onEngineUsage?: (engine: EngineId, tokens: { input: number; cachedInput: number; output: number; reasoning: number; total: number }) => void
}

const ACTIVE = new Set<SessionStatus>(['starting', 'idle', 'working', 'needs_attention'])

export function createSessionManager(deps: Deps) {
  const live = new Map<string, { session: EngineSession; projectId: number; engine: EngineId }>()
  // Resolve a sessão pela engine (registry) — ou, em teste, pelo override sessionFactory.
  const makeSession = (engineId: EngineId, opts: EngineSessionOptions): EngineSession =>
    deps.sessionFactory ? deps.sessionFactory(opts) : getEngine(engineId).createSession(opts)

  const persist = (localId: string, status: SessionStatus, engineSessionId: string | null) => {
    deps.db.prepare(
      `UPDATE sessions SET status=?, claude_session_id=COALESCE(?, claude_session_id), updated_at=datetime('now') WHERE local_id=?`,
    ).run(status, engineSessionId, localId)
  }

  // O id efetivo: o do processo vivo, ou — enquanto ele ainda não emitiu o
  // init (ex.: revive/--continue ficam em 'starting' até a 1ª msg) — o que já
  // está persistido no banco. Assim a UI conhece o id imediatamente e carrega
  // o histórico da conversa anterior (D4) sem esperar o operador digitar.
  const effectiveEngineSessionId = (localId: string, session: EngineSession): string | null => {
    if (session.sessionId) return session.sessionId
    const row = deps.db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any
    return row?.claude_session_id ?? null
  }

  const wire = (localId: string, projectId: number, engine: EngineId, session: EngineSession) => {
    live.set(localId, { session, projectId, engine })
    session.on('status', (status: SessionStatus) => {
      persist(localId, status, session.sessionId ?? null)
      const detail = status === 'dead'
        ? (session.lastStderr || 'O processo do agente encerrou inesperadamente.')
        : undefined
      const info = infoOf(localId)
      deps.broadcast({ type: 'session_status', localId, projectId, engine: info?.engine ?? engine, status, engineSessionId: effectiveEngineSessionId(localId, session), detail, model: info?.model ?? null, permissionMode: info?.permissionMode, effort: info?.effort ?? null })
      if (status === 'dead' || status === 'stopped') live.delete(localId)
      if (status === 'idle' || status === 'needs_attention') {
        queueMicrotask(() => deps.onSessionAvailable?.(projectId))
      }
    })
    session.on('event', (event) => {
      if (event.kind === 'init') {
        // O init carrega a lista de slash commands instalados: persiste para o
        // autocomplete do chat ficar disponível já no load (sem esperar a 1ª msg).
        if (Array.isArray(event.slashCommands) && event.slashCommands.length) {
          deps.onSlashCommands?.(event.slashCommands)
        }
        // Persiste/broadcasta o id de conversa ASSIM QUE conhecido. No Codex
        // (turn-based) o thread_id só nasce no 1º turno via thread.started e NÃO
        // dispara mudança de status — sem isto o engineSessionId só chegaria à UI
        // no fim do turno, deixando "Open in terminal" desabilitado no meio.
        if (event.sessionId) {
          persist(localId, session.status, event.sessionId)
          const infoI = infoOf(localId)
          deps.broadcast({ type: 'session_status', localId, projectId, engine: infoI?.engine ?? engine, status: session.status, engineSessionId: event.sessionId, model: infoI?.model ?? null, permissionMode: infoI?.permissionMode, effort: infoI?.effort ?? null })
        }
      }
      if (event.kind === 'result' && event.tokens) {
        deps.onEngineUsage?.(engine, event.tokens)
      }
      deps.broadcast({ type: 'session_event', localId, event })
    })
    session.start()
    const info0 = infoOf(localId)
    deps.broadcast({ type: 'session_status', localId, projectId, engine: info0?.engine ?? engine, status: session.status, engineSessionId: effectiveEngineSessionId(localId, session), model: info0?.model ?? null, permissionMode: info0?.permissionMode, effort: info0?.effort ?? null })
  }

  const infoOf = (localId: string): SessionInfo | undefined => {
    const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
    if (!row) return undefined
    const liveEntry = live.get(localId)
    return {
      localId,
      projectId: row.project_id,
      engine: (row.engine ?? DEFAULT_ENGINE_ID) as EngineId,
      status: (liveEntry?.session.status ?? row.status) as SessionStatus,
      engineSessionId: liveEntry?.session.sessionId ?? row.claude_session_id,
      updatedAt: row.updated_at,
      model: row.model ?? null,
      permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
      effort: row.effort ?? null,
    }
  }

  // Nenhum processo pode estar vivo no momento em que o manager é construído,
  // então quaisquer status ATIVOS persistidos são órfãos de uma execução anterior.
  deps.db.prepare(
    `UPDATE sessions SET status='dead', updated_at=datetime('now') WHERE status IN ('starting','idle','working','needs_attention')`,
  ).run()

  // Handoffs de terminal órfãos: o PTY da execução anterior pode
  // seguir aberto, mas o callback onExit→stopped morreu com o processo antigo.
  // Normaliza para 'stopped' para não travar o projeto (o operador pode Reviver,
  // trazendo o histórico atualizado pelo transcript — consistente com D3).
  deps.db.prepare(
    `UPDATE sessions SET status='stopped', updated_at=datetime('now') WHERE status='in_terminal'`,
  ).run()

  // Prune: mantém apenas as N sessões terminais mais recentes por projeto
  // (as demais dead/stopped são removidas do banco para não crescer sem limite).
  // Não apaga transcripts — a mais recente por projeto sempre fica (revive/histórico).
  const keep = deps.keepSessionsPerProject ?? 5
  deps.db.prepare(
    `DELETE FROM sessions
     WHERE status IN ('dead','stopped')
       AND local_id NOT IN (
         SELECT local_id FROM (
           SELECT local_id,
                  ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, local_id DESC) AS rn
           FROM sessions WHERE status IN ('dead','stopped')
         ) WHERE rn <= ?
       )`,
  ).run(keep)

  return {
    start(project: Project, opts?: { continueLatest?: boolean; permissionMode?: PermissionMode; model?: string; engine?: string }): SessionInfo {
      const engine = (opts?.engine ?? DEFAULT_ENGINE_ID) as EngineId
      for (const [id, entry] of live) {
        if (entry.projectId === project.id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new Error(`projeto ${project.name} já possui sessão ativa (${id})`)
        }
      }
      const inTerm = deps.db.prepare(
        `SELECT 1 FROM sessions WHERE project_id=? AND engine=? AND status='in_terminal' LIMIT 1`,
      ).get(project.id, engine)
      if (inTerm) throw new Error(`projeto ${project.name} tem uma sessão aberta no terminal`)
      const permissionMode = opts?.permissionMode ?? 'bypassPermissions'
      const model = opts?.model || undefined
      const localId = randomUUID()
      // Cria a sessão ANTES do INSERT: makeSession resolve a engine pelo registry
      // (lança 'unknown_engine' se não registrada). Falhar aqui não deixa linha
      // órfã no banco. O construtor é inerte — nada spawna até wire()→start().
      const session = makeSession(engine, {
        projectPath: project.path,
        continueLatest: opts?.continueLatest,
        permissionMode,
        model,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id, engine } : undefined,
      })
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, engine, status, permission_mode, model, continue_latest) VALUES (?, ?, ?, 'starting', ?, ?, ?)`,
      ).run(localId, project.id, engine, permissionMode, model ?? null, opts?.continueLatest ? 1 : 0)
      wire(localId, project.id, engine, session)
      return infoOf(localId)!
    },

    send(localId: string, text: string): void {
      const entry = live.get(localId)
      if (!entry) throw new Error(`sessão ${localId} não está ativa`)
      entry.session.send(text)
    },

    markRead(localId: string): void {
      live.get(localId)?.session.markRead()
    },

    async interrupt(localId: string): Promise<void> {
      const entry = live.get(localId)
      if (!entry) throw new Error(`sessão ${localId} não está ativa`)
      await entry.session.interrupt()
    },

    async stop(localId: string): Promise<void> {
      await live.get(localId)?.session.stop()
    },

    revive(localId: string): SessionInfo {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error(`sessão ${localId} não existe`)
      const engine = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      const cur = live.get(localId)
      const effective = cur?.session.status ?? (row.status as SessionStatus)
      if (ACTIVE.has(effective)) throw new Error(`sessão ${localId} ainda está ativa`)
      if (effective === 'in_terminal') throw new Error(`sessão ${localId} está aberta no terminal`)
      for (const [id, entry] of live) {
        if (entry.projectId === row.project_id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new Error(`projeto já possui sessão ativa (${id})`)
        }
      }
      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new Error(`projeto da sessão não existe mais`)
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: row.claude_session_id ?? undefined,
        // Sem conversa própria para retomar (--resume), preserva a intenção
        // original: sessão nascida com --continue revive continuando a última
        // conversa da pasta — não uma conversa nova em branco.
        continueLatest: row.claude_session_id ? undefined : row.continue_latest !== 0,
        permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        hermes: deps.hermes ? { ...deps.hermes, projectId: row.project_id, engine } : undefined,
      }))
      return infoOf(localId)!
    },

    async setSessionOptions(localId: string, opts: { model?: string; permissionMode?: PermissionMode; effort?: string }): Promise<SessionInfo> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error(`sessão ${localId} não existe`)
      const entry = live.get(localId)
      if (entry) {
        // Hot-swap de model/permission exige turno parado (control_request no meio
        // do turno não vale). Effort NÃO entra no guard: é no-op no Claude (aplicado
        // via mensagem /effort) e um campo p/ o PRÓXIMO turno nas engines turn-based —
        // e o próprio /effort põe a sessão em working um instante antes do PATCH.
        // Com o guard total, o effort nunca persistia: o PATCH era recusado aqui e o
        // front engolia o erro → refresh voltava ao default.
        if ((opts.model || opts.permissionMode) && entry.session.status === 'working') {
          throw new Error('sessão está trabalhando; aguarde o turno terminar')
        }
        if (opts.model) await entry.session.setModel(opts.model)
        if (opts.permissionMode) await entry.session.setPermissionMode(opts.permissionMode)
        if (opts.effort !== undefined) await entry.session.setEffort(opts.effort === 'auto' ? '' : opts.effort)
      }
      deps.db.prepare(
        `UPDATE sessions SET model = COALESCE(?, model), permission_mode = COALESCE(?, permission_mode), updated_at = datetime('now') WHERE local_id = ?`,
      ).run(opts.model ?? null, opts.permissionMode ?? null, localId)
      if (opts.effort !== undefined) {
        // 'auto' limpa (volta ao padrão do modelo); a aplicação ao processo vivo é
        // feita pelo front via mensagem /effort — aqui só persistimos p/ o relaunch
        deps.db.prepare(`UPDATE sessions SET effort = ?, updated_at = datetime('now') WHERE local_id = ?`)
          .run(opts.effort === 'auto' ? null : opts.effort, localId)
      }
      const info = infoOf(localId)!
      deps.broadcast({ type: 'session_status', localId, projectId: row.project_id, engine: info.engine, status: info.status, engineSessionId: info.engineSessionId, model: info.model, permissionMode: info.permissionMode, effort: info.effort })
      return info
    },

    async openInTerminal(localId: string): Promise<SessionInfo & { token: string }> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error('sessão não existe')
      if (row.status === 'in_terminal') throw new Error('esta sessão já está aberta no terminal')
      if (!deps.terminalLauncher) throw new Error('terminal launcher não configurado')

      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new Error('projeto da sessão não existe mais')

      // A engine resolve file/args do terminal interativo — para o Claude,
      // isso reproduz exatamente o que era montado inline antes (--resume +
      // --dangerously-skip-permissions sempre, já que toda sessão nasce com
      // essa flag, Task 1); Codex/outras engines resolvem o próprio comando.
      const engineId = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      // Id da conversa a retomar: o persistido no banco ou, se ausente (turno que não
      // chegou a gravar o id, servidor antigo, ou processo morto no meio), o último
      // thread desta pasta lido do storage da engine (rollouts do Codex / sessões do
      // Claude) — assim o terminal RETOMA a conversa em vez de abrir em branco. Sem
      // nenhum → sessão nova (fresh).
      let resumeId: string | null = row.claude_session_id ?? null
      if (!resumeId) {
        try { resumeId = getEngine(engineId).latestConversationId(project.path) } catch { resumeId = null }
      }
      // Defesa: o id vai como argv — exige começar com alfanumérico (barra flags
      // "-x") e só chars seguros.
      if (resumeId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resumeId)) {
        throw new Error('id de sessão inválido')
      }
      const { file, args } = getEngine(engineId).terminalCommand({
        resumeSessionId: resumeId,
        projectPath: project.path,
      })

      const entry = live.get(localId)
      if (entry) {
        await entry.session.stop()
        live.delete(localId)
      }

      // Persiste o id recuperado (COALESCE não sobrescreve com null): uma sessão que
      // retomou via fallback passa a conhecer o próprio thread nas próximas aberturas.
      persist(localId, 'in_terminal', resumeId)
      deps.broadcast({
        type: 'session_status',
        localId,
        projectId: row.project_id,
        engine: row.engine ?? DEFAULT_ENGINE_ID,
        status: 'in_terminal',
        engineSessionId: resumeId,
      })

      let token: string
      try {
        token = deps.terminalLauncher({
          localId,
          cwd: project.path,
          file,
          args,
          onExit: () => {
            const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
            if (cur?.status === 'in_terminal') {
              persist(localId, 'stopped', null)
              deps.broadcast({
                type: 'session_status',
                localId,
                projectId: row.project_id,
                engine: row.engine ?? DEFAULT_ENGINE_ID,
                status: 'stopped',
                engineSessionId: resumeId,
              })
            }
          },
        })
      } catch (err) {
        persist(localId, 'stopped', null)
        deps.broadcast({
          type: 'session_status',
          localId,
          projectId: row.project_id,
          engine: row.engine ?? DEFAULT_ENGINE_ID,
          status: 'stopped',
          engineSessionId: resumeId,
        })
        throw err
      }

      return { ...infoOf(localId)!, token }
    },

    list(): SessionInfo[] {
      const rows = deps.db.prepare('SELECT local_id, project_id, engine FROM sessions ORDER BY updated_at DESC').all() as any[]
      const keep = new Set<string>()
      // Dedup por (projeto, ENGINE), não por projeto: com 1 Claude + 1 Codex no mesmo
      // projeto, se ambos saem do `live` (ex.: os dois in_terminal, ou ambos stopped),
      // deduplicar por projeto some com a engine mais antiga — a aba dela vira "No
      // Session" e o ▶ tenta iniciar e falha calado (a outra engine já está in_terminal).
      const seenPerEngine = new Set<string>()
      for (const r of rows) {
        const key = `${r.project_id}:${r.engine ?? DEFAULT_ENGINE_ID}`
        if (!seenPerEngine.has(key)) { seenPerEngine.add(key); keep.add(r.local_id) }
      }
      for (const localId of live.keys()) keep.add(localId)
      return [...keep].map((id) => infoOf(id)!).filter(Boolean)
    },

    get: infoOf,

    hasActiveSession(projectId: number): boolean {
      for (const [, entry] of live) {
        if (entry.projectId === projectId && ACTIVE.has(entry.session.status)) return true
      }
      return false
    },

    /** Sessão ativa do projeto E não-working — livre para receber a próxima entrega da fila. */
    hasFreeSession(projectId: number): boolean {
      for (const [, entry] of live) {
        if (entry.projectId === projectId && ACTIVE.has(entry.session.status) && entry.session.status !== 'working') return true
      }
      return false
    },

    async stopAll(): Promise<void> {
      await Promise.all([...live.values()].map((e) => e.session.stop()))
    },

    askAgent(toProjectId: number, fromLabel: string, question: string, timeoutMs = 120_000): Promise<string> {
      let target: { session: EngineSession; projectId: number } | undefined
      for (const [, entry] of live) {
        if (entry.projectId === toProjectId && ACTIVE.has(entry.session.status)) { target = entry; break }
      }
      if (!target) return Promise.reject(new Error('target project has no active session'))
      if (target.session.status === 'working') {
        return Promise.reject(new Error('target agent is busy; try again shortly'))
      }
      const session = target.session

      return new Promise<string>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          session.removeListener('event', onEvent)
          session.removeListener('status', onStatus)
          clearTimeout(timer)
        }
        const onEvent = (evt: ClaudeEvent) => {
          if (settled || evt.kind !== 'result') return
          settled = true
          cleanup()
          resolve(evt.resultText)
        }
        const onStatus = (status: SessionStatus) => {
          if (settled || status !== 'dead') return
          settled = true
          cleanup()
          reject(new Error('target agent exited unexpectedly before responding'))
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('timed out waiting for the agent response'))
        }, timeoutMs)

        session.on('event', onEvent)
        session.on('status', onStatus)

        try {
          session.send(`[Question from agent of ${fromLabel}]: ${question}`)
        } catch (err) {
          settled = true
          cleanup()
          reject(err as Error)
        }
      })
    },

    /** Devolve a engine da sessão que recebeu a task (ou null se a entrega falhou na hora). */
    dispatchTask(
      toProjectId: number,
      fromLabel: string,
      description: string,
      onComplete: (status: 'completed' | 'failed', result: string) => void,
      timeoutMs = 600_000,
    ): EngineId | null {
      let target: { session: EngineSession; projectId: number; engine: EngineId } | undefined
      for (const [, entry] of live) {
        if (entry.projectId === toProjectId && ACTIVE.has(entry.session.status)) { target = entry; break }
      }
      if (!target) { onComplete('failed', 'target project has no active session'); return null }
      if (target.session.status === 'working') {
        onComplete('failed', 'target agent is busy'); return null
      }
      const session = target.session

      let settled = false
      const cleanup = () => {
        session.removeListener('event', onEvent)
        session.removeListener('status', onStatus)
        clearTimeout(timer)
      }
      const onEvent = (evt: ClaudeEvent) => {
        if (settled || evt.kind !== 'result') return
        settled = true
        cleanup()
        onComplete('completed', evt.resultText)
      }
      const onStatus = (status: SessionStatus) => {
        if (settled || status !== 'dead') return
        settled = true
        cleanup()
        onComplete('failed', 'target agent exited')
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        onComplete('failed', 'timed out')
      }, timeoutMs)

      session.on('event', onEvent)
      session.on('status', onStatus)

      try {
        session.send(`[Task from ${fromLabel}]: ${description}`)
      } catch (err) {
        settled = true
        cleanup()
        onComplete('failed', (err as Error).message)
        return null
      }
      return target.engine
    },
  }
}

export type SessionManager = ReturnType<typeof createSessionManager>
