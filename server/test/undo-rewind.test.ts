import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { transcriptPath } from '../src/history.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'
import type { GoalService } from '../src/goal/goal.js'
import { createTerminalStateStore } from '../src/restart/terminal-state.js'
import { observerOf, type Undo } from '../src/undo/index.js'
import { createRewindService, type RewindAdapter } from '../src/undo/rewind.js'
import { createUndoStore } from '../src/undo/store.js'
import { UserError } from '../src/user-error.js'
import { CONVERSATION_REWOUND_NOTE, FILES_REVERTED_PREFIX, withNote } from '../../shared/undo.js'
import { makeRepo, makeTempDir } from './helpers/git-repo.js'
import '../src/engine/index.js'

/**
 * "Editar a partir daqui" no app real: o manager com o CLI falso e o
 * rastreador ligado como em index.ts, repositórios temporários e o adaptador
 * do Claude de verdade, com o `relaunch` do manager espiado (ele segue para o
 * relaunch real, que sobe outro CLI falso com o id novo).
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
const SID = 'fake-session-0001'

const waitUntil = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let db: Db
let manager: SessionManager
let app: Awaited<ReturnType<typeof buildApp>>
let undo: Undo
let nextSend: NextSend | undefined
let queue: OperatorQueueService | undefined
let goal: GoalService | undefined
let configDir: string
const savedConfig = process.env.CLAUDE_CONFIG_DIR
const cleanups: Array<() => void> = []

beforeEach(async () => {
  db = openDb(':memory:')
  configDir = mkdtempSync(join(tmpdir(), 'claudinei-rewind-cfg-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  nextSend = undefined
  queue = undefined
  goal = undefined
  manager = createSessionManager({
    db, broadcast: () => {}, sessionFactory: fakeFactory,
    turnObserver: observerOf(() => undo),
    onSessionAvailable: (projectId, ctx) => {
      if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, engine: ctx.engine, localId: ctx.localId })
    },
    onOperatorMessage: (projectId, engine, info) => goal?.onOperatorMessage(projectId, engine, info),
  })
  app = await buildApp({
    config: loadConfig({}), db, manager,
    onUndoReady: (u) => { undo = u },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onGoalReady: (g) => { goal = g },
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await manager.stopAll()
  await undo?.idle()
  await app.close()
  delete process.env.FAKE_SESSION_ID
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
  rmSync(configDir, { recursive: true, force: true })
  for (const c of cleanups.splice(0).reverse()) c()
})

function repo(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' }) {
  const r = makeRepo(files)
  cleanups.push(r.cleanup)
  return r
}

function project(path: string, name = 'P1'): Project {
  return createProjectsService(db).create({ name, path })
}

/** O transcript que o CLI falso não grava: uma entrada `user` por mensagem, com a resposta depois. */
function transcriptOf(p: Project, sid = SID) {
  let n = 0
  let last: string | null = null
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const file = () => transcriptPath(configDir, p.path, sid)
  return {
    /** Grava a mensagem e a resposta; devolve o parentUuid da mensagem (o ponto do corte). */
    add(text: string): string | null {
      const at = last
      const u = uuid()
      const a = uuid()
      mkdirSync(dirname(file()), { recursive: true })
      appendFileSync(file(), JSON.stringify({ type: 'user', uuid: u, parentUuid: at, message: { role: 'user', content: text } }) + '\n')
      appendFileSync(file(), JSON.stringify({ type: 'assistant', uuid: a, parentUuid: u, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\n')
      last = a
      return at
    },
  }
}

async function start(p: Project): Promise<string> {
  const info = manager.start(p)
  await waitUntil(() => manager.get(info.localId)?.status === 'idle')
  return info.localId
}

const free = (localId: string) => ['idle', 'needs_attention'].includes(manager.get(localId)?.status ?? '')

/** Manda a mensagem do operador e espera o turno fechar no rastreador (e o resumo, que sai logo depois). */
async function say(localId: string, text: string): Promise<number> {
  manager.send(localId, text)
  await waitUntil(() => free(localId))
  await undo.idle()
  const p = manager.get(localId)!
  const turns = undo.store.terminalTurns(p.projectId, p.engine)
  const id = turns[turns.length - 1].id
  await waitUntil(() => undo.store.turn(id)!.endedAt !== null)
  await undo.idle()
  const t = undo.store.turn(id)!
  if (t.snapshot === 'ok' || t.snapshot === 'late') await waitUntil(() => undo.store.turn(id)!.summary !== null)
  return id
}

const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload })
const options = (localId: string, target: object) => post(`/api/undo/terminals/${localId}/rewind/options`, { target })
const rewind = (localId: string, body: object) => post(`/api/undo/terminals/${localId}/rewind`, body)

/** O relaunch real, espiado: o CLI falso novo nasce com o id que o adaptador pediu em `--session-id`. */
function spyRelaunch() {
  const real = manager.relaunch.bind(manager)
  return vi.spyOn(manager, 'relaunch').mockImplementation(async (localId, opts) => {
    const at = opts.extraArgs?.indexOf('--session-id') ?? -1
    // Conversa nova (voltou à primeira mensagem): o CLI real sorteia um id.
    process.env.FAKE_SESSION_ID = at >= 0 ? opts.extraArgs![at + 1] : 'fake-session-nova'
    return real(localId, opts)
  })
}

const sentTexts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c[1] as string)

