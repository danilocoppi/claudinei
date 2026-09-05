import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import type { SessionStatus, PermissionMode } from './session.js'
import type { ClaudeEvent } from './events.js'
import { getEngine, DEFAULT_ENGINE_ID, type EngineId, type EngineSession, type EngineSessionOptions } from '../engine/index.js'
import { userEchoEvent } from '../engine/echo.js'
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW } from './context-window.js'

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
  /**
   * Subagentes despachados com run_in_background que ainda rodam. Vem da sessão
   * VIVA (não do banco): é estado do processo, não persistido. Ausente/vazio =
   * nada em background.
   */
  backgroundTasks?: { id: string; description: string; type: string; prompt: string }[]
  /** Credencial do Claude expirada: a UI mostra "reautenticar" no lugar do erro cru. */
  authExpired?: boolean
  /** Tamanho do contexto (tokens) do último result da sessão VIVA. Só memória: após restart do servidor, volta no próximo turno. */
  contextTokens?: number
  /** Janela de contexto (tokens) do modelo que a sessão viva está rodando — o denominador do medidor. */
  contextWindow?: number
}

export interface TerminalLauncherOpts {
  localId: string
  cwd: string
  file: string
  args: string[]
  /** Mesclado ao ambiente do PTY (ex.: KIMI_CODE_HOME do projeto). */
  env?: Record<string, string>
  onExit: () => void
  onActivity?: (activity: 'working' | 'waiting' | 'idle') => void
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
  hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string; serviceTokenFile?: string }
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
  /**
   * Limiar do auto-compact em % da janela de contexto (0/ausente = desligado),
   * lido A CADA result — mudar a configuração vale na hora, sem recriar sessão.
   * Quando o contexto reportado cruza o limiar, o manager envia `/compact` à
   * sessão (só engines cujo parser reporta contextTokens — hoje, o Claude).
   */
  autoCompactPct?: () => number
}

const ACTIVE = new Set<SessionStatus>(['starting', 'idle', 'working', 'needs_attention'])

/**
 * Espera o `result` do turno em curso da sessão. É a primitiva por trás de tudo que
 * "manda e espera a resposta" (askAgent, dispatchTask, agendamentos): a resposta de
 * um turno só existe como evento, e quem espera precisa desistir por três motivos —
 * a resposta chegou, a sessão morreu/parou, ou o tempo acabou.
 */
function waitForResult(session: EngineSession, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      session.removeListener('event', onEvent)
      session.removeListener('status', onStatus)
      clearTimeout(timer)
    }
    const onEvent = (evt: ClaudeEvent) => {
      if (settled || evt.kind !== 'result') return
      settled = true; cleanup(); resolve(evt.resultText)
    }
    const onStatus = (status: SessionStatus) => {
      // 'stopped' cobre também openInTerminal (que passa por session.stop()):
      // sem isso o waiter ficaria pendurado até o timeout com o agente já fora.
      if (settled || (status !== 'dead' && status !== 'stopped')) return
      settled = true; cleanup()
      reject(new Error(status === 'dead'
        ? 'target agent exited unexpectedly before responding'
        : 'target agent was stopped before responding'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true; cleanup()
      reject(new Error('timed out waiting for the agent response'))
    }, timeoutMs)
    session.on('event', onEvent)
    session.on('status', onStatus)
  })
}

