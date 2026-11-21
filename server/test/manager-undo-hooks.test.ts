import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { claudeEngine, claudeConfigDir } from '../src/engine/claude-engine.js'
import type { TurnObserver, UndoCtx, InputOrigin, StatusInfo } from '../src/undo/types.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Observador espião: registra tudo e, por padrão, manda o texto com um prefixo. */
function spyObserver() {
  const inputs: { ctx: UndoCtx; text: string; origin: InputOrigin }[] = []
  const statuses: { ctx: UndoCtx; status: string; info: StatusInfo; compactionNow: boolean }[] = []
  const events: { ctx: UndoCtx; event: AgentEvent }[] = []
  const interactive: { ctx: UndoCtx; phase: 'open' | 'close' }[] = []
  const state: { throwOnInput: Error | null } = { throwOnInput: null }
  const observer: TurnObserver = {
    onInput(ctx, text, origin, send) {
      inputs.push({ ctx, text, origin })
      if (state.throwOnInput) throw state.throwOnInput
      send(`[nota] ${text}`)
    },
    onStatus(ctx, status, info) { statuses.push({ ctx, status, info, compactionNow: info.compaction() }) },
    onEvent(ctx, event) { events.push({ ctx, event }) },
    onInteractive(ctx, phase) { interactive.push({ ctx, phase }) },
  }
  return { observer, inputs, statuses, events, interactive, state }
}

let db: Db
let project: Project
let broadcasts: any[]
const tmps: string[] = []
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d }

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: tmp('undo-hooks-') })
  broadcasts = []
})