describe('editar a partir daqui: opções', () => {
  it('options: kimi e opencode desligados com engine_unsupported e o motor nos params', async () => {
    const r = repo()
    for (const [engine, name] of [['kimi', 'K'], ['opencode', 'O']] as const) {
      const p = project(r.dir, name)
      db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES (?, ?, ?, 'stopped', ?)`)
        .run(`L-${engine}`, 'conv-1', p.id, engine)
      const res = await options(`L-${engine}`, { text: 'oi', occurrence: 0 })
      expect(res.statusCode).toBe(200)
      const off = { enabled: false, reason: 'engine_unsupported', params: { engine } }
      expect(res.json()).toMatchObject({ engine, conversation: off, files: off, working: false })
    }
  })

  it('options: sem git, files desligado com no_git e conversation ligado', async () => {
    const dir = makeTempDir('claudinei-rewind-nogit-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const p = project(dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    const res = (await options(L, { text: 'primeira', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: true })
    expect(res.files).toMatchObject({ enabled: false, reason: 'no_git' })
  })

  it('options: mensagem anterior ao recurso (sem turno gravado) tem conversation ligado e files no_snapshot', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('antiga, de antes do desfazer')
    tr.add('nova'); await say(L, 'nova')
    const res = (await options(L, { text: 'antiga, de antes do desfazer', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: true })
    expect(res.files).toMatchObject({ enabled: false, reason: 'no_snapshot' })
  })

  it('options: com o trecho em ordem, files ligado com a prévia dos turnos da mensagem até o último', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('bash-escreve:a.txt=um'); const t2 = await say(L, 'bash-escreve:a.txt=um')
    tr.add('bash-escreve:b.txt=dois'); const t3 = await say(L, 'bash-escreve:b.txt=dois')
    const res = (await options(L, { text: 'bash-escreve:a.txt=um', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: true })
    expect(res.files.enabled).toBe(true)
    expect(res.files.preview.turnIds.sort()).toEqual([t2, t3].sort())
    expect(res.files.preview.files.map((f: { path: string }) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(res.filesTouched).toBe(true)
  })

  it('options: turno do Claude que entrou no meio do turno desliga as duas com claude_mid_turn (R20)', async () => {
    const r = repo()
    const p = project(r.dir)
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES ('LC', ?, ?, 'stopped', 'claude')`).run(SID, p.id)
    const id = undo.store.openTurn({ localId: 'LC', projectId: p.id, engine: 'claude', origin: 'operator', textKey: 'no meio', midTurn: true })
    const res = (await options('LC', { turnId: id, text: 'no meio', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: false, reason: 'claude_mid_turn' })
    expect(res.files).toEqual({ enabled: false, reason: 'claude_mid_turn' })
  })

  it('options: terminal aberto no terminal interativo desliga as duas com in_terminal, e o rewind recusa sem relançar', async () => {
    const r = repo()
    const p = project(r.dir)
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES ('LT', ?, ?, 'in_terminal', 'claude')`).run(SID, p.id)
    const id = undo.store.openTurn({ localId: 'LT', projectId: p.id, engine: 'claude', origin: 'operator', textKey: 'oi', conversationId: SID })
    undo.store.setEnd(id, null, 'result', SID)
    const res = (await options('LT', { turnId: id, text: 'oi', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: false, reason: 'in_terminal' })
    expect(res.files).toEqual({ enabled: false, reason: 'in_terminal' })
    const relaunch = vi.spyOn(manager, 'relaunch')
    const done = await rewind('LT', { target: { turnId: id, text: 'oi', occurrence: 0 }, mode: 'conversation', editedText: 'x' })
    expect(done.statusCode).toBe(409)
    expect(done.json()).toMatchObject({ code: 'rewind_unavailable', params: { reason: 'in_terminal' } })
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('options: mensagem do Codex por turn/steer desliga as duas com codex_mid_turn', async () => {
    const r = repo()
    const p = project(r.dir)
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES ('LX', 'T1', ?, 'stopped', 'codex')`).run(p.id)
    const id = undo.store.openTurn({ localId: 'LX', projectId: p.id, engine: 'codex', origin: 'operator', textKey: 'steer', midTurn: true, anchor: 'turn-2' })
    const res = (await options('LX', { turnId: id, text: 'steer', occurrence: 0 })).json()
    expect(res.conversation).toEqual({ enabled: false, reason: 'codex_mid_turn' })
    expect(res.files).toEqual({ enabled: false, reason: 'codex_mid_turn' })
  })

  it('options: mensagem que o motor não acha desliga as duas com anchor_not_found', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    await say(L, 'primeira')
    const res = (await options(L, { text: 'primeira', occurrence: 0 })).json()
    // Sem transcript, o Claude não acha a mensagem.
    expect(res.conversation).toEqual({ enabled: false, reason: 'anchor_not_found' })
    expect(res.files).toEqual({ enabled: false, reason: 'anchor_not_found' })
  })
})