export function createSessionManager(deps: Deps) {
  const live = new Map<string, { session: EngineSession; projectId: number; engine: EngineId; contextTokens?: number; contextWindow?: number; autoCompacting?: boolean }>()
  // Resolve a sessão pela engine (registry) — ou, em teste, pelo override sessionFactory.
  const makeSession = (engineId: EngineId, opts: EngineSessionOptions): EngineSession =>
    deps.sessionFactory ? deps.sessionFactory(opts) : getEngine(engineId).createSession(opts)

  /**
   * O id de conversa a retomar, DEPOIS de conferir que ele ainda existe.
   *
   * Um `claude_session_id` gravado cujo transcript sumiu (limpeza do ~/.claude,
   * máquina trocada) fazia `--resume` morrer com "No conversation found" — e como
   * o id vinha do banco e nunca era descartado, chat e terminal ficavam presos
   * para sempre. Aqui o fantasma é jogado fora E apagado do banco (o COALESCE do
   * persist nunca sobrescreve com null, então sem este DELETE explícito ele
   * voltaria na próxima abertura).
   */
  const resolveResume = (engineId: EngineId, projectPath: string, localId: string, candidate: string | null): string | null => {
    if (!candidate) return null
    // Formato ANTES de existência: um id malformado no banco não pode virar argv
    // ("-x flag") nem sequer tocar o disco. Rejeita em vez de descartar.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(candidate)) throw new Error('id de sessão inválido')
    const eng = getEngine(engineId)
    if (eng.conversationExists && !eng.conversationExists(projectPath, candidate)) {
      deps.db.prepare('UPDATE sessions SET claude_session_id=NULL WHERE local_id=?').run(localId)
      return null
    }
    return candidate
  }

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
      deps.broadcast({ type: 'session_status', localId, projectId, engine: info?.engine ?? engine, status, engineSessionId: effectiveEngineSessionId(localId, session), detail, model: info?.model ?? null, permissionMode: info?.permissionMode, effort: info?.effort ?? null, backgroundTasks: info?.backgroundTasks ?? [], authExpired: info?.authExpired ?? false, contextWindow: info?.contextWindow })
      if (status === 'dead' || status === 'stopped') live.delete(localId)
      if (status === 'idle' || status === 'needs_attention') {
        queueMicrotask(() => deps.onSessionAvailable?.(projectId))
      }
    })
    session.on('event', (event) => {
      if (event.kind === 'init') {
        // A janela sai do modelo que o CLI reporta aqui (o stream não anuncia o
        // tamanho). Vale para o modelo EM USO: trocar de modelo emite novo init,
        // então a janela acompanha — inclusive os 1M do Opus/Sonnet/Fable atuais.
        const entryI = live.get(localId)
        if (entryI) entryI.contextWindow = contextWindowFor(event.model)
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
          deps.broadcast({ type: 'session_status', localId, projectId, engine: infoI?.engine ?? engine, status: session.status, engineSessionId: event.sessionId, model: infoI?.model ?? null, permissionMode: infoI?.permissionMode, effort: infoI?.effort ?? null, backgroundTasks: infoI?.backgroundTasks ?? [], authExpired: infoI?.authExpired ?? false, contextWindow: infoI?.contextWindow })
        }
      }
      if (event.kind === 'result' && event.tokens) {
        // Métrica nunca derruba o processo: isto roda dentro do handler de
        // stdout da engine — um erro do SQLite aqui viraria uncaughtException.
        try { deps.onEngineUsage?.(engine, event.tokens) } catch {}
      }
      // Compactação: a conversa encolheu, mas ninguém remede o contexto aqui — o
      // result do próprio /compact vem com o usage TODO ZERADO (ordem empírica,
      // capturada da CLI: status compacting → compact_boundary → resumo → result
      // zerado). Sem invalidar na fronteira, o medidor seguiria exibindo o
      // tamanho de ANTES — justamente o valor alto que disparou a compactação —
      // até o próximo turno de verdade. A fronteira chega ANTES do result, então
      // limpar aqui não corre risco de ser sobrescrita.
      //
      // Por que não usar o post_tokens que a fronteira traz: ele conta só as
      // mensagens da conversa, sem o system prompt/ferramentas que o usage do
      // result inclui — na captura, post_tokens=2524 contra 21083 medidos no
      // turno seguinte. Exibi-lo seria trocar um número velho por um otimista.
      if (event.kind === 'system' && event.subtype === 'compact_boundary') {
        const entry = live.get(localId)
        if (entry) entry.contextTokens = undefined
      }
      if (event.kind === 'result' && typeof event.contextTokens === 'number') {
        const entry = live.get(localId)
        if (entry) {
          entry.contextTokens = event.contextTokens
          // Auto-compact: cruzou o limiar → envia /compact UMA vez por cruzamento.
          // O flag só re-arma quando um result volta abaixo do limiar (o da própria
          // compactação, tipicamente) — se compactar não reduzir o bastante, não
          // entra em loop de /compact atrás de /compact.
          const pct = deps.autoCompactPct?.() ?? 0
          const janela = entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW
          const limiar = pct > 0 ? (janela * pct) / 100 : Infinity
          if (event.contextTokens >= limiar && !entry.autoCompacting) {
            entry.autoCompacting = true
            // Microtask: deixa o status do result assentar antes de abrir o turno
            // de compactação (mesmo adiamento do onSessionAvailable, mesmo motivo).
            queueMicrotask(() => {
              if (live.get(localId) !== entry) return // sessão saiu entre o result e o envio
              try {
                entry.session.send('/compact')
                // Eco na UI: sem ele a sessão "trabalha sozinha" sem explicação.
                deps.broadcast({ type: 'session_event', localId, event: userEchoEvent('/compact') })
              } catch { /* stopped/dead no meio do caminho: nada a compactar */ }
            })
          } else if (event.contextTokens < limiar) {
            entry.autoCompacting = false
          }
        }
      }
      deps.broadcast({ type: 'session_event', localId, event })
    })
    session.start()
    const info0 = infoOf(localId)
    deps.broadcast({ type: 'session_status', localId, projectId, engine: info0?.engine ?? engine, status: session.status, engineSessionId: effectiveEngineSessionId(localId, session), model: info0?.model ?? null, permissionMode: info0?.permissionMode, effort: info0?.effort ?? null, backgroundTasks: info0?.backgroundTasks ?? [], authExpired: info0?.authExpired ?? false, contextWindow: info0?.contextWindow })
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
      backgroundTasks: liveEntry?.session.backgroundTasks ?? [],
      authExpired: liveEntry?.session.authExpired ?? false,
      contextTokens: liveEntry?.contextTokens,
      contextWindow: liveEntry?.contextWindow,
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
    start(project: Project, opts?: { continueLatest?: boolean; permissionMode?: PermissionMode; model?: string; engine?: string; effort?: string }): SessionInfo {
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
        effort: opts?.effort,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id, engine } : undefined,
      })
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, engine, status, permission_mode, model, continue_latest, effort) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?)`,
      ).run(localId, project.id, engine, permissionMode, model ?? null, opts?.continueLatest ? 1 : 0, opts?.effort ?? null)
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

    /**
     * Para UM subagente de background sem tocar no resto da sessão. Só o Claude
     * Code tem esse conceito; nas outras engines o método não existe e a chamada
     * vira no-op.
     */
    /** Inicia o fluxo OAuth de reautenticação da sessão (só Claude). */
    async startAuth(localId: string): Promise<{ manualUrl: string; automaticUrl: string }> {
      const session = live.get(localId)?.session
      if (!session?.startAuth) throw new Error('esta engine não suporta reautenticação')
      return session.startAuth()
    },

    /** Fecha o fluxo com o código/URL que o operador trouxe do navegador. */
    async completeAuth(localId: string, codeOrUrl: string): Promise<void> {
      const session = live.get(localId)?.session
      if (!session?.completeAuth) throw new Error('esta engine não suporta reautenticação')
      await session.completeAuth(codeOrUrl)
    },

    async stopBackgroundTask(localId: string, taskId: string): Promise<void> {
      const session = live.get(localId)?.session as { stopTask?: (id: string) => Promise<void> } | undefined
      await session?.stopTask?.(taskId)
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
      // Fantasma (transcript sumiu) é descartado aqui também: sem isto, reviver o
      // chat caía no mesmo "No conversation found" do terminal.
      const reviveResume = resolveResume(engine, project.path, localId, row.claude_session_id ?? null)
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: reviveResume ?? undefined,
        // Sem conversa própria para retomar (--resume), preserva a intenção
        // original: sessão nascida com --continue revive continuando a última
        // conversa da pasta — não uma conversa nova em branco.
        continueLatest: reviveResume ? undefined : row.continue_latest !== 0,
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
        // model !== undefined inclui '' (voltar ao Padrão): as engines turn-based
        // tratam '' como "sem -m no próximo turno"; no Claude o protocolo não tem
        // reset, então o setModel('') é no-op no processo vivo (vale no relaunch).
        if (opts.model !== undefined) await entry.session.setModel(opts.model)
        if (opts.permissionMode) await entry.session.setPermissionMode(opts.permissionMode)
        if (opts.effort !== undefined) await entry.session.setEffort(opts.effort === 'auto' ? '' : opts.effort)
      }
      // '' = limpar (Padrão): COALESCE não distingue "limpar" de "não tocar",
      // então o model tem update próprio com NULLIF.
      if (opts.model !== undefined) {
        deps.db.prepare(`UPDATE sessions SET model = NULLIF(?, ''), updated_at = datetime('now') WHERE local_id = ?`).run(opts.model, localId)
      }
      deps.db.prepare(
        `UPDATE sessions SET permission_mode = COALESCE(?, permission_mode), updated_at = datetime('now') WHERE local_id = ?`,
      ).run(opts.permissionMode ?? null, localId)
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
      // Descarta um id cujo transcript não existe mais (senão --resume morre); só
      // então cai para o último thread real da pasta, ou fresh.
      let resumeId: string | null = resolveResume(engineId, project.path, localId, row.claude_session_id ?? null)
      if (!resumeId) {
        try { resumeId = getEngine(engineId).latestConversationId(project.path) } catch { resumeId = null }
      }
      // Defesa: o id vai como argv — exige começar com alfanumérico (barra flags
      // "-x") e só chars seguros.
      if (resumeId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resumeId)) {
        throw new Error('id de sessão inválido')
      }
      const { file, args, env } = getEngine(engineId).terminalCommand({
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
          env,
          // Heurística de atividade do TUI: broadcast efêmero (não persiste) — a
          // sidebar mostra "no terminal · processando/esperando você" ao vivo.
          onActivity: (activity) => {
            const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
            if (cur?.status !== 'in_terminal') return
            deps.broadcast({ type: 'terminal_activity', localId, projectId: row.project_id, activity })
          },
          onExit: () => {
            const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
            if (cur?.status === 'in_terminal') {
              // O TUI (claude --resume / codex resume) grava a conversa num
              // transcript NOVO — o id de antes do terminal ficou velho e o chat
              // web voltaria sem o que aconteceu lá. Re-resolve o último thread
              // da pasta e persiste: o histórico do chat passa a refletir o
              // terminal assim que a UI recarrega pela troca de engineSessionId.
              let latest: string | null = null
              try { latest = getEngine(engineId).latestConversationId(project.path) } catch { latest = null }
              const nextId = latest ?? resumeId
              persist(localId, 'stopped', nextId)
              deps.broadcast({
                type: 'session_status',
                localId,
                projectId: row.project_id,
                engine: row.engine ?? DEFAULT_ENGINE_ID,
                status: 'stopped',
                engineSessionId: nextId,
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
      let anyActive = false
      for (const [, entry] of live) {
        if (entry.projectId !== toProjectId || !ACTIVE.has(entry.session.status)) continue
        anyActive = true
        // Pula sessões ocupadas: com 2 engines no mesmo projeto (uma working,
        // outra idle), a entrega vai para a livre — não falha com "busy".
        if (entry.session.status !== 'working') { target = entry; break }
      }
      if (!target) {
        return Promise.reject(new Error(anyActive
          ? 'target agent is busy; try again shortly'
          : 'target project has no active session'))
      }
      const session = target.session

      const waited = waitForResult(session, timeoutMs)
      try {
        session.send(`[Question from agent of ${fromLabel}]: ${question}`)
      } catch (err) {
        return Promise.reject(err as Error)
      }
      return waited
    },

    /**
     * Manda um texto para UMA sessão específica e, opcionalmente, espera a resposta
     * final do turno. É o que o agendador usa: ele sabe exatamente em qual sessão
     * quer falar (a engine está no agendamento), então não serve a escolha
     * automática de alvo que o askAgent faz.
     */
    sendAndWait(localId: string, text: string, opts?: { timeoutMs?: number; wait?: boolean }): Promise<string | null> {
      const entry = live.get(localId)
      if (!entry) return Promise.reject(new Error(`sessão ${localId} não está ativa`))
      const waited = opts?.wait === false ? null : waitForResult(entry.session, opts?.timeoutMs ?? 1_800_000)
      try {
        entry.session.send(text, { echoToClients: true })
      } catch (err) {
        return Promise.reject(err as Error)
      }
      return waited ?? Promise.resolve(null)
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
      let anyActive = false
      for (const [, entry] of live) {
        if (entry.projectId !== toProjectId || !ACTIVE.has(entry.session.status)) continue
        anyActive = true
        if (entry.session.status !== 'working') { target = entry; break }
      }
      if (!target) {
        onComplete('failed', anyActive ? 'target agent is busy' : 'target project has no active session')
        return null
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
        if (settled || (status !== 'dead' && status !== 'stopped')) return
        settled = true
        cleanup()
        onComplete('failed', status === 'dead' ? 'target agent exited' : 'target agent was stopped')
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
        // echoToClients: a UI não tem como saber desta mensagem sozinha (o CLI não
        // ecoa e ninguém a inseriu localmente) — sem isso a task só aparecia no
        // chat do terminal-alvo depois de um refresh.
        session.send(`[Task from ${fromLabel}]: ${description}`, { echoToClients: true })
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