afterEach(() => {
  delete process.env.FAKE_SESSION_ID
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('manager: ganchos do desfazer', () => {
  it('os cinco envios chamam onInput com a origem certa e mandam o texto final que ele devolve', async () => {
    const spy = spyObserver()
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const idleAgain = async () => waitUntil(() => ['idle', 'needs_attention'].includes(mgr.get(info.localId)!.status))
    const results = () => spy.events.filter((e) => e.event.kind === 'result').map((e) => (e.event as any).resultText)

    mgr.send(info.localId, 'do operador')
    await waitUntil(() => results().length === 1)
    await idleAgain()
    expect(results()[0]).toBe('eco: [nota] do operador')

    mgr.sendAsClaudinei(info.localId, 'do claudinei')
    await waitUntil(() => results().length === 2)
    await idleAgain()
    expect(results()[1]).toBe('eco: [nota] do claudinei')

    const answer = await mgr.askAgent(project.id, 'Outro', 'pergunta')
    expect(answer).toBe('eco: [nota] [Question from agent of Outro]: pergunta')
    await idleAgain()

    const sched = await mgr.sendAndWait(info.localId, 'agendado')
    expect(sched).toBe('eco: [nota] agendado')
    await idleAgain()

    const done = new Promise<[string, string]>((r) => mgr.dispatchTask(project.id, 'Outro', 'tarefa', (s, res) => r([s, res])))
    expect(await done).toEqual(['completed', 'eco: [nota] [Task from Outro]: tarefa'])

    expect(spy.inputs.map((i) => [i.origin, i.text])).toEqual([
      ['operator', 'do operador'],
      ['claudinei', 'do claudinei'],
      ['task', '[Question from agent of Outro]: pergunta'],
      ['schedule', 'agendado'],
      ['task', '[Task from Outro]: tarefa'],
    ])
    for (const i of spy.inputs) expect(i.ctx).toEqual({ localId: info.localId, projectId: project.id, engine: 'claude' })
    await mgr.stop(info.localId)
  })

  it('onInput que lança: send do operador lança e onOperatorMessage não é chamado', async () => {
    const spy = spyObserver()
    const operatorMsgs: unknown[] = []
    const mgr = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer,
      onOperatorMessage: (...a) => { operatorMsgs.push(a) },
    })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    spy.state.throwOnInput = new Error('undo_writing')
    expect(() => mgr.send(info.localId, 'bloqueada')).toThrow('undo_writing')
    expect(operatorMsgs).toEqual([])
    // Nada saiu: a sessão segue livre, sem turno.
    await new Promise((r) => setTimeout(r, 100))
    expect(mgr.get(info.localId)?.status).toBe('idle')
    expect(spy.events.some((e) => e.event.kind === 'result')).toBe(false)
    // Os outros envios também recusam.
    expect(() => mgr.sendAsClaudinei(info.localId, 'x')).toThrow('undo_writing')
    await expect(mgr.sendAndWait(info.localId, 'x')).rejects.toThrow('undo_writing')
    await expect(mgr.askAgent(project.id, 'Outro', 'x')).rejects.toThrow('undo_writing')
    const failed = new Promise<[string, string]>((r) => mgr.dispatchTask(project.id, 'Outro', 'x', (s, res) => r([s, res])))
    expect(await failed).toEqual(['failed', 'undo_writing'])
    await mgr.stop(info.localId)
  })

  it('/compact não passa pelo observador; o status working dele chega com compaction() verdadeiro', async () => {
    const spy = spyObserver()
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'comum')
    await waitUntil(() => spy.events.some((e) => e.event.kind === 'result'))
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    const comum = spy.statuses.find((s) => s.status === 'working')!
    // No status, a marca ainda não foi ligada (o tracker lê numa microtask); depois do envio, nada de compactação.
    expect(comum.info.compaction()).toBe(false)

    const before = spy.statuses.length
    mgr.send(info.localId, '/compact')
    expect(spy.inputs.map((i) => i.text)).toEqual(['comum'])
    const working = spy.statuses.slice(before).find((s) => s.status === 'working')!
    expect(working).toBeDefined()
    // A marca liga logo depois do status, na mesma pilha do envio.
    expect(working.info.compaction()).toBe(true)
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    await mgr.stop(info.localId)
  })

  it('onStatus e onEvent chegam com localId, projectId e engine', async () => {
    const spy = spyObserver()
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'olá')
    await waitUntil(() => spy.events.some((e) => e.event.kind === 'result'))
    await mgr.stop(info.localId)
    const ctx = { localId: info.localId, projectId: project.id, engine: 'claude' }
    expect(spy.statuses.map((s) => s.status)).toEqual(expect.arrayContaining(['idle', 'working', 'needs_attention', 'stopped']))
    for (const s of spy.statuses) expect(s.ctx).toEqual(ctx)
    expect(spy.statuses.find((s) => s.status === 'working')!.info.engineSessionId).toBe('fake-session-0001')
    expect(spy.statuses.every((s) => s.info.shuttingDown === false)).toBe(true)
    expect(spy.events.map((e) => e.event.kind)).toEqual(expect.arrayContaining(['init', 'result']))
    for (const e of spy.events) expect(e.ctx).toEqual(ctx)
  })

  it('erro no onStatus ou no onEvent não derruba a sessão', async () => {
    const observer: TurnObserver = {
      onInput: (_c, t, _o, send) => send(t),
      onStatus: () => { throw new Error('status') },
      onEvent: () => { throw new Error('evento') },
      onInteractive: () => {},
    }
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: observer })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'olá')
    await waitUntil(() => broadcasts.some((b) => b.type === 'session_event' && b.event.kind === 'result'))
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    await mgr.stop(info.localId)
  })

  it('openInTerminal chama onInteractive open e o onExit chama close', async () => {
    const spy = spyObserver()
    let onExit: (() => void) | undefined
    const mgr = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer,
      terminalLauncher: (opts) => { onExit = opts.onExit; return 'tok' },
    })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const cfg = tmp('claude-cfg-')
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      await mgr.openInTerminal(info.localId)
      const ctx = { localId: info.localId, projectId: project.id, engine: 'claude' }
      expect(spy.interactive).toEqual([{ ctx, phase: 'open' }])
      // A sessão headless parou antes do terminal abrir: o stopped vem antes do open.
      expect(spy.statuses.at(-1)?.status).toBe('stopped')
      onExit!()
      expect(spy.interactive).toEqual([{ ctx, phase: 'open' }, { ctx, phase: 'close' }])
      // Um segundo onExit (status já não é in_terminal) não fecha de novo.
      onExit!()
      expect(spy.interactive).toHaveLength(2)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })

  it('relaunch passa extraArgs e resumeSessionId ao sessionFactory e mantém o localId', async () => {
    const captured: any[] = []
    const factory = (opts: SessionOptions) => { captured.push(opts); return fakeFactory(opts) }
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project, { model: 'sonnet' })
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const first = mgr.liveSession(info.localId)
    expect(first).toBeDefined()

    const out = await mgr.relaunch(info.localId, { resumeSessionId: 'fake-session-0001', extraArgs: ['--resume-session-at', 'u-1', '--fork-session'] })
    expect(out.localId).toBe(info.localId)
    expect(captured).toHaveLength(2)
    expect(captured[1]).toMatchObject({
      projectPath: project.path, resumeSessionId: 'fake-session-0001', continueLatest: false,
      extraArgs: ['--resume-session-at', 'u-1', '--fork-session'], model: 'sonnet', permissionMode: 'bypassPermissions',
    })
    // A sessão de antes parou; a nova é a viva do mesmo terminal.
    expect(first!.status).toBe('stopped')
    const second = mgr.liveSession(info.localId)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(mgr.list().filter((s) => s.projectId === project.id)).toHaveLength(1)

    // Sem conversa: abre sessão nova.
    await mgr.relaunch(info.localId, { resumeSessionId: null })
    expect(captured[2].resumeSessionId).toBeUndefined()
    expect(captured[2].continueLatest).toBe(false)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
    expect(mgr.liveSession(info.localId)).toBeUndefined()
    await expect(mgr.relaunch('nao-existe', { resumeSessionId: null })).rejects.toThrow()
  })

  it('relaunch com holdEngineId: antes do primeiro result o banco e o session_status mostram o id antigo; depois, o novo', async () => {
    const spy = spyObserver()
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m), turnObserver: spy.observer })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const dbId = () => (db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(info.localId) as any).claude_session_id
    const threads = () => (db.prepare('SELECT thread_id FROM project_threads WHERE project_id=?').all(project.id) as any[]).map((r) => r.thread_id)
    expect(dbId()).toBe('fake-session-0001')

    process.env.FAKE_SESSION_ID = 'novo-0002'
    const mark = broadcasts.length
    const out = await mgr.relaunch(info.localId, { resumeSessionId: 'fake-session-0001', extraArgs: ['--fork-session'], holdEngineId: true })
    expect(out.engineSessionId).toBe('fake-session-0001')
    // O init do processo novo já chegou (status idle) com o id novo.
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(mgr.liveSession(info.localId)?.sessionId).toBe('novo-0002')
    expect(dbId()).toBe('fake-session-0001')
    expect(mgr.get(info.localId)?.engineSessionId).toBe('fake-session-0001')
    expect(mgr.list().find((s) => s.localId === info.localId)?.engineSessionId).toBe('fake-session-0001')
    expect(threads()).not.toContain('novo-0002')
    const sinceRelaunch = () => broadcasts.slice(mark).filter((b) => b.type === 'session_status')
    expect(sinceRelaunch().length).toBeGreaterThan(0)
    expect(sinceRelaunch().every((b) => b.engineSessionId === 'fake-session-0001')).toBe(true)
    // Trocar opções no meio não vaza o id novo.
    await mgr.setSessionOptions(info.localId, { effort: 'high' })
    expect(sinceRelaunch().every((b) => b.engineSessionId === 'fake-session-0001')).toBe(true)

    mgr.send(info.localId, 'primeira')
    await waitUntil(() => spy.events.some((e) => e.event.kind === 'result'))
    expect(dbId()).toBe('novo-0002')
    expect(mgr.get(info.localId)?.engineSessionId).toBe('novo-0002')
    expect(threads()).toContain('novo-0002')
    expect(sinceRelaunch().at(-1)?.engineSessionId).toBe('novo-0002')
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    expect(sinceRelaunch().at(-1)?.engineSessionId).toBe('novo-0002')
    await mgr.stop(info.localId)
    expect(dbId()).toBe('novo-0002')
  })

  it('relaunch com trava e processo que morre antes do result: banco com o id antigo e project_threads sem o novo', async () => {
    const captured: any[] = []
    const factory = (opts: SessionOptions) => { captured.push(opts); return fakeFactory(opts) }
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const dbId = () => (db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(info.localId) as any).claude_session_id
    const threads = () => (db.prepare('SELECT thread_id FROM project_threads WHERE project_id=?').all(project.id) as any[]).map((r) => r.thread_id)

    process.env.FAKE_SESSION_ID = 'novo-0003'
    const mark = broadcasts.length
    await mgr.relaunch(info.localId, { resumeSessionId: 'fake-session-0001', holdEngineId: true })
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'crash')
    await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
    expect(dbId()).toBe('fake-session-0001')
    expect(threads()).not.toContain('novo-0003')
    expect(mgr.get(info.localId)?.engineSessionId).toBe('fake-session-0001')
    const sent = broadcasts.slice(mark).filter((b) => b.type === 'session_status' || (b.type === 'session_event' && b.event.kind !== 'init'))
    expect(JSON.stringify(sent)).not.toContain('novo-0003')

    // Reviver retoma a conversa antiga (o transcript dela existe).
    delete process.env.FAKE_SESSION_ID
    const cfg = tmp('claude-cfg-')
    const pd = join(cfg, 'projects', project.path.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, 'fake-session-0001.jsonl'), '{"type":"user"}\n')
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      mgr.revive(info.localId)
      expect(captured.at(-1).resumeSessionId).toBe('fake-session-0001')
      expect(captured.at(-1).extraArgs).toBeUndefined()
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      // O revive não herda a trava: o id do processo vale de novo.
      expect(mgr.get(info.localId)?.engineSessionId).toBe('fake-session-0001')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
    await mgr.stop(info.localId)
  })
})

describe('claude-engine: extraArgs', () => {
  it('buildClaudeArgs + extraArgs: claude-engine repassa extraArgs ao ClaudeSession', async () => {
    // Um "claude" de mentira que grava o argv e sai.
    const dir = tmp('fake-bin-')
    const out = join(dir, 'argv.json')
    const bin = join(dir, 'claude.mjs')
    writeFileSync(bin, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
    const s = claudeEngine.createSession({ projectPath: dir, resumeSessionId: 'abc', bin, extraArgs: ['--resume-session-at', 'u-9', '--fork-session', '--session-id', 'n-1'] })
    const exited = new Promise<void>((r) => s.once('exit', () => r()))
    s.start()
    await exited
    const argv = JSON.parse(readFileSync(out, 'utf8')) as string[]
    const i = argv.indexOf('--resume')
    expect(argv[i + 1]).toBe('abc')
    expect(argv.slice(-5)).toEqual(['--resume-session-at', 'u-9', '--fork-session', '--session-id', 'n-1'])
  })

  it('exporta claudeConfigDir', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg-x'
    try { expect(claudeConfigDir()).toBe('/tmp/cfg-x') } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
    }
  })
})
