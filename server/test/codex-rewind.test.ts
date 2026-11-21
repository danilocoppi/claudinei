import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import { findRolloutCached, forgetRollout } from '../src/engine/codex/rollout.js'
import { createCodexRewind, locateCodexCut } from '../src/undo/rewind-codex.js'
import type { AgentEvent } from '../src/engine/types.js'
import type { TurnRow } from '../src/undo/store.js'
import { openDb } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'

const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))
const sessions: CodexSession[] = []
const roots: string[] = []
const mk = (opts: any = {}, args: string[] = []) => {
  const s = new CodexSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE, ...args], ...opts })
  sessions.push(s); return s
}
const waitFor = (cond: () => boolean) => expect.poll(cond, { timeout: 5000, interval: 10 }).toBe(true)
const eventsOf = (s: CodexSession) => { const events: AgentEvent[] = []; s.on('event', (e) => events.push(e)); return events }
/** Os pedidos de volta que o App Server falso recebeu. */
const callsOf = (s: CodexSession): Promise<Array<{ method: string; params: any }>> => (s as any).rpc.request('test/calls')
const turn = async (s: CodexSession, text: string) => { s.send(text); await waitFor(() => s.status === 'needs_attention') }
const tempRoot = () => { const r = mkdtempSync(join(tmpdir(), 'codex-rewind-')); roots.push(r); return r }
const savedHome = process.env.CODEX_HOME

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()))
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedHome
})

/** Manager espião: só o que o adaptador do Codex usa. */
function spyManager(session: CodexSession | undefined) {
  let live = session
  return {
    liveSession: vi.fn(() => live as any),
    relaunch: vi.fn(async (_localId: string, _opts: { resumeSessionId: string | null; holdEngineId?: boolean }) => ({}) as any),
    revive: vi.fn((_localId: string) => { live = session; session?.start(); return {} as any }),
    get: vi.fn((_localId: string) => ({ localId: 'L1', engine: 'codex' }) as any),
  }
}
const ctx = { localId: 'L1', projectPath: '/tmp', engineSessionId: 'THREAD-FAKE' }
const row = (over: Partial<TurnRow>): TurnRow => ({
  id: 1, localId: 'L1', projectId: 1, engine: 'codex', bornSessionId: null, conversationId: 'THREAD-FAKE', origin: 'operator',
  textKey: 'two', midTurn: false, anchor: null, repoKey: null, repoTop: null, startMark: null, endMark: null, endKind: null,
  snapshot: 'none' as any, snapshotError: null, limited: false, declared: [], summary: null, rewoundAt: null,
  startedAt: '', endedAt: null, ...over,
})

describe('CodexSession: voltar a conversa', () => {
  it('turn/started emite system turn_started com o id', async () => {
    const s = mk(); const events = eventsOf(s); s.start()
    await turn(s, 'one')
    expect(events).toContainEqual({ kind: 'system', subtype: 'turn_started', raw: { turnId: 'turn-1' } })
  })

  it('revertConversation manda thread/revert com beforeTurnId e o thread segue o mesmo', async () => {
    const s = mk(); s.start()
    await turn(s, 'one'); await turn(s, 'two'); await turn(s, 'three')
    await s.revertConversation('turn-2')
    expect(s.sessionId).toBe('THREAD-FAKE')
    const calls = await callsOf(s)
    expect(calls.filter((c) => c.method === 'thread/revert')).toEqual([{ method: 'thread/revert', params: { threadId: 'THREAD-FAKE', beforeTurnId: 'turn-2' } }])
    expect(await s.listTurns()).toEqual([{ id: 'turn-1', userTexts: ['one'] }])
    // A conversa continua utilizável depois da volta.
    await turn(s, 'four')
    expect((await s.listTurns()).map((t) => t.userTexts)).toEqual([['one'], ['four']])
  })

  it('listTurns pagina até o fim, em ordem, com os textos de steer no mesmo turno', async () => {
    const s = mk({}, ['--page-size=2']); s.start()
    await turn(s, 'one')
    s.send('__wait_for_steer__'); await waitFor(() => (s as any).turnId === 'turn-2')
    s.send('steered'); await waitFor(() => s.status === 'needs_attention')
    await turn(s, 'three'); await turn(s, 'four')
    expect(await s.listTurns()).toEqual([
      { id: 'turn-1', userTexts: ['one'] },
      { id: 'turn-2', userTexts: ['__wait_for_steer__', 'steered'] },
      { id: 'turn-3', userTexts: ['three'] },
      { id: 'turn-4', userTexts: ['four'] },
    ])
    const lists = (await callsOf(s)).filter((c) => c.method === 'thread/turns/list')
    expect(lists).toHaveLength(2)
    expect(lists[0].params).toMatchObject({ threadId: 'THREAD-FAKE', sortDirection: 'desc', itemsView: 'full', limit: 20 })
  })

  it('forkConversation manda excludeTurns e as permissões do terminal e devolve o id novo', async () => {
    const s = mk(); s.start()
    await turn(s, 'one'); await turn(s, 'two')
    expect(await s.forkConversation('turn-1')).toBe('FORK-1')
    const fork = (await callsOf(s)).find((c) => c.method === 'thread/fork')
    expect(fork?.params).toEqual({
      threadId: 'THREAD-FAKE', lastTurnId: 'turn-1', excludeTurns: true,
      cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access',
    })
  })

  it('com turno em curso as três recusam sem chamar o App Server', async () => {
    const s = mk(); s.start()
    await turn(s, 'one')
    s.send('__hang__'); await waitFor(() => (s as any).turnId === 'turn-2')
    await expect(s.revertConversation('turn-1')).rejects.toThrow(/em curso/)
    await expect(s.forkConversation('turn-1')).rejects.toThrow(/em curso/)
    await expect(s.listTurns()).rejects.toThrow(/em curso/)
    expect(await callsOf(s)).toEqual([])
  })

  it('sessão nova, sem conversa, não abre thread para voltar', async () => {
    const s = mk(); s.start()
    await expect(s.revertConversation('turn-1')).rejects.toThrow(/sem conversa/)
    expect(s.sessionId).toBeUndefined()
  })
})

