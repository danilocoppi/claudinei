import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Db } from '../db.js'
import type { SessionStatus } from '../claude/session.js'
import { getEngine, type AgentEvent, type EngineSession, type EngineSessionOptions } from '../engine/index.js'
import type { ForkFrom } from '../engine/types.js'
import { userEchoEvent } from '../engine/echo.js'
import { UserError } from '../user-error.js'
import { cutFor, type ExecLike } from './cut.js'
import { collectHandoff, withRequest } from './handoff.js'
import { kimiSideHome } from './engine-args.js'
import {
  cleanupSideTrace, isTerminalConversationId, listSideThreads, recordSideThread, removeSideThread, setSideThreadId,
} from './side-threads.js'

/**
 * Conversa lateral (`/side`, `/btw`): uma cópia descartável e só leitura da
 * conversa principal, que roda ao lado dela. Mora num registro em memória à
 * parte do manager: não tem linha em `sessions` nem em `project_threads`, não
 * entra no `live`, no árbitro do próximo envio, no limite, no reinício nem nas
 * notificações. Uma por terminal+motor.
 */

/** Teto dos eventos guardados em memória por lateral (sem os `stream`). */
export const SIDE_EVENTS_MAX_BYTES = 2 * 1024 * 1024

/** Quanto a lateral pode mexer nos arquivos da pasta, por motor (o aviso da coluna). */
export type SideFiles = 'read_only' | 'no_edit_tools' | 'can_write'

export interface SideInfo {
  id: string
  projectId: number
  engine: string
  status: SessionStatus
  /** `native`: a CLI copiou a conversa; `seed`: o pacote de contexto vai na primeira mensagem. */
  mode: 'native' | 'seed'
  /** ISO do corte ("cópia até HH:MM"); null quando o motor não diz. */
  cutAt: string | null
  files: SideFiles
  /** A última pergunta do operador na lateral. */
  question: string | null
  openedAt: string
}

/** A sessão principal do terminal, como a lateral a enxerga. */
export interface SideMain {
  localId: string
  status: SessionStatus
  engineSessionId: string | null
  model: string | null
  effort: string | null
  turnStartedAt?: number
}

export interface SideService {
  open(projectId: number, engine: string, question: string | null, opts?: { replace?: boolean }): Promise<SideInfo>
  send(projectId: number, engine: string, text: string): void
  interrupt(projectId: number, engine: string): Promise<void>
  close(projectId: number, engine: string, opts?: { shutdown?: boolean }): Promise<void>
  snapshot(projectId: number, engine: string): { side: SideInfo; events: AgentEvent[] } | null
  onSessionEnded(projectId: number, engine: string): void
  bootCleanup(): Promise<void>
  dispose(): Promise<void>
}

const FILES: Record<string, SideFiles> = { codex: 'read_only', claude: 'no_edit_tools', opencode: 'no_edit_tools' }
/** Motor desconhecido não promete nada: "pode alterar arquivos", como o Kimi. */
const filesOf = (engine: string): SideFiles => FILES[engine] ?? 'can_write'

/** Id de conversa aceito em `side_threads` (vira argv na limpeza do OpenCode). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

interface Side {
  key: string
  info: SideInfo
  projectPath: string
  sourceId: string
  /** `before` do pacote da cópia recusada: o corte fechado. */
  previewBefore: number | null
  /** Opções da sessão, sem o `forkFrom` (a recriação em `seed` usa as mesmas). */
  base: EngineSessionOptions
  /** Id da conversa da lateral no storage do motor (o que a limpeza apaga). */
  threadId: string | null
  session?: EngineSession
  /** Pacote que vai grudado na próxima mensagem do operador (modo `seed` aberto sem pergunta). */
  seed: string | null
  /** O que o operador mandou por último: a cópia recusada o reenvia. */
  lastRequest: string | null
  sawInit: boolean
  /** A recriação em `seed` depois da cópia recusada já aconteceu (uma vez só). */
  retried: boolean
  opening: boolean
  closed: boolean
  closing?: Promise<void>
  events: AgentEvent[]
  sizes: number[]
  bytes: number
  /** Eventos emitidos de dentro do `send` síncrono: saem depois do eco da mensagem. */
  holding?: AgentEvent[]
}