describe('editar a partir daqui: execute', () => {
  it('execute conversation: relança com o corte e manda o texto com a nota conversation rewound quando o trecho mexeu em arquivos', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); const t1 = await say(L, 'primeira')
    const cut = tr.add('bash-escreve:a.txt=mudou'); const t2 = await say(L, 'bash-escreve:a.txt=mudou')
    expect(undo.store.turn(t2)!.summary!.files).toBe(1)
    const relaunch = spyRelaunch()
    const send = vi.spyOn(manager, 'send')

    const res = await rewind(L, { target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation', editedText: 'faz outra coisa' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conversationRewound: true })

    expect(relaunch).toHaveBeenCalledTimes(1)
    const [id, opts] = relaunch.mock.calls[0]
    expect(id).toBe(L)
    expect(opts).toMatchObject({ resumeSessionId: SID, holdEngineId: true })
    const newId = opts.extraArgs![opts.extraArgs!.indexOf('--session-id') + 1]
    expect(opts.extraArgs).toEqual(['--resume-session-at', cut, '--fork-session', '--session-id', newId])
    expect(sentTexts(send)).toEqual([withNote(CONVERSATION_REWOUND_NOTE, 'faz outra coisa')])
    expect(send.mock.calls[0][2]).toEqual({ echo: true })
    // Só a conversa: o arquivo fica como o agente deixou.
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('mudou\n')
    expect(undo.holds(p.id, 'claude')).toBe(false)

    // O primeiro result da conversa nova: o id vai ao banco, o trecho sai da
    // conversa atual e o turno que ficou ganha o rótulo.
    await waitUntil(() => manager.get(L)?.engineSessionId === newId && free(L))
    await undo.idle()
    await waitUntil(() => undo.store.turn(t1)!.conversationId === newId)
    expect(undo.store.turn(t2)!.rewoundAt).not.toBeNull()
    const listed = (await app.inject({ method: 'GET', url: `/api/undo/terminals/${L}/turns` })).json()
    expect(listed.turns.map((t: { id: number }) => t.id)).toContain(t1)
    expect(listed.turns.map((t: { id: number }) => t.id)).not.toContain(t2)
    expect(listed.outside.map((t: { id: number }) => t.id)).toEqual([t2])
  })

  it('execute conversation sem mudanças: texto sem nota', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('segunda'); await say(L, 'segunda')
    spyRelaunch()
    const send = vi.spyOn(manager, 'send')
    const res = await rewind(L, { target: { text: 'segunda', occurrence: 0 }, mode: 'conversation', editedText: 'segunda, editada' })
    expect(res.json()).toEqual({ conversationRewound: true })
    expect(sentTexts(send)).toEqual(['segunda, editada'])
  })

  it('execute conversation_and_files: arquivos primeiro (sem nota files reverted), depois a conversa, depois o envio', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('bash-escreve:a.txt=mudou'); const t2 = await say(L, 'bash-escreve:a.txt=mudou')
    tr.add('bash-escreve:b.txt=tambem'); const t3 = await say(L, 'bash-escreve:b.txt=tambem')
    const opts = (await options(L, { text: 'bash-escreve:a.txt=mudou', occurrence: 0 })).json()
    expect(opts.files.enabled).toBe(true)
    const apply = vi.spyOn(undo.service, 'apply')
    const relaunch = spyRelaunch()
    const send = vi.spyOn(manager, 'send')

    const res = await rewind(L, {
      target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'de novo', token: opts.files.preview.token,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.conversationRewound).toBe(true)
    expect(body.run.files).toEqual([{ path: 'a.txt', result: 'reverted' }, { path: 'b.txt', result: 'reverted' }])
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('b\n')
    // Sem a nota "files reverted": o texto vai sem nota nenhuma.
    expect(apply.mock.calls[0][0].sort()).toEqual([t2, t3].sort())
    expect(apply.mock.calls[0][3]).toEqual({ note: false })
    expect(undo.store.takeNote(p.id, 'claude')).toBeNull()
    expect(sentTexts(send)).toEqual(['de novo'])
    expect(sentTexts(send)[0].startsWith(FILES_REVERTED_PREFIX)).toBe(false)
    // A ordem: arquivos, conversa, envio.
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(relaunch.mock.invocationCallOrder[0])
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
  })

  it('cancelar na prévia de arquivos não faz nada: token velho dá 409 com a prévia e a conversa intacta', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('bash-escreve:a.txt=mudou'); const t1 = await say(L, 'bash-escreve:a.txt=mudou')
    const relaunch = spyRelaunch()
    const send = vi.spyOn(manager, 'send')
    const res = await rewind(L, { target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'x', token: 'velho' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'undo_changed', preview: { turnIds: [t1] } })
    expect(relaunch).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('mudou\n')
    expect(undo.store.turn(t1)!.rewoundAt).toBeNull()
    expect(manager.get(L)?.engineSessionId).toBe(SID)
    expect(undo.holds(p.id, 'claude')).toBe(false)
  })

  it('falha da volta no motor: run devolvido, conversationRewound false e nada enviado', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('bash-escreve:a.txt=mudou'); const t1 = await say(L, 'bash-escreve:a.txt=mudou')
    const opts = (await options(L, { text: 'bash-escreve:a.txt=mudou', occurrence: 0 })).json()
    vi.spyOn(manager, 'relaunch').mockRejectedValue(new Error('o CLI recusou'))
    const send = vi.spyOn(manager, 'send')
    const res = await rewind(L, {
      target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'x', token: opts.files.preview.token,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ conversationRewound: false, error: { code: 'rewind_failed', message: 'o CLI recusou' } })
    expect(body.run.files).toEqual([{ path: 'a.txt', result: 'reverted' }])
    // Os arquivos desfeitos ficam desfeitos; a conversa e os turnos, como estavam.
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(send).not.toHaveBeenCalled()
    expect(undo.store.turn(t1)!.rewoundAt).toBeNull()
    expect(undo.holds(p.id, 'claude')).toBe(false)
    // A conversa ficou: a nota "files reverted" espera a próxima mensagem.
    expect(undo.store.takeNote(p.id, 'claude')).toEqual(['a.txt'])
  })

  it('Claude que morre antes do primeiro result: os turnos do trecho continuam na conversa atual', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); const t1 = await say(L, 'primeira')
    tr.add('segunda'); const t2 = await say(L, 'segunda')
    spyRelaunch()
    // "crash": o CLI falso relançado sai com exit 1 sem result.
    const res = await rewind(L, { target: { text: 'segunda', occurrence: 0 }, mode: 'conversation', editedText: 'segunda crash' })
    expect(res.json()).toEqual({ conversationRewound: true })
    await waitUntil(() => manager.get(L)?.status === 'dead')
    await undo.idle()
    const sent = undo.store.terminalTurns(p.id, 'claude').at(-1)!
    await waitUntil(() => undo.store.turn(sent.id)!.endedAt !== null)
    await undo.idle()
    // O banco segue no id antigo, e o trecho não saiu da conversa.
    expect(manager.get(L)?.engineSessionId).toBe(SID)
    expect(undo.store.turn(t2)!.rewoundAt).toBeNull()
    expect(undo.store.turn(t1)!.conversationId).toBe(SID)
    const listed = (await app.inject({ method: 'GET', url: `/api/undo/terminals/${L}/turns` })).json()
    expect(listed.turns.map((t: { id: number }) => t.id)).toEqual(expect.arrayContaining([t1, t2]))
    expect(listed.outside.map((t: { id: number }) => t.id)).not.toContain(t2)
    // Editar de novo a mesma mensagem não cai em rewind_turn_outside.
    const again = await options(L, { turnId: t2, text: 'segunda', occurrence: 0 })
    expect(again.statusCode).toBe(200)
    expect(again.json().conversation).toEqual({ enabled: true })
  })

  it('Claude com arquivos desfeitos que morre antes do primeiro result: a nota "files reverted" espera a próxima mensagem', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('bash-escreve:a.txt=mudou'); const t2 = await say(L, 'bash-escreve:a.txt=mudou')
    const opts = (await options(L, { text: 'bash-escreve:a.txt=mudou', occurrence: 0 })).json()
    spyRelaunch()
    const res = await rewind(L, {
      target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'de novo crash', token: opts.files.preview.token,
    })
    expect(res.json()).toMatchObject({ conversationRewound: true })
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')
    // Enquanto a conversa nova não confirma nem cai, sem nota.
    expect(undo.store.takeNote(p.id, 'claude')).toBeNull()
    await waitUntil(() => manager.get(L)?.status === 'dead')
    await undo.idle()
    const sent = undo.store.terminalTurns(p.id, 'claude').at(-1)!
    await waitUntil(() => undo.store.turn(sent.id)!.endedAt !== null)
    await undo.idle()
    // A conversa ficou a antiga, mas os arquivos voltaram: o agente precisa saber.
    expect(undo.store.turn(t2)!.rewoundAt).toBeNull()
    expect(undo.store.takeNote(p.id, 'claude')).toEqual(['a.txt'])
  })

  it('Claude com arquivos desfeitos cuja conversa nova confirma: sem nota "files reverted"', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('bash-escreve:a.txt=mudou'); const t2 = await say(L, 'bash-escreve:a.txt=mudou')
    const opts = (await options(L, { text: 'bash-escreve:a.txt=mudou', occurrence: 0 })).json()
    spyRelaunch()
    const res = await rewind(L, {
      target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'de novo', token: opts.files.preview.token,
    })
    expect(res.json()).toMatchObject({ conversationRewound: true })
    await waitUntil(() => undo.store.turn(t2)!.rewoundAt !== null)
    await undo.idle()
    expect(undo.store.takeNote(p.id, 'claude')).toBeNull()
  })

  it('Claude voltando à primeira mensagem (conversa nova): o trecho sai da conversa só no primeiro result', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); const t1 = await say(L, 'primeira')
    const real = manager.relaunch.bind(manager)
    vi.spyOn(manager, 'relaunch').mockImplementation(async (localId, opts) => {
      process.env.FAKE_SESSION_ID = 'fake-session-nova'
      return real(localId, opts)
    })
    const res = await rewind(L, { target: { text: 'primeira', occurrence: 0 }, mode: 'conversation', editedText: 'outra primeira' })
    expect(res.json()).toEqual({ conversationRewound: true })
    await waitUntil(() => manager.get(L)?.engineSessionId === 'fake-session-nova' && free(L))
    await undo.idle()
    await waitUntil(() => undo.store.turn(t1)!.rewoundAt !== null)
  })

  it('com o agente trabalhando: interrompe antes e espera livre', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('demorada')
    manager.send(L, 'demorada')
    await waitUntil(() => manager.get(L)?.status === 'working')
    await undo.idle()
    const running = undo.store.terminalTurns(p.id, 'claude').at(-1)!
    expect(running.endedAt).toBeNull()
    const interrupt = vi.spyOn(manager, 'interrupt')
    const relaunch = spyRelaunch()
    const send = vi.spyOn(manager, 'send')

    const opts = (await options(L, { text: 'demorada', occurrence: 0 })).json()
    expect(opts).toMatchObject({ working: true, conversation: { enabled: true }, files: { enabled: true } })
    expect(opts.files.preview).toBeUndefined()

    const res = await rewind(L, { target: { text: 'demorada', occurrence: 0 }, mode: 'conversation', editedText: 'rápida' })
    expect(res.json()).toEqual({ conversationRewound: true })
    expect(interrupt).toHaveBeenCalledWith(L)
    expect(interrupt.mock.invocationCallOrder[0]).toBeLessThan(relaunch.mock.invocationCallOrder[0])
    // O turno interrompido fechou antes da volta e saiu da conversa.
    const done = undo.store.turn(running.id)!
    // O fim é do rastreador: o result interrompido do CLI falso chega depois do status.
    expect(['interrupted', 'cut']).toContain(done.endKind)
    expect(sentTexts(send)).toEqual(['rápida'])
    await waitUntil(() => undo.store.turn(running.id)!.rewoundAt !== null)
  })

  it('holds verdadeiro durante a volta: a fila do operador não entrega no meio', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    tr.add('segunda'); await say(L, 'segunda')
    const send = vi.spyOn(manager, 'send')
    const real = manager.relaunch.bind(manager)
    const seen: { holds?: boolean; intrusa?: unknown } = {}
    vi.spyOn(manager, 'relaunch').mockImplementation(async (localId, opts) => {
      // No meio da volta: um item entra na fila e o "livre" chega ao árbitro.
      seen.holds = undo.holds(p.id, 'claude')
      queue!.add(p.id, 'claude', 'da fila')
      nextSend!.onSessionAvailable({ projectId: p.id, engine: 'claude', localId: L })
      try { manager.send(L, 'intrusa') } catch (e) { seen.intrusa = e }
      const at = opts.extraArgs!.indexOf('--session-id')
      process.env.FAKE_SESSION_ID = opts.extraArgs![at + 1]
      return real(localId, opts)
    })

    const res = await rewind(L, { target: { text: 'segunda', occurrence: 0 }, mode: 'conversation', editedText: 'editada' })
    expect(res.json()).toEqual({ conversationRewound: true })
    expect(seen.holds).toBe(true)
    expect(seen.intrusa).toBeInstanceOf(UserError)
    expect((seen.intrusa as UserError).code).toBe('rewind_in_progress')
    expect(undo.holds(p.id, 'claude')).toBe(false)
    // O item esperou a volta e sai depois do texto editado, no "livre" seguinte.
    await waitUntil(() => sentTexts(send).includes('da fila'))
    expect(sentTexts(send).filter(t => t !== 'intrusa')).toEqual(['editada', 'da fila'])
  })

  it('turnos do trecho vão para fora da conversa atual e continuam desfazíveis', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); const t1 = await say(L, 'primeira')
    tr.add('bash-escreve:a.txt=mudou'); const t2 = await say(L, 'bash-escreve:a.txt=mudou')
    spyRelaunch()
    await rewind(L, { target: { text: 'bash-escreve:a.txt=mudou', occurrence: 0 }, mode: 'conversation', editedText: 'outra' })
    await waitUntil(() => free(L) && undo.store.turn(t1)!.conversationId !== SID)
    await undo.idle()
    const listed = (await app.inject({ method: 'GET', url: `/api/undo/terminals/${L}/turns` })).json()
    expect(listed.outside.map((t: { id: number }) => t.id)).toEqual([t2])

    const preview = (await post('/api/undo/preview', { turnIds: [t2] })).json()
    const run = (await post('/api/undo/apply', { turnIds: [t2], token: preview.token, decisions: {} })).json()
    expect(run.files).toEqual([{ path: 'a.txt', result: 'reverted' }])
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('mensagem do operador pausa o goal', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    const state = createTerminalStateStore(db)
    state.startGoal(p.id, 'claude', 'terminar o trabalho')
    spyRelaunch()
    await rewind(L, { target: { text: 'primeira', occurrence: 0 }, mode: 'conversation', editedText: 'outra primeira' })
    expect(state.get(p.id, 'claude')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
    // O primeiro turno da conversa nova termina antes do fim do teste.
    await waitUntil(() => manager.get(L)?.engineSessionId !== SID && free(L))
  })

  it('opção desligada: rewind recusa com rewind_unavailable sem interromper nem relançar', async () => {
    const dir = makeTempDir('claudinei-rewind-nogit-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const p = project(dir)
    const L = await start(p)
    const tr = transcriptOf(p)
    tr.add('primeira'); await say(L, 'primeira')
    const relaunch = spyRelaunch()
    const res = await rewind(L, { target: { text: 'primeira', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'x', token: 't' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'rewind_unavailable', params: { reason: 'no_git' } })
    expect(relaunch).not.toHaveBeenCalled()
    expect(undo.holds(p.id, 'claude')).toBe(false)
  })
})