describe('locateCodexCut', () => {
  const turns = [
    { id: 't1', userTexts: ['oi'] },
    { id: 't2', userTexts: ['faça X', 'e também Y'] },
    { id: 't3', userTexts: ['oi'] },
    { id: 't4', userTexts: ['[Claudinei: files reverted]: The operator reverted the file changes of an earlier turn: a.txt. Re-read them before editing.\n\noi'] },
  ]
  it('mensagem de steer (segundo userMessage do turno) dá midTurn', () => {
    expect(locateCodexCut(turns, 'e também Y', 0)).toEqual({ kind: 'codex', beforeTurnId: 't2', previousTurnId: 't1', midTurn: true })
    expect(locateCodexCut(turns, 'faça X', 0)).toEqual({ kind: 'codex', beforeTurnId: 't2', previousTurnId: 't1', midTurn: false })
  })
  it('occurrence 1 pega a penúltima ocorrência do mesmo texto', () => {
    // A nota na frente sai da chave: t4 é a última ocorrência de "oi".
    expect(locateCodexCut(turns, 'oi', 0)?.beforeTurnId).toBe('t4')
    expect(locateCodexCut(turns, 'oi', 1)?.beforeTurnId).toBe('t3')
    expect(locateCodexCut(turns, 'oi', 2)).toEqual({ kind: 'codex', beforeTurnId: 't1', previousTurnId: null, midTurn: false })
    expect(locateCodexCut(turns, 'oi', 3)).toBeNull()
    expect(locateCodexCut(turns, 'nunca dito', 0)).toBeNull()
  })
})

describe('forgetRollout', () => {
  it('forgetRollout faz findRolloutCached varrer de novo', async () => {
    const root = tempRoot()
    const dir = join(root, '2026', '11', '20'); mkdirSync(dir, { recursive: true })
    const old = join(dir, 'rollout-2026-11-20T00-00-00-THREAD-X.jsonl')
    writeFileSync(old, '{}\n'); utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1))
    expect(await findRolloutCached(root, 'THREAD-X')).toBe(old)
    // O revert troca o rollout por `…-<id>_<novo>.jsonl`; o antigo fica no disco.
    const reverted = join(dir, 'rollout-2026-11-20T01-00-00-THREAD-X_NEW.jsonl')
    writeFileSync(reverted, '{}\n')
    expect(await findRolloutCached(root, 'THREAD-X')).toBe(old)
    forgetRollout(root, 'THREAD-X')
    expect(await findRolloutCached(root, 'THREAD-X')).toBe(reverted)
  })
})

