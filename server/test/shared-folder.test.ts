import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { registerEngine, __resetRegistry } from '../src/engine/registry.js'
import type { Engine, EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { ownLatestThread } from '../src/project-threads.js'

/**
 * Dois terminais na mesma pasta.
 *
 * O storage de conversa das engines é indexado por PASTA, então tudo aqui gira
 * em torno de uma pergunta: quando o Claudinei pergunta "qual é a última
 * conversa desta pasta", ele aceita uma resposta que não é dele?
 */

/** Storage falso da engine: ids em ordem de uso, o mais recente por último. */
let storage: string[] = []
let abertas: EngineSessionOptions[] = []

/** Sessão inerte: o manager só precisa de status, sessionId e os dois eventos. */
class StubSession extends EventEmitter {
  status = 'starting' as any
  sessionId: string | undefined
  lastStderr = ''
  constructor(public opts: EngineSessionOptions) {
    super()
    // Espelha o Codex, que já conhece o id ao retomar (o Claude só no init).
    this.sessionId = opts.resumeSessionId
  }
  start(): void { this.status = 'idle'; this.emit('status', 'idle') }
  send(): void {}
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.status = 'stopped'; this.emit('status', 'stopped') }
}

const fakeEngine: Engine = {
  id: 'fake' as any,
  bin: () => 'fake',
  createSession: (opts) => { abertas.push(opts); return new StubSession(opts) as unknown as EngineSession },
  readHistory: () => [],
  latestConversationId: (_p, exclude) => [...storage].reverse().find((id) => !exclude?.has(id)) ?? null,
  terminalCommand: (o) => ({ file: 'fake', args: o.resumeSessionId ? ['resume', o.resumeSessionId] : [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none', label: 'Fake', icon: '?', slashCommands: [] }),
}

let db: Db
let pasta: string
let a: any
let b: any
let sozinho: any
let exits: Array<() => void>

beforeEach(() => {
  __resetRegistry()
  registerEngine(fakeEngine)
  storage = []
  abertas = []
  exits = []
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  pasta = mkdtempSync(join(tmpdir(), 'juntos-'))
  a = projects.create({ name: 'A', path: pasta })
  b = projects.create({ name: 'B', path: pasta })
  sozinho = projects.create({ name: 'Só', path: mkdtempSync(join(tmpdir(), 'sozinho-')) })
})

afterEach(() => { __resetRegistry() })

const makeManager = () => createSessionManager({
  db,
  broadcast: () => {},
  terminalLauncher: (o) => { exits.push(o.onExit); return 'tok' },
})

const idNoBanco = (localId: string) =>
  (db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any)?.claude_session_id ?? null

describe('duas entradas na mesma pasta', () => {
  it('o id que a sessão grava passa a ser posse do projeto', async () => {
    const mgr = makeManager()
    const s = mgr.start(a, { engine: 'fake' })
    // A engine anuncia o id como o Codex faz: pelo status, via persist.
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(s.localId)
    await mgr.openInTerminal(s.localId)
    expect(ownLatestThread(db, a.id, 'fake')).toBe('conv-a')
  })

  it('openInTerminal não retoma a conversa do vizinho', async () => {
    const mgr = makeManager()
    // O vizinho conversou: o id dele é o mais recente DA PASTA.
    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-do-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-do-b')

    // A nunca conversou: sem conversa própria, tem que abrir NOVA.
    const sa = mgr.start(a, { engine: 'fake' })
    await mgr.openInTerminal(sa.localId)
    expect(idNoBanco(sa.localId)).toBeNull()
  })

  it('onExit não grava no meu terminal o id do vizinho', async () => {
    const mgr = makeManager()
    const sa = mgr.start(a, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(sa.localId)
    await mgr.openInTerminal(sa.localId)
    storage.push('conv-a')

    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-b')

    // O terminal de A fecha DEPOIS de B ter conversado: a última conversa da
    // pasta é a de B, e é exatamente o que não pode entrar na linha de A.
    exits[0]()
    expect(idNoBanco(sa.localId)).toBe('conv-a')
  })

  it('sem conversa própria, onExit não inventa uma: preserva o que tinha (nada)', async () => {
    const mgr = makeManager()
    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-b')

    const sa = mgr.start(a, { engine: 'fake' })
    await mgr.openInTerminal(sa.localId)
    exits[1]()
    expect(idNoBanco(sa.localId)).toBeNull()
  })
})

describe('regressão: pasta com um terminal só', () => {
  it('openInTerminal ainda cai na última conversa da pasta quando não tem id', async () => {
    const mgr = makeManager()
    storage.push('conv-que-estava-la')
    const s = mgr.start(sozinho, { engine: 'fake' })
    await mgr.openInTerminal(s.localId)
    expect(idNoBanco(s.localId)).toBe('conv-que-estava-la')
  })

  it('onExit ainda adota o thread novo que o TUI criou', async () => {
    const mgr = makeManager()
    const s = mgr.start(sozinho, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-velha' WHERE local_id=?`).run(s.localId)
    await mgr.openInTerminal(s.localId)
    // O TUI grava num transcript NOVO: é o que o chat web precisa passar a ler.
    storage.push('conv-do-tui')
    exits[0]()
    expect(idNoBanco(s.localId)).toBe('conv-do-tui')
  })
})