describe('CLI falso: escreve e bash-escreve', () => {
  it('escreve: e bash-escreve: do fake geram turno com diff; só o primeiro declara', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const t1 = await say(L, 'escreve:novo/a.txt=um')
    const t2 = await say(L, 'bash-escreve:b.txt=dois')
    expect(readFileSync(join(r.dir, 'novo/a.txt'), 'utf8')).toBe('um\n')
    expect(readFileSync(join(r.dir, 'b.txt'), 'utf8')).toBe('dois\n')
    expect(undo.store.turn(t1)!.declared).toEqual(['novo/a.txt'])
    expect(undo.store.turn(t2)!.declared).toEqual([])
    for (const [t, path] of [[t1, 'novo/a.txt'], [t2, 'b.txt']] as const) {
      expect(undo.store.turn(t)!.snapshot).toBe('ok')
      const files = (await app.inject({ method: 'GET', url: `/api/undo/turns/${t}/files` })).json()
      expect(files.files.map((f: { path: string }) => f.path)).toEqual([path])
      const diff = (await app.inject({ method: 'GET', url: `/api/undo/turns/${t}/diff?path=${encodeURIComponent(path)}` })).json()
      expect(diff.text).toContain(path === 'b.txt' ? '+dois' : '+um')
    }
  })
})

