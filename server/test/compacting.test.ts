import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions, type SessionStatus } from '../src/claude/session.js'
import { createSessionManager } from '../src/claude/manager.js'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')

const open = () =>
  new ClaudeSession({
    projectPath: mkdtempSync(join(tmpdir(), 'compact-')),
    claudeBin: process.execPath,
    extraArgsOverride: [FAKE_CLAUDE],
  } as SessionOptions)

let session: ClaudeSession | undefined
afterEach(async () => { await session?.stop(); session = undefined })

const feed = (s: ClaudeSession, obj: object) =>
  (s as unknown as { handleEvent: (e: unknown) => void }).handleEvent(obj)

/** `system/status` como a CLI 2.1.261 emite no stream-json: `compacting` ao começar, `null` ao terminar. */
const statusEvt = (status: string | null, extra: object = {}) =>
  ({ kind: 'system', subtype: 'status', raw: { type: 'system', subtype: 'status', status, ...extra } })
const boundary = () =>
  ({ kind: 'system', subtype: 'compact_boundary', raw: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 143838 } } })
const result = () => ({ kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} })

const ready = () => {
  const s = open()
  s.start()
  feed(s, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
  feed(s, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })
  return s
}

describe('compactação em curso (system/status compacting)', () => {
  it('status compacting marca compactingSince e avisa uma vez: o batimento de 30s não repete o aviso', () => {
    session = ready()
    const emitted: SessionStatus[] = []
    session.on('status', (st) => emitted.push(st))
    const before = Date.now()
    feed(session, statusEvt('compacting'))
    feed(session, statusEvt('compacting'))
    expect(session.compactingSince).toBeGreaterThanOrEqual(before)
    expect(emitted).toEqual(['working'])
  })

  it('sem compactação, compactingSince é ausente', () => {
    session = ready()
    expect(session.compactingSince).toBeUndefined()
  })

  it('status null encerra a compactação e avisa de novo', () => {
    session = ready()
    feed(session, statusEvt('compacting'))
    const emitted: SessionStatus[] = []
    session.on('status', (st) => emitted.push(st))
    feed(session, statusEvt(null, { compact_result: 'success' }))
    expect(session.compactingSince).toBeUndefined()
    expect(emitted).toEqual(['working'])
  })

  it('status "requesting" no meio NÃO encerra: a própria chamada do resumo passa por ele', () => {
    session = ready()
    feed(session, statusEvt('compacting'))
    feed(session, statusEvt('requesting'))
    expect(session.compactingSince).toBeDefined()
  })

  it('compact_boundary encerra (rede para uma CLI que não mande o null)', () => {
    session = ready()
    feed(session, statusEvt('compacting'))
    feed(session, boundary())
    expect(session.compactingSince).toBeUndefined()
  })

  it('result encerra (o turno fechou, compactando ou não)', () => {
    session = ready()
    feed(session, statusEvt('compacting'))
    feed(session, result())
    expect(session.compactingSince).toBeUndefined()
  })

  it('encerrar sem estar compactando não emite status à toa', () => {
    session = ready()
    const emitted: SessionStatus[] = []
    session.on('status', (st) => emitted.push(st))
    feed(session, statusEvt(null))
    feed(session, boundary())
    expect(emitted).toEqual([])
  })
})

describe('compactingSince chega aos clientes', () => {
  let db: Db
  let project: Project
  let broadcasts: any[]
  let last: ClaudeSession | undefined

  beforeEach(() => {
    db = openDb(':memory:')
    project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
    broadcasts = []
    last = undefined
  })

  const factory = (opts: SessionOptions) => {
    last = new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE_CLAUDE] })
    return last
  }
  const waitUntil = async (cond: () => boolean, ms = 5000) => {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout esperando condição')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const statusesOf = (localId: string) => broadcasts.filter((b) => b.type === 'session_status' && b.localId === localId)

  it('session_status e list() carregam compactingSince enquanto compacta, e o largam ao terminar', async () => {
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    feed(last!, statusEvt('compacting'))
    expect(typeof statusesOf(info.localId).at(-1).compactingSince).toBe('number')
    expect(typeof mgr.list().find((s) => s.localId === info.localId)?.compactingSince).toBe('number')
    feed(last!, statusEvt(null, { compact_result: 'success' }))
    expect(statusesOf(info.localId).at(-1).compactingSince).toBeUndefined()
    expect(mgr.get(info.localId)?.compactingSince).toBeUndefined()
    await mgr.stop(info.localId)
  })
})