describe('createCodexRewind', () => {
  it('apply com revert aceito: mesma conversa e o rollout novo passa a valer', async () => {
    const home = tempRoot(); process.env.CODEX_HOME = home
    const dir = join(home, 'sessions', '2026', '11', '20'); mkdirSync(dir, { recursive: true })
    const old = join(dir, 'rollout-2026-11-20T00-00-00-THREAD-FAKE.jsonl')
    writeFileSync(old, '{}\n'); utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1))
    expect(await findRolloutCached(join(home, 'sessions'), 'THREAD-FAKE')).toBe(old)
    const s = mk(); s.start()
    await turn(s, 'one'); await turn(s, 'two')
    const reverted = join(dir, 'rollout-2026-11-20T01-00-00-THREAD-FAKE_NEW.jsonl')
    writeFileSync(reverted, '{}\n')
    const manager = spyManager(s)
    const rewind = createCodexRewind({ manager })
    expect(await rewind.apply(ctx, { kind: 'codex', beforeTurnId: 'turn-2', previousTurnId: 'turn-1', midTurn: false })).toEqual({})
    expect(manager.relaunch).not.toHaveBeenCalled()
    expect(await findRolloutCached(join(home, 'sessions'), 'THREAD-FAKE')).toBe(reverted)
  })

  it('revert recusado cai no fork com excludeTurns e relaunch no id novo', async () => {
    const s = mk({}, ['--refuse-revert']); s.start()
    await turn(s, 'one'); await turn(s, 'two')
    const manager = spyManager(s)
    const out = await createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-2', previousTurnId: 'turn-1', midTurn: false })
    expect(out).toEqual({ newConversationId: 'FORK-1' })
    expect(manager.relaunch).toHaveBeenCalledWith('L1', { resumeSessionId: 'FORK-1' })
    const fork = (await callsOf(s)).find((c) => c.method === 'thread/fork')
    expect(fork?.params).toMatchObject({ lastTurnId: 'turn-1', excludeTurns: true })
  })

  it('editar o primeiro turno com revert recusado abre conversa nova', async () => {
    const s = mk({}, ['--refuse-revert']); s.start()
    await turn(s, 'one'); await turn(s, 'two')
    const manager = spyManager(s)
    const out = await createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-1', previousTurnId: null, midTurn: false })
    expect(out).toEqual({})
    // O id da conversa nova fica segurado até o primeiro result (rewind_pending), como no Claude.
    expect(manager.relaunch).toHaveBeenCalledWith('L1', { resumeSessionId: null, holdEngineId: true })
    expect((await callsOf(s)).some((c) => c.method === 'thread/fork')).toBe(false)
  })

  it('corte vindo do anchor (turno anterior desconhecido) acha o anterior na lista antes do fork', async () => {
    const s = mk({}, ['--refuse-revert']); s.start()
    await turn(s, 'one'); await turn(s, 'two'); await turn(s, 'three')
    const manager = spyManager(s)
    const out = await createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-3', midTurn: false })
    expect(out).toEqual({ newConversationId: 'FORK-1' })
    expect((await callsOf(s)).find((c) => c.method === 'thread/fork')?.params).toMatchObject({ lastTurnId: 'turn-2' })
  })

  it('corte vindo do anchor que não está na conversa: erro, sem fork nem conversa nova', async () => {
    const s = mk({}, ['--refuse-revert']); s.start()
    await turn(s, 'one')
    const manager = spyManager(s)
    await expect(createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-9', midTurn: false })).rejects.toThrow()
    expect(manager.relaunch).not.toHaveBeenCalled()
  })

  it('apply revive a sessão que não está viva antes de voltar', async () => {
    const s = mk({ resumeSessionId: 'THREAD-OLD' })
    const manager = spyManager(s)
    manager.liveSession.mockReturnValueOnce(undefined)
    // O fake não guarda turnos de conversa retomada: o revert recusa por turno ausente e cai no fork.
    await createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-1', previousTurnId: 'turn-0', midTurn: false })
    expect(manager.revive).toHaveBeenCalledWith('L1')
    expect((await callsOf(s)).find((c) => c.method === 'thread/revert')?.params).toEqual({ threadId: 'THREAD-OLD', beforeTurnId: 'turn-1' })
  })

  it('apply recusa corte do meio do turno', async () => {
    const s = mk(); s.start(); await turn(s, 'one')
    const manager = spyManager(s)
    await expect(createCodexRewind({ manager }).apply(ctx, { kind: 'codex', beforeTurnId: 'turn-1', previousTurnId: null, midTurn: true })).rejects.toThrow()
    expect((await callsOf(s)).some((c) => c.method === 'thread/revert')).toBe(false)
  })

  it('locate prefere o anchor do turno gravado e não pergunta ao App Server', async () => {
    const s = mk(); s.start(); await turn(s, 'one'); await turn(s, 'two')
    const rewind = createCodexRewind({ manager: spyManager(s) })
    expect(await rewind.locate({ ...ctx, turn: row({ anchor: 'turn-2' }) }, 'two', 0)).toEqual({ kind: 'codex', beforeTurnId: 'turn-2', midTurn: false })
    expect(await rewind.locate({ ...ctx, turn: row({ anchor: null, midTurn: true }) }, 'two', 0)).toMatchObject({ kind: 'codex', midTurn: true })
    expect((await callsOf(s)).some((c) => c.method === 'thread/turns/list')).toBe(false)
  })

  it('locate sem anchor cai no thread/turns/list', async () => {
    const s = mk(); s.start(); await turn(s, 'one'); await turn(s, 'two'); await turn(s, 'one')
    const rewind = createCodexRewind({ manager: spyManager(s) })
    expect(await rewind.locate(ctx, 'one', 1)).toEqual({ kind: 'codex', beforeTurnId: 'turn-1', previousTurnId: null, midTurn: false })
    expect(await rewind.locate({ ...ctx, turn: row({ anchor: null }) }, 'two', 0)).toEqual({ kind: 'codex', beforeTurnId: 'turn-2', previousTurnId: 'turn-1', midTurn: false })
    expect(await rewind.locate(ctx, 'nunca', 0)).toBeNull()
  })

  it('locate sem anchor e sem sessão viva devolve null', async () => {
    const rewind = createCodexRewind({ manager: spyManager(undefined) })
    expect(await rewind.locate(ctx, 'one', 0)).toBeNull()
  })
})