export function createSideService(deps: {
  db: Db
  broadcast: (m: object) => void
  main: (projectId: number, engine: string) => SideMain | null
  projectPath: (projectId: number) => string | null
  makeSession?: (engine: string, opts: EngineSessionOptions) => EngineSession // testes
  cutFor?: typeof cutFor // testes
  collect?: typeof collectHandoff // testes
  cleanup?: { claudeConfigDir?: string; run?: ExecLike } // testes
}): SideService {
  const sides = new Map<string, Side>()
  const keyOf = (projectId: number, engine: string) => `${projectId}:${engine}`
  const makeSession = deps.makeSession ?? ((engine, opts) => getEngine(engine).createSession(opts))
  const cutFn = deps.cutFor ?? cutFor
  const collect = deps.collect ?? collectHandoff
  // A limpeza nunca apaga um id que seja conversa de algum terminal.
  const cleanupDeps = { ...deps.cleanup, isProtected: (id: string) => isTerminalConversationId(deps.db, id) }

  const noConversation = () => new UserError('no_conversation', 'Ainda não há conversa para copiar')
  const notFound = () => new UserError('side_not_found', 'não há conversa lateral aberta neste terminal')

  const publish = (side: Side) => {
    deps.broadcast({ type: 'side_state', projectId: side.info.projectId, engine: side.info.engine, side: { ...side.info } })
  }
  const publishNull = (projectId: number, engine: string) => {
    deps.broadcast({ type: 'side_state', projectId, engine, side: null })
  }

  /** Publica e guarda o evento (os `stream` só passam), descartando os mais antigos acima do teto. */
  const pushEvent = (side: Side, event: AgentEvent) => {
    deps.broadcast({ type: 'side_event', projectId: side.info.projectId, engine: side.info.engine, sideId: side.info.id, event })
    if (event.kind === 'stream') return
    let size: number
    try { size = Buffer.byteLength(JSON.stringify(event), 'utf8') } catch { return }
    side.events.push(event)
    side.sizes.push(size)
    side.bytes += size
    while (side.bytes > SIDE_EVENTS_MAX_BYTES && side.events.length > 0) {
      side.events.shift()
      side.bytes -= side.sizes.shift()!
    }
  }

  const errorEvent = (text: string): AgentEvent =>
    ({ kind: 'result', subtype: 'error', isError: true, resultText: text, costUsd: 0, raw: {} }) as AgentEvent

  /** Manda o texto do operador (com o pacote, se ainda pendente) e mostra só o texto dele. */
  const deliver = (side: Side, text: string, o: { echo: boolean }) => {
    const session = side.session
    if (!session) throw notFound()
    const payload = side.seed !== null ? withRequest(side.seed, text) : text
    side.holding = []
    try {
      session.send(payload)
    } catch (err) {
      const held = side.holding
      side.holding = undefined
      for (const e of held) pushEvent(side, e)
      throw err
    }
    const held = side.holding
    side.holding = undefined
    side.seed = null
    side.lastRequest = text
    side.info.question = text
    if (o.echo) pushEvent(side, userEchoEvent(text))
    for (const e of held) pushEvent(side, e)
  }

  /** O motor anuncia o id da lateral só no init: o OpenCode grava a conversa no storage dele. */
  const tracksThreadId = (side: Side) => side.info.engine === 'opencode'

  const launch = (side: Side, opts: EngineSessionOptions) => {
    const session = makeSession(side.info.engine, opts)
    side.session = session
    side.sawInit = false
    session.on('event', (event: AgentEvent) => {
      if (side.session !== session || side.closed) return
      if (event.kind === 'init') {
        side.sawInit = true
        const tid = event.sessionId
        // SEGURANÇA: o id da principal nunca vira o da lateral (o fechamento o
        // apagaria). O `run --fork` pode anunciar primeiro o da origem.
        if (tracksThreadId(side) && typeof tid === 'string' && SAFE_ID.test(tid) && tid !== side.threadId
          && tid !== side.sourceId) {
          side.threadId = tid
          setSideThreadId(deps.db, side.info.id, tid)
        }
      }
      if (side.holding) { side.holding.push(event); return }
      pushEvent(side, event)
    })
    session.on('status', (status: SessionStatus) => {
      if (side.session !== session || side.closed) return
      // Cópia nativa recusada: a sessão morreu antes do init (o Claude com
      // `--resume-session-at` inválido, o OpenCode). Recria uma vez em `seed`,
      // com o pacote até o corte, e reenvia a pergunta. O Codex não: sem o fork
      // efêmero ele abriria conversa persistente na pasta, que vazaria para a
      // principal; morre com o erro na coluna.
      if (status === 'dead' && !side.sawInit && side.info.mode === 'native' && !side.retried
        && side.info.engine !== 'codex') {
        void retryAsSeed(side).catch((err) => console.error(`[lateral] falha ao recriar ${side.info.id} em seed`, err))
        return
      }
      // A lateral não tem "não lida": o fim de turno volta a ociosa.
      side.info.status = status === 'needs_attention' ? 'idle' : status
      if (status === 'dead') pushEvent(side, errorEvent(session.lastStderr || 'O processo do agente encerrou inesperadamente.'))
      publish(side)
    })
    session.start()
    side.info.status = session.status
  }

  const retryAsSeed = async (side: Side) => {
    side.retried = true
    side.info.mode = 'seed'
    side.info.status = 'starting'
    publish(side)
    let seed: string | null = null
    try {
      // O `before` já é o corte fechado: nunca junto com `working`.
      const h = await collect(getEngine(side.info.engine), side.projectPath, side.sourceId,
        { working: false, ...(side.previewBefore != null ? { before: side.previewBefore } : {}) })
      seed = h?.text ?? null
    } catch (err) {
      console.error(`[lateral] falha ao montar o pacote de ${side.info.id}`, err)
    }
    if (side.closed) return
    // Sem pacote, a pergunta sai sozinha.
    side.seed = seed
    try {
      launch(side, side.base)
    } catch (err) {
      side.info.status = 'dead'
      pushEvent(side, errorEvent(err instanceof Error ? err.message : String(err)))
      publish(side)
      return
    }
    publish(side)
    if (side.lastRequest !== null) {
      try {
        deliver(side, side.lastRequest, { echo: false })
      } catch (err) {
        pushEvent(side, errorEvent(err instanceof Error ? err.message : String(err)))
      }
    }
  }

  /** Para a sessão e, fora do encerramento do serviço, limpa os rastros e a anotação. */
  const closeSide = (side: Side, opts: { shutdown?: boolean } = {}): Promise<void> => {
    if (side.closing) return side.closing
    side.closed = true
    const owned = sides.get(side.key) === side
    if (owned) sides.delete(side.key)
    if (owned && !opts.shutdown) publishNull(side.info.projectId, side.info.engine)
    side.closing = (async () => {
      try { await side.session?.stop() } catch (err) { console.error(`[lateral] falha ao parar ${side.info.id}`, err) }
      // No encerramento só o processo para: a subida seguinte limpa pelo side_threads.
      if (opts.shutdown) return
      await cleanupSideTrace({ id: side.info.id, engine: side.info.engine, threadId: side.threadId }, cleanupDeps)
      removeSideThread(deps.db, side.info.id)
    })()
    return side.closing
  }

  const current = (projectId: number, engine: string): Side => {
    const side = sides.get(keyOf(projectId, engine))
    if (!side || side.opening) throw notFound()
    return side
  }

  return {
    async open(projectId, engine, question, opts) {
      const key = keyOf(projectId, engine)
      const old = sides.get(key)
      // A reserva é síncrona, antes de qualquer await: dois `/side` ao mesmo
      // tempo (dois navegadores, clique duplo) abrem um só. Uma abertura ainda
      // em curso não é substituída.
      if (old && (!opts?.replace || old.opening)) {
        throw new UserError('side_exists', 'já existe uma conversa lateral aberta neste terminal')
      }
      // A principal recusa (volta da conversa pendente, sem conversa) ANTES de
      // mexer nas laterais: com `replace`, a antiga continua aberta e a coluna
      // não some. A chamada de baixo, depois de fechar a antiga, lê o estado fresco.
      const antes = deps.main(projectId, engine)
      if (!antes?.engineSessionId || !deps.projectPath(projectId)) throw noConversation()
      const q = question?.trim() ? question : null
      const id = randomUUID()
      const side: Side = {
        key,
        info: { id, projectId, engine, status: 'starting', mode: 'native', cutAt: null, files: filesOf(engine), question: q, openedAt: new Date().toISOString() },
        projectPath: '', sourceId: '', previewBefore: null, base: { projectPath: '' }, threadId: null,
        seed: null, lastRequest: null, sawInit: false, retried: false, opening: true, closed: false,
        events: [], sizes: [], bytes: 0,
      }
      sides.set(key, side)
      const vivo = () => { if (side.closed) throw notFound() }
      try {
        if (old) await closeSide(old)
        vivo()
        const main = deps.main(projectId, engine)
        if (!main?.engineSessionId) throw noConversation()
        const projectPath = deps.projectPath(projectId)
        if (!projectPath) throw noConversation()
        side.projectPath = projectPath
        side.sourceId = main.engineSessionId
        const working = main.status === 'working'

        // O modo: cópia nativa até o último turno fechado, ou o pacote.
        let forkFrom: ForkFrom | undefined
        let seed: string | null = null
        const native = engine === 'claude' || engine === 'codex' || (engine === 'opencode' && !working)
        if (native) {
          const cut = await cutFn(engine, projectPath, side.sourceId, { working, turnStartedAt: main.turnStartedAt })
          vivo()
          // Nada fechado para copiar (primeiro turno em curso, conversa vazia, export que falhou).
          if (!cut?.cut) throw noConversation()
          side.info.cutAt = cut.at
          side.previewBefore = cut.previewBefore
          // Claude: `--resume-session-at` só no meio do turno; ociosa, copia a conversa
          // toda. Codex: o `lastTurnId` é sempre o último turno fechado. OpenCode:
          // o `--fork` não tem corte (ocioso, copia tudo).
          const comCorte = engine === 'codex' || (engine === 'claude' && working)
          forkFrom = { sourceId: side.sourceId, ...(comCorte ? { cut: cut.cut } : {}) }
        } else {
          // O OpenCode trabalhando e o Kimi: o pacote, sem o turno em andamento.
          const h = await collect(getEngine(engine), projectPath, side.sourceId, { working })
          vivo()
          if (!h) throw noConversation()
          seed = h.text
          side.info.mode = 'seed'
        }

        // Sem hermes e sem permissionMode: o `set_permission_mode` pós-init
        // tiraria o Claude do modo plano.
        side.base = {
          projectPath,
          ...(main.model ? { model: main.model } : {}),
          ...(main.effort ? { effort: main.effort } : {}),
          readOnly: true,
          ephemeral: true,
          ...(engine === 'claude' ? { sessionId: randomUUID() } : {}),
          ...(engine === 'kimi' ? { dataRoot: kimiSideHome(id) } : {}),
        }
        // A limpeza só apaga caminho absoluto: um data root relativo ficaria para trás.
        if (side.base.dataRoot !== undefined && !isAbsolute(side.base.dataRoot)) {
          throw new Error(`data root da lateral não é absoluto: ${JSON.stringify(side.base.dataRoot)}`)
        }
        // O que fica no disco é anotado ANTES de a sessão nascer: uma queda no
        // meio deixa a anotação para a subida limpar.
        if (engine === 'claude') side.threadId = side.base.sessionId!
        if (engine === 'claude' || engine === 'opencode' || engine === 'kimi') {
          recordSideThread(deps.db, { id, projectId, engine, threadId: side.threadId })
        }
        side.seed = seed
        launch(side, { ...side.base, ...(forkFrom ? { forkFrom } : {}) })
        side.opening = false
        publish(side)
        // Com pergunta: no nativo, ela; no `seed`, o pacote e ela num envio só.
        // Sem pergunta, o pacote espera a primeira mensagem.
        if (q !== null) deliver(side, q, { echo: true })
        return { ...side.info }
      } catch (err) {
        // Para o que chegou a nascer e limpa a anotação. A chave volta a ficar
        // livre, e a coluna some (com `replace`, a antiga já foi fechada).
        side.opening = false
        await closeSide(side)
        throw err
      }
    },

    send(projectId, engine, text) {
      const side = current(projectId, engine)
      deliver(side, text, { echo: true })
    },

    async interrupt(projectId, engine) {
      const side = current(projectId, engine)
      await side.session?.interrupt()
    },

    async close(projectId, engine, opts) {
      const side = sides.get(keyOf(projectId, engine))
      if (!side) return
      await closeSide(side, opts)
    },

    snapshot(projectId, engine) {
      const side = sides.get(keyOf(projectId, engine))
      if (!side || side.opening) return null
      return { side: { ...side.info }, events: [...side.events] }
    },

    onSessionEnded(projectId, engine) {
      const side = sides.get(keyOf(projectId, engine))
      if (!side) return
      void closeSide(side).catch((err) => console.error(`[lateral] falha ao fechar ${side.info.id}`, err))
    },

    async bootCleanup() {
      const abertas = new Set([...sides.values()].map((s) => s.info.id))
      for (const row of listSideThreads(deps.db)) {
        if (abertas.has(row.id)) continue
        await cleanupSideTrace(row, cleanupDeps)
        removeSideThread(deps.db, row.id)
      }
    },

    async dispose() {
      await Promise.all([...sides.values()].map((s) => closeSide(s, { shutdown: true })))
    },
  }
}