describe('idle do desfazer', () => {
  it('idle espera também o resumo do turno que fechou (nada roda depois do fim do teste)', async () => {
    const r = repo()
    const p = project(r.dir)
    const L = await start(p)
    const real = undo.service.summarizeTurn.bind(undo.service)
    vi.spyOn(undo.service, 'summarizeTurn').mockImplementation(async (id) => {
      await new Promise(res => setTimeout(res, 150))
      return real(id)
    })
    manager.send(L, 'bash-escreve:a.txt=mudou')
    await waitUntil(() => free(L))
    const id = undo.store.terminalTurns(p.id, 'claude').at(-1)!.id
    await waitUntil(() => undo.store.turn(id)!.endedAt !== null)
    await undo.idle()
    expect(undo.store.turn(id)!.summary).toMatchObject({ files: 1 })
  })
})

describe('createRewindService (unidade)', () => {
  it('locate que lança (conversa ocupada, transcript ilegível) vira anchor_not_found, nunca 500', async () => {
    const udb = openDb(':memory:')
    const store = createUndoStore(udb)
    const adapter: RewindAdapter = {
      locate: async () => { throw new Error('codex: operação em curso') },
      apply: async () => ({}),
    }
    const svc = createRewindService({
      manager: { get: () => ({ localId: 'L', projectId: 1, engine: 'codex', status: 'working', engineSessionId: 'T1' }) as any, interrupt: vi.fn(), send: vi.fn() },
      store, undo: { preview: vi.fn(), apply: vi.fn() } as any, adapters: { codex: adapter },
      projects: { get: () => ({ id: 1, name: 'P', path: '/nao/existe' }) },
      resolver: { get: async () => null }, nextSend: () => undefined, log: () => {},
    })
    const res = await svc.options('L', { text: 'oi', occurrence: 0 }, { isAdmin: true, projectIds: 'all' })
    expect(res.conversation).toEqual({ enabled: false, reason: 'anchor_not_found' })
    expect(res.files).toEqual({ enabled: false, reason: 'anchor_not_found' })
    expect(res.working).toBe(true)
  })

  /** O serviço com um adaptador do Claude espiado e três turnos "continue", o último no meio do turno. */
  function sameTextTurns() {
    const udb = openDb(':memory:')
    const store = createUndoStore(udb)
    const dir = makeTempDir('claudinei-rewind-unit-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    createProjectsService(udb).create({ name: 'P', path: dir })
    const open = (over: Partial<Parameters<typeof store.openTurn>[0]>) => {
      const id = store.openTurn({ localId: 'L', projectId: 1, engine: 'claude', origin: 'operator', textKey: 'continue', conversationId: 'S1', ...over })
      store.setEnd(id, null, 'result', (over.conversationId as string | undefined) ?? 'S1')
      return id
    }
    const a = open({})
    const b = open({})
    // Turno de mesmo texto que já saiu da conversa (outra conversa): não conta.
    open({ conversationId: 'VELHA' })
    const c = open({ midTurn: true })
    const locate = vi.fn<RewindAdapter['locate']>(async () => ({ kind: 'claude', parentUuid: null }))
    const svc = createRewindService({
      manager: { get: () => ({ localId: 'L', projectId: 1, engine: 'claude', status: 'idle', engineSessionId: 'S1' }) as any, interrupt: vi.fn(), send: vi.fn() },
      store, undo: { preview: vi.fn(), apply: vi.fn() } as any, adapters: { claude: { locate, apply: vi.fn(async () => ({})) } },
      projects: { get: () => ({ id: 1, name: 'P', path: '/nao/existe' }) },
      resolver: { get: async () => null }, nextSend: () => undefined, log: () => {},
    })
    return { svc, locate, store, a, b, c }
  }
  const admin = { isAdmin: true, projectIds: 'all' as const }

  it('R22: com turnId, a chave e a ocorrência saem das linhas de turno (a enfileirada conta), não da web', async () => {
    const { svc, locate, a, b } = sameTextTurns()
    // A web não vê a mensagem enfileirada de C depois de recarregar: manda 1.
    await svc.options('L', { turnId: a, text: 'continue', occurrence: 1 }, admin)
    expect(locate).toHaveBeenLastCalledWith(expect.objectContaining({ turn: expect.objectContaining({ id: a }) }), 'continue', 2)
    // Ocorrência e texto da web ignorados de todo.
    await svc.options('L', { turnId: a, text: '[WIP] continue', occurrence: 0 }, admin)
    expect(locate).toHaveBeenLastCalledWith(expect.anything(), 'continue', 2)
    await svc.options('L', { turnId: b, text: 'continue', occurrence: 7 }, admin)
    expect(locate).toHaveBeenLastCalledWith(expect.objectContaining({ turn: expect.objectContaining({ id: b }) }), 'continue', 1)
  })

  it('R22: sem turnId (mensagem anterior ao recurso), vale a ocorrência da web', async () => {
    const { svc, locate } = sameTextTurns()
    await svc.options('L', { text: 'continue', occurrence: 1 }, admin)
    expect(locate).toHaveBeenLastCalledWith(expect.anything(), 'continue', 1)
  })

  it('R23: turno interativo depois do alvo no mesmo terminal desliga as duas no Claude com anchor_not_found', async () => {
    const { svc, locate, store, a, b } = sameTextTurns()
    // O operador abriu o terminal interativo depois de B: o que digitou lá não virou turno.
    const i = store.openTurn({ localId: 'L', projectId: 1, engine: 'claude', origin: 'interactive' })
    store.setEnd(i, null, 'stopped', null)
    locate.mockClear()
    const res = await svc.options('L', { turnId: b, text: 'continue', occurrence: 0 }, admin)
    expect(res.conversation).toEqual({ enabled: false, reason: 'anchor_not_found' })
    expect(res.files).toEqual({ enabled: false, reason: 'anchor_not_found' })
    expect(locate).not.toHaveBeenCalled()
    await expect(svc.execute('L', { target: { turnId: a, text: 'continue', occurrence: 0 }, mode: 'conversation', editedText: 'x' }, admin))
      .rejects.toMatchObject({ code: 'rewind_unavailable', params: { reason: 'anchor_not_found' } })
  })

  it('R23: turno interativo antes do alvo não atrapalha', async () => {
    const udb = openDb(':memory:')
    const store = createUndoStore(udb)
    const dir = makeTempDir('claudinei-rewind-unit-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    createProjectsService(udb).create({ name: 'P', path: dir })
    const i = store.openTurn({ localId: 'L', projectId: 1, engine: 'claude', origin: 'interactive' })
    store.setEnd(i, null, 'stopped', null)
    const t = store.openTurn({ localId: 'L', projectId: 1, engine: 'claude', origin: 'operator', textKey: 'oi', conversationId: 'S1' })
    store.setEnd(t, null, 'result', 'S1')
    const locate = vi.fn<RewindAdapter['locate']>(async () => ({ kind: 'claude', parentUuid: null }))
    const svc = createRewindService({
      manager: { get: () => ({ localId: 'L', projectId: 1, engine: 'claude', status: 'idle', engineSessionId: 'S1' }) as any, interrupt: vi.fn(), send: vi.fn() },
      store, undo: { preview: vi.fn(), apply: vi.fn() } as any, adapters: { claude: { locate, apply: vi.fn(async () => ({})) } },
      projects: { get: () => ({ id: 1, name: 'P', path: '/nao/existe' }) },
      resolver: { get: async () => null }, nextSend: () => undefined, log: () => {},
    })
    const res = await svc.options('L', { turnId: t, text: 'oi', occurrence: 0 }, admin)
    expect(res.conversation).toEqual({ enabled: true })
    expect(locate).toHaveBeenCalledTimes(1)
  })

  it('codex com fork: os turnos que ficam passam ao id novo na hora', async () => {
    const udb = openDb(':memory:')
    const store = createUndoStore(udb)
    const dir = makeTempDir('claudinei-rewind-unit-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    createProjectsService(udb).create({ name: 'P', path: dir })
    const t1 = store.openTurn({ localId: 'L', projectId: 1, engine: 'codex', origin: 'operator', textKey: 'um', conversationId: 'T1', anchor: 'a1' })
    const t2 = store.openTurn({ localId: 'L', projectId: 1, engine: 'codex', origin: 'operator', textKey: 'dois', conversationId: 'T1', anchor: 'a2' })
    for (const t of [t1, t2]) store.setEnd(t, null, 'result', 'T1')
    const adapter: RewindAdapter = {
      locate: async (ctx) => ({ kind: 'codex', beforeTurnId: ctx.turn!.anchor!, previousTurnId: 'a1', midTurn: false }),
      apply: vi.fn(async () => ({ newConversationId: 'FORK-1' })),
    }
    const send = vi.fn()
    const poke = vi.fn()
    const svc = createRewindService({
      manager: { get: () => ({ localId: 'L', projectId: 1, engine: 'codex', status: 'idle', engineSessionId: 'T1' }) as any, interrupt: vi.fn(), send },
      store, undo: { preview: vi.fn(), apply: vi.fn() } as any, adapters: { codex: adapter },
      projects: { get: () => ({ id: 1, name: 'P', path: '/nao/existe' }) },
      resolver: { get: async () => null }, nextSend: () => ({ poke }), log: () => {},
    })
    const res = await svc.execute('L', { target: { text: 'dois', occurrence: 0 }, mode: 'conversation', editedText: 'dois editado' }, { isAdmin: true, projectIds: 'all' })
    expect(res).toEqual({ conversationRewound: true })
    expect(store.turn(t1)!.conversationId).toBe('FORK-1')
    expect(store.turn(t2)!.rewoundAt).not.toBeNull()
    expect(send).toHaveBeenCalledWith('L', 'dois editado', { echo: true })
    expect(poke).toHaveBeenCalledWith(1, 'codex')
  })
})
