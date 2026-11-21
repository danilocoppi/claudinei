import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import type { SessionStatus } from '../src/claude/session.js'
import type { EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { forkPlanOf, parseForkSource, type ForkSource } from '../src/branch/fork-source.js'
import '../src/engine/index.js'

/** Sessão falsa: grava a hora da escrita da mensagem e deixa o teste mandar no status. */
class FakeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  lastStderr = ''
  writes: Array<{ text: string; at: number }> = []
  /** Atraso (ms, espera ocupada) entre a escrita e a troca de status, como o handler de eco faz no real. */
  delayAfterWrite = 0
  constructor(readonly opts: EngineSessionOptions) { super() }
  set(s: SessionStatus) { if (this.status !== s) { this.status = s; this.emit('status', s) } }
  start(): void { this.set('idle') }
  send(text: string): void {
    this.writes.push({ text, at: Date.now() })
    const fim = Date.now() + this.delayAfterWrite
    while (Date.now() < fim) { /* espera ocupada: o relógio anda entre a escrita e o status */ }
    this.set('working')
  }
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.set('stopped') }
}

let db: Db
let project: Project
let created: FakeSession[]
let ended: Array<[number, string, string]>

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'branch-mgr-')) })
  created = []
  ended = []
})

afterEach(() => { rmSync(project.path, { recursive: true, force: true }) })

function makeManager() {
  return createSessionManager({
    db,
    broadcast: () => {},
    sessionFactory: (opts) => { const s = new FakeSession(opts); created.push(s); return s },
    onSessionEnded: (projectId, engine, localId) => { ended.push([projectId, engine, localId]) },
  })
}

const SRC: ForkSource = {
  engine: 'claude', sourceId: '11111111-1111-4111-8111-111111111111', cut: 'aaaaaaaa-0000-4000-8000-000000000003',
  cutAt: '2026-11-20T10:00:00.000Z', previewBefore: 1234, sessionId: '22222222-2222-4222-8222-222222222222',
}