describe('volta do Codex com o manager de verdade', () => {
  it('primeiro turno com revert recusado: a conversa nova fica segurada (rewind_pending) até o result do Codex', async () => {
    const db = openDb(':memory:')
    const project = createProjectsService(db).create({ name: 'P1', path: tempRoot() })
    const mgr = createSessionManager({ db, broadcast: () => {}, sessionFactory: (opts) => mk(opts, ['--refuse-revert']) as any })
    const info = mgr.start(project, { engine: 'codex' })
    // A conversa de antes da volta: THREAD-OLD (a conversa nova do App Server falso é THREAD-FAKE).
    await mgr.relaunch(info.localId, { resumeSessionId: 'THREAD-OLD' })
    await waitFor(() => mgr.get(info.localId)?.engineSessionId === 'THREAD-OLD' && mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'one')
    await waitFor(() => mgr.get(info.localId)?.status === 'needs_attention')
    const dbId = () => (db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(info.localId) as any).claude_session_id

    const out = await createCodexRewind({ manager: mgr }).apply(
      { localId: info.localId, projectPath: project.path, engineSessionId: 'THREAD-OLD' },
      { kind: 'codex', beforeTurnId: 'turn-1', previousTurnId: null, midTurn: false },
    )
    expect(out).toEqual({})
    expect(mgr.rewindPending(info.localId)).toBe(true)
    expect(mgr.get(info.localId)?.engineSessionId).toBe('THREAD-OLD')

    // O primeiro turno abre a conversa nova (init com o id novo): continua segurada.
    // Lido no próprio init (o turno do App Server falso fecha logo em seguida).
    const noInit: Array<{ id: string | undefined; db: string; pending: boolean; shown: string | null | undefined }> = []
    mgr.liveSession(info.localId)!.on('event', (e: AgentEvent) => {
      if (e.kind === 'init') noInit.push({ id: e.sessionId, db: dbId(), pending: mgr.rewindPending(info.localId), shown: mgr.get(info.localId)?.engineSessionId })
    })
    mgr.send(info.localId, 'editada')
    await waitFor(() => noInit.length > 0)
    expect(noInit[0]).toEqual({ id: 'THREAD-FAKE', db: 'THREAD-OLD', pending: true, shown: 'THREAD-OLD' })
    // O result do Codex solta pelo mesmo caminho do Claude: o id novo vai ao banco.
    await waitFor(() => !mgr.rewindPending(info.localId))
    expect(dbId()).toBe('THREAD-FAKE')
    expect(mgr.get(info.localId)?.engineSessionId).toBe('THREAD-FAKE')
    await mgr.stopAll()
  })
})