describe('manager: ganchos do ramificar', () => {
  it('turnStartedAt marca o início do turno e limpa no fim', () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    const s = created[0]
    expect(mgr.turnStartedAt(info.localId)).toBeUndefined()

    s.delayAfterWrite = 15
    mgr.send(info.localId, 'primeira')
    const inicio = mgr.turnStartedAt(info.localId)
    expect(inicio).toBeTypeOf('number')
    // Gravado ANTES da escrita: a CLI carimba a mensagem com o relógio dela, e a
    // mensagem do turno em curso não pode cair antes do início do turno.
    expect(inicio!).toBeLessThanOrEqual(s.writes[0].at)

    // Mensagem no meio do turno não muda o início.
    s.delayAfterWrite = 0
    mgr.send(info.localId, 'adendo')
    expect(mgr.turnStartedAt(info.localId)).toBe(inicio)

    for (const fim of ['idle', 'needs_attention'] as const) {
      s.set(fim)
      expect(mgr.turnStartedAt(info.localId)).toBeUndefined()
      mgr.send(info.localId, 'de novo')
      expect(mgr.turnStartedAt(info.localId)).toBeTypeOf('number')
    }

    // Turno que a engine abre sozinha (sem send) também marca.
    s.set('idle')
    s.set('working')
    expect(mgr.turnStartedAt(info.localId)).toBeTypeOf('number')
    s.set('dead')
    expect(mgr.turnStartedAt(info.localId)).toBeUndefined()
    expect(mgr.turnStartedAt('nao-existe')).toBeUndefined()
  })

  it('turnStartedAt limpa no stopped', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    mgr.send(info.localId, 'x')
    expect(mgr.turnStartedAt(info.localId)).toBeTypeOf('number')
    await mgr.stop(info.localId)
    expect(mgr.turnStartedAt(info.localId)).toBeUndefined()
  })

  it('onSessionEnded no stop e na morte', async () => {
    const mgr = makeManager()
    const a = mgr.start(project, { engine: 'claude' })
    await mgr.stop(a.localId)
    expect(ended).toEqual([[project.id, 'claude', a.localId]])

    const b = mgr.start(project, { engine: 'codex' })
    created[1].set('dead')
    expect(ended).toEqual([[project.id, 'claude', a.localId], [project.id, 'codex', b.localId]])

    // No encerramento do serviço também.
    const c = mgr.start(project, { engine: 'claude' })
    mgr.beginShutdown()
    await mgr.stopAll()
    expect(ended.at(-1)).toEqual([project.id, 'claude', c.localId])
    expect(ended).toHaveLength(3)
  })

  it('onSessionEnded que lança não derruba o handler de status', () => {
    const mgr = createSessionManager({
      db, broadcast: () => {},
      sessionFactory: (opts) => { const s = new FakeSession(opts); created.push(s); return s },
      onSessionEnded: () => { throw new Error('boom') },
    })
    const info = mgr.start(project)
    expect(() => created[0].set('dead')).not.toThrow()
    expect(mgr.get(info.localId)?.status).toBe('dead')
  })

  it('start com forkSource grava fork_source e claude_session_id, sem resume nem continue', () => {
    const mgr = makeManager()
    const info = mgr.start(project, { engine: 'claude', continueLatest: true, model: 'opus', effort: 'high', forkSource: SRC })
    const o = created[0].opts
    expect(o.forkFrom).toEqual({ sourceId: SRC.sourceId, cut: SRC.cut })
    expect(o.sessionId).toBe(SRC.sessionId)
    expect(o.resumeSessionId).toBeUndefined()
    expect(o.continueLatest).toBeFalsy()
    expect(o.model).toBe('opus')
    expect(o.effort).toBe('high')
    const row = db.prepare('SELECT fork_source, claude_session_id, continue_latest FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(JSON.parse(row.fork_source)).toEqual(SRC)
    expect(row.claude_session_id).toBe(SRC.sessionId)
    expect(row.continue_latest).toBe(0)
    // O id escolhido aparece na hora (a prévia do ramo sabe qual conversa é).
    expect(info.engineSessionId).toBe(SRC.sessionId)
  })

  it('start com forkSource do Codex: sem sessionId, claude_session_id vazio', () => {
    const mgr = makeManager()
    const src: ForkSource = { engine: 'codex', sourceId: '019f0000-0000-7000-8000-00000000c0de', cut: 'turn-2', cutAt: null, previewBefore: 10 }
    const info = mgr.start(project, { engine: 'codex', forkSource: src })
    expect(created[0].opts.forkFrom).toEqual({ sourceId: src.sourceId, cut: 'turn-2' })
    expect(created[0].opts.sessionId).toBeUndefined()
    const row = db.prepare('SELECT fork_source, claude_session_id FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(JSON.parse(row.fork_source)).toEqual(src)
    expect(row.claude_session_id).toBeNull()
  })

  it('revive com fork_source copia de novo pelo forkPlanOf', async () => {
    const mgr = makeManager()
    const info = mgr.start(project, { engine: 'claude', forkSource: SRC })
    await mgr.stop(info.localId)
    mgr.revive(info.localId)
    const o = created[1].opts
    expect(o.forkFrom).toEqual({ sourceId: SRC.sourceId, cut: SRC.cut })
    expect(o.sessionId).toBe(SRC.sessionId)
    expect(o.resumeSessionId).toBeUndefined()
    expect(o.continueLatest).toBeFalsy()
  })

  it('revive sem fork_source segue igual', async () => {
    const mgr = makeManager()
    const info = mgr.start(project, { engine: 'codex' })
    created[0].sessionId = 'conv-1'
    created[0].set('working')
    await mgr.stop(info.localId)
    mgr.revive(info.localId)
    const o = created[1].opts
    expect(o.resumeSessionId).toBe('conv-1')
    expect(o.forkFrom).toBeUndefined()
    expect(o.sessionId).toBeUndefined()
    const row = db.prepare('SELECT fork_source FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.fork_source).toBeNull()
  })
})

describe('fork-source', () => {
  it('parseForkSource: vazio, JSON torto, campos faltando ou ids inseguros dão null', () => {
    expect(parseForkSource(null)).toBeNull()
    expect(parseForkSource(undefined)).toBeNull()
    expect(parseForkSource('')).toBeNull()
    expect(parseForkSource('{')).toBeNull()
    expect(parseForkSource('[]')).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, engine: '' }))).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, sourceId: undefined }))).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, sourceId: '-x' }))).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, cut: '--flag' }))).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, sessionId: '../x' }))).toBeNull()
    expect(parseForkSource(JSON.stringify({ ...SRC, previewBefore: 'x' }))).toBeNull()
  })

  it('parseForkSource devolve a fonte gravada', () => {
    expect(parseForkSource(JSON.stringify(SRC))).toEqual(SRC)
    const semCorte = { engine: 'opencode', sourceId: 'ses_ABC', cut: null, cutAt: null, previewBefore: null, seed: 'pacote' }
    expect(parseForkSource(JSON.stringify(semCorte))).toEqual(semCorte)
  })

  it('forkPlanOf por motor', async () => {
    expect(forkPlanOf(SRC, '/p')).toEqual({ forkFrom: { sourceId: SRC.sourceId, cut: SRC.cut }, sessionId: SRC.sessionId })
    expect(forkPlanOf({ ...SRC, cut: null }, '/p')).toEqual({ forkFrom: { sourceId: SRC.sourceId }, sessionId: SRC.sessionId })
    expect(forkPlanOf({ ...SRC, engine: 'codex', sessionId: undefined, cut: 't2' }, '/p')).toEqual({ forkFrom: { sourceId: SRC.sourceId, cut: 't2' } })
    expect(forkPlanOf({ ...SRC, engine: 'kimi' }, '/p')).toEqual({})
    const oc = forkPlanOf({ engine: 'opencode', sourceId: 'ses_ABC', cut: null, cutAt: null, previewBefore: null, seed: 'pacote' }, '/p')
    expect(oc.forkFrom?.sourceId).toBe('ses_ABC')
    expect(oc.forkFrom?.seed).toBe('pacote')
    expect(oc.forkFrom?.cut).toBeUndefined()
    // Sem corte, a cópia nativa nunca vale (e nem chama a CLI).
    expect(await oc.forkFrom!.nativeOk!()).toBe(false)
  })

  describe('forkPlanOf opencode: nativeOk compara a última mensagem da origem com o corte', () => {
    let tmp: string
    let binAntes: string | undefined
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'branch-mgr-oc-'))
      binAntes = process.env.CLAUDINEI_OPENCODE_BIN
      const bin = join(tmp, 'opencode')
      writeFileSync(bin, `#!/bin/sh\necho '{"messages":[{"info":{"id":"msg_1"}},{"info":{"id":"msg_LAST"}}]}'\n`)
      chmodSync(bin, 0o755)
      process.env.CLAUDINEI_OPENCODE_BIN = bin
    })
    afterEach(() => {
      if (binAntes === undefined) delete process.env.CLAUDINEI_OPENCODE_BIN
      else process.env.CLAUDINEI_OPENCODE_BIN = binAntes
      rmSync(tmp, { recursive: true, force: true })
    })

    it('original parado vale; original que andou não vale', async () => {
      const base: ForkSource = { engine: 'opencode', sourceId: 'ses_ABC', cut: 'msg_LAST', cutAt: null, previewBefore: 4 }
      expect(await forkPlanOf(base, '/p').forkFrom!.nativeOk!()).toBe(true)
      expect(await forkPlanOf({ ...base, cut: 'msg_1' }, '/p').forkFrom!.nativeOk!()).toBe(false)
    })
  })
})
