import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import type { Undo } from '../src/undo/index.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import type { SessionStatus } from '../src/claude/session.js'
import { buildClaudeArgs } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createGroupsService } from '../src/groups.js'
import type { EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { codexEngine } from '../src/engine/codex/codex-engine.js'
import { transcriptPath } from '../src/history.js'
import { claudeBranchArgs } from '../src/branch/engine-args.js'
import { cutFor as realCutFor, type CutPoint } from '../src/branch/cut.js'
import { collectHandoff, HANDOFF_PREFIX, type Handoff } from '../src/branch/handoff.js'
import { branchName } from '../src/branch/fork.js'
import type { BranchService } from '../src/branch/service.js'
import { isSharedPath } from '../src/project-threads.js'
import type { NextSend } from '../src/queue/next-send.js'

/**
 * O ramo (`/fork`): terminal irmão na mesma pasta com a cópia da conversa até o
 * último turno fechado. As sessões são falsas (em memória) e o storage dos
 * motores vive em diretórios temporários (CLAUDE_CONFIG_DIR, CODEX_HOME):
 * nunca a CLI real, nunca o ~/.claude ou o ~/.codex.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const CODEX_FIX = join(__dirname, 'fixtures', 'branch', 'codex-rollout.jsonl')

const SRC = '11111111-1111-4111-8111-111111111111'
const CODEX_ID = '019f0000-0000-7000-8000-00000000c0de'
const T2 = '019f0000-0000-7000-8000-0000000000t2'
/** Id que o `thread/fork` devolve ao ramo do Codex. */
const FORK_ID = '019f0000-0000-7000-8000-0000000f0f0f'
const U = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`

/** Sessão falsa: grava o que recebe e deixa o teste mandar no status e nos eventos. */
class FakeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  lastStderr = ''
  writes: Array<{ text: string; echo: boolean }> = []
  /** Lido na criação: as sessões de um teste de Kimi ou OpenCode recusam como os motores reais. */
  readonly refusesMidTurn = recusaNoTurno
  constructor(readonly opts: EngineSessionOptions) { super() }
  set(s: SessionStatus) { if (this.status !== s) { this.status = s; this.emit('status', s) } }
  start(): void { this.set('idle') }
  send(text: string, o?: { echoToClients?: boolean }): void {
    // Kimi e OpenCode recusam mensagem no meio do turno (opencode-session.ts e
    // kimi-session.ts); Claude e Codex a aceitam. Opção por teste (`recusaNoTurno`).
    if (this.refusesMidTurn && this.status === 'working') throw new Error('turno em andamento')
    this.writes.push({ text, echo: !!o?.echoToClients })
    this.set('working')
  }
  init(id: string) {
    this.sessionId = id
    this.emit('event', { kind: 'init', sessionId: id, model: 'm', slashCommands: [], raw: {} })
  }
  result(isError = false) {
    this.emit('event', { kind: 'result', subtype: isError ? 'error' : 'success', isError, resultText: '', costUsd: 0, raw: {} })
    this.set('idle')
  }
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.set('stopped') }
}

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDINEI_OPENCODE_BIN', 'CLAUDINEI_KIMI_HOMES', 'KIMI_CODE_HOME'] as const
let envAntes: Record<string, string | undefined>
let tmp: string
let db: Db
let app: Awaited<ReturnType<typeof buildApp>>
let auth: AuthService
let manager: ReturnType<typeof createSessionManager>
let branch: BranchService | undefined
let undo: Undo | undefined
/** O árbitro do próximo envio: o desfazer o cutuca quando solta a pasta. */
let nextSend: NextSend | undefined
let created: FakeSession[]
/** As sessões falsas criadas daqui em diante recusam mensagem no meio do turno (Kimi, OpenCode). */
let recusaNoTurno = false
/** O que o servidor transmitiu às telas (os avisos `message_error` no chat do terminal). */
let broadcasts: any[]
/** A montagem do pacote falha (o storage do motor ilegível, por exemplo). */
let collectError: Error | null
/** Cada "livre" do manager, com o status da sessão na hora (o árbitro da fila só entrega se ela não está trabalhando). */
let available: Array<{ localId?: string; status?: string }>
let collectCalls: Array<{ engine: string; id: string; opts: { working: boolean; before?: number } }>
let fakeCuts: Record<string, CutPoint | null>
let fakePacks: Record<string, Handoff | null>
let projects: ReturnType<typeof createProjectsService>
let p1: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

const novaPasta = (nome: string) => { const d = join(tmp, `${nome}-${Math.random().toString(36).slice(2)}`); mkdirSync(d); return d }

beforeEach(async () => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'branch-fork-'))
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
  process.env.CODEX_HOME = join(tmp, 'codex')
  process.env.CLAUDINEI_OPENCODE_BIN = join(tmp, 'nao-existe-opencode')
  process.env.CLAUDINEI_KIMI_HOMES = join(tmp, 'kimi-homes')
  process.env.KIMI_CODE_HOME = join(tmp, 'kimi-home')
  db = openDb(':memory:')
  auth = createAuthService({ db })
  created = []
  recusaNoTurno = false
  broadcasts = []
  collectError = null
  available = []
  collectCalls = []
  fakeCuts = {}
  fakePacks = {}
  branch = undefined
  nextSend = undefined
  manager = createSessionManager({
    db, broadcast: () => {},
    sessionFactory: (opts) => { const s = new FakeSession(opts); created.push(s); return s },
    // Como o index.ts: os ganchos chegam ao serviço pela referência.
    onTurnResult: (p, e) => branch?.onTurnResult(p, e),
    onSessionDied: (p, e) => branch?.onSessionDied(p, e),
    onSessionEnded: (p, e, l) => branch?.onSessionEnded(p, e, l),
    onOperatorMessage: (p, e, i) => branch?.onOperatorMessage(p, e, i),
    onSessionAvailable: (_p, ctx) => { available.push({ localId: ctx?.localId, status: ctx && manager.get(ctx.localId)?.status }) },
  })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: unknown) => { broadcasts.push(m) }, register: () => {} } as never,
    onBranchReady: (b) => { branch = b },
    onUndoReady: (u) => { undo = u },
    onNextSendReady: (n) => { nextSend = n },
    branchTest: {
      // Claude e Codex usam o corte e o pacote de verdade, sobre o storage temporário.
      cutFor: async (engine, path, id, opts) => engine in fakeCuts ? fakeCuts[engine] : realCutFor(engine, path, id, opts),
      collect: async (engine, path, id, opts) => {
        collectCalls.push({ engine: engine.id, id, opts })
        if (collectError) throw collectError
        return engine.id in fakePacks ? fakePacks[engine.id] : collectHandoff(engine, path, id, opts)
      },
    },
  })
  projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: novaPasta('alfa') })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  await branch?.dispose()
  await manager.stopAll()
  await app.close()
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

// ---------- storage falso dos motores ----------

const iso = (ms: number) => new Date(ms).toISOString()
const linhaClaude = (type: 'user' | 'assistant', uuid: string, text: string, at: number) => JSON.stringify(
  type === 'user'
    ? { type, uuid, timestamp: iso(at), message: { role: 'user', content: text } }
    : { type, uuid, timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }] } },
) + '\n'

/** Transcript do Claude de `id` na pasta `path`, sob o CLAUDE_CONFIG_DIR temporário. */
function transcript(path: string, id: string, linhas: string[], append = false): string {
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, path, id)
  mkdirSync(dirname(file), { recursive: true })
  if (append) appendFileSync(file, linhas.join(''))
  else writeFileSync(file, linhas.join(''))
  return file
}

/** Dois turnos fechados há um minuto: o corte é a resposta dois (U(4)). */
function doisTurnos(path: string, id = SRC) {
  const t = Date.now() - 60_000
  return transcript(path, id, [
    linhaClaude('user', U(1), 'pergunta um', t),
    linhaClaude('assistant', U(2), 'resposta um', t + 1000),
    linhaClaude('user', U(3), 'pergunta dois', t + 2000),
    linhaClaude('assistant', U(4), 'resposta dois', t + 3000),
  ])
}

/** Rollout do Codex na árvore YYYY/MM/DD do CODEX_HOME temporário. */
function rollout(dia: string, conteudo: string | null, mtime: number): string {
  const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', dia)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-11-${dia}T10-00-00-${CODEX_ID}.jsonl`)
  if (conteudo === null) copyFileSync(CODEX_FIX, file)
  else writeFileSync(file, conteudo)
  utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

// ---------- atalhos ----------

/** Sobe a sessão principal do terminal e dá a ela a conversa `id` (o init). */
function startMain(project: Project, engine: string, id: string, opts: { model?: string; effort?: string } = {}) {
  const info = manager.start(project, { engine, ...opts })
  const s = created.at(-1)!
  s.init(id)
  return { localId: info.localId, s }
}

const fork = (pid: number, payload: object, cookies = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/fork`, cookies, payload })

const forkOk = async (pid: number, payload: object) => {
  const res = await fork(pid, payload)
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { project: Project; session: { localId: string; projectId: number; engine: string } }
}

const rowOf = (localId: string) =>
  db.prepare('SELECT fork_source, claude_session_id, continue_latest FROM sessions WHERE local_id=?').get(localId) as
    { fork_source: string | null; claude_session_id: string | null; continue_latest: number }

const history = (localId: string, before?: number) =>
  app.inject({ method: 'GET', url: `/api/sessions/${localId}/history${before !== undefined ? `?before=${before}` : ''}`, cookies: adminCookie })

const tick = () => new Promise((r) => setTimeout(r, 20))

/**
 * Depois da cópia recusada, o ramo revivido continua no `live` do manager:
 * aparece ativo e a próxima mensagem do operador chega à sessão nova (e não
 * cai em `session_not_active`).
 */
function ramoSegueVivo(localId: string) {
  const s = created.at(-1)!
  expect(manager.list().find((x) => x.localId === localId)?.status).toMatch(/^(starting|idle|working|needs_attention)$/)
  expect(() => manager.send(localId, 'e agora?')).not.toThrow()
  expect(s.writes.at(-1)).toEqual({ text: 'e agora?', echo: false })
}

/** Os avisos de mensagem não entregue (ou de contexto que faltou) no chat do terminal. */
const avisosNoChat = (localId: string): string[] => broadcasts
  .filter((b) => b?.type === 'session_event' && b.localId === localId && b.event?.subtype === 'message_error')
  .map((b) => b.event.raw.message as string)

/** A fila gravada do operador de um terminal. */
const filaDe = (projectId: number, engine: string) => ({
  texts: (db.prepare('SELECT text FROM operator_queue WHERE project_id=? AND engine=? ORDER BY position, id').all(projectId, engine) as Array<{ text: string }>).map((r) => r.text),
  paused: (db.prepare('SELECT paused FROM operator_queue_state WHERE project_id=? AND engine=?').get(projectId, engine) as { paused: number } | undefined)?.paused === 1,
})

// ---------- testes ----------

describe('branchName', () => {
  it('"X (ramo)", depois "X (ramo 2)"; só espaços cai no padrão; nome dado vale como está', () => {
    expect(branchName('X', ['X'])).toBe('X (ramo)')
    expect(branchName('X', ['X', 'X (ramo)'])).toBe('X (ramo 2)')
    expect(branchName('X', ['X', 'X (ramo)', 'X (ramo 2)'])).toBe('X (ramo 3)')
    expect(branchName('X', ['X (ramo)', 'X (ramo 3)'])).toBe('X (ramo 2)')
    expect(branchName('X', ['X'], '   ')).toBe('X (ramo)')
    expect(branchName('X', ['X'], '')).toBe('X (ramo)')
    expect(branchName('X', ['X', 'Meu ramo'], 'Meu ramo')).toBe('Meu ramo')
    expect(branchName('X', ['X'], 'X')).toBe('X')
  })
})

describe('o terminal do ramo', () => {
  it('posição logo abaixo do original, mesmo grupo e setor, cor, ícone e heads_up', async () => {
    const groups = createGroupsService(db)
    const g = groups.create('G')
    const s = groups.createSector('S')
    const b = projects.create({ name: 'Beta', path: novaPasta('beta') })
    const c = projects.create({ name: 'Gama', path: novaPasta('gama') })
    const d = projects.create({ name: 'Delta', path: novaPasta('delta') })
    const s2 = groups.createSector('S2')
    // Raiz: [S: [G: [Alfa, Beta], Gama]], Delta, S2.
    groups.applySidebarOrder([
      { kind: 'sector', id: s.id, children: [{ kind: 'group', id: g.id, children: [p1.id, b.id] }, { kind: 'project', id: c.id }] },
      { kind: 'project', id: d.id },
      { kind: 'sector', id: s2.id, children: [] },
    ])
    db.prepare(`UPDATE projects SET color='#123456', icon='🚀', heads_up=0 WHERE id=?`).run(p1.id)
    doisTurnos(p1.path)
    startMain(projects.get(p1.id)!, 'claude', SRC)

    const { project } = await forkOk(p1.id, { engine: 'claude' })
    const antes = projects.get(p1.id)!
    expect(project).toMatchObject({
      name: 'Alfa (ramo)', path: p1.path, color: '#123456', icon: '🚀', headsUp: false,
      groupId: g.id, sectorId: null, sortOrder: antes.sortOrder + 1, forkedFrom: p1.id, favorite: false,
    })
    expect(project.forkedCutAt).toBeTruthy()
    // A ordem relativa de todo o resto continua; o ramo entra entre Alfa e Beta.
    const ordem = (sql: string) => (db.prepare(sql).all() as Array<{ k: string }>).map((r) => r.k)
    expect(ordem(`SELECT 'p' || id AS k FROM projects WHERE group_id=${g.id} ORDER BY sort_order`))
      .toEqual([`p${p1.id}`, `p${project.id}`, `p${b.id}`])
    const raiz = ordem(`SELECT k FROM (
        SELECT 's' || id AS k, sort_order AS o FROM sectors
        UNION ALL SELECT 'g' || id, sort_order FROM project_groups
        UNION ALL SELECT 'p' || id, sort_order FROM projects WHERE group_id IS NULL
      ) ORDER BY o`)
    expect(raiz).toEqual([`s${s.id}`, `g${g.id}`, `p${c.id}`, `p${d.id}`, `s${s2.id}`])

    // Terminal solto num setor: o ramo fica no mesmo setor, logo abaixo.
    doisTurnos(c.path)
    startMain(projects.get(c.id)!, 'claude', SRC)
    const r2 = (await forkOk(c.id, { engine: 'claude', name: 'Gama B' })).project
    expect(r2).toMatchObject({ name: 'Gama B', sectorId: s.id, groupId: null, sortOrder: projects.get(c.id)!.sortOrder + 1 })
    expect(projects.get(d.id)!.sortOrder).toBeGreaterThan(r2.sortOrder)
  })

  it('motor do ramo garantido na lista de motores', async () => {
    projects.setEngines(p1.id, ['codex'])
    doisTurnos(p1.path)
    startMain(projects.get(p1.id)!, 'claude', SRC)
    const { project } = await forkOk(p1.id, { engine: 'claude' })
    expect(project.engines).toEqual(['claude', 'codex'])
  })

  it('user_projects copiados: quem via o original vê o ramo', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project } = await forkOk(p1.id, { engine: 'claude' })
    const lista = (await app.inject({ method: 'GET', url: '/api/projects', cookies: anaCookie })).json() as Project[]
    expect(lista.map((p) => p.id).sort()).toEqual([p1.id, project.id].sort())
  })

  it('não herda: terminal_state sem linha, fila vazia, nenhum agendamento, nenhuma triagem', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    db.prepare(`INSERT INTO terminal_state (project_id, engine, autostart, auto_resume) VALUES (?, 'claude', 1, 1)`).run(p1.id)
    db.prepare(`INSERT INTO operator_queue (project_id, engine, position, text) VALUES (?, 'claude', 1, 'na fila')`).run(p1.id)
    db.prepare(`INSERT INTO schedules (project_id, name, task, cadence) VALUES (?, 'ag', 'faz', '{}')`).run(p1.id)
    db.prepare(`INSERT INTO user_triage (user_id, project_id, pinned_at) VALUES (1, ?, datetime('now'))`).run(p1.id)
    db.prepare(`INSERT INTO tasks (to_project_id, description) VALUES (?, 'tarefa')`).run(p1.id)
    db.prepare('UPDATE projects SET favorite=1 WHERE id=?').run(p1.id)
    const { project } = await forkOk(p1.id, { engine: 'claude' })
    for (const sql of [
      'SELECT COUNT(*) AS n FROM terminal_state WHERE project_id=?',
      'SELECT COUNT(*) AS n FROM operator_queue WHERE project_id=?',
      'SELECT COUNT(*) AS n FROM operator_queue_state WHERE project_id=?',
      'SELECT COUNT(*) AS n FROM schedules WHERE project_id=?',
      'SELECT COUNT(*) AS n FROM user_triage WHERE project_id=?',
      'SELECT COUNT(*) AS n FROM tasks WHERE to_project_id=?',
    ]) expect((db.prepare(sql).get(project.id) as { n: number }).n, sql).toBe(0)
    expect(project.favorite).toBe(false)
  })

  it('não admin: 403 fork_admin_only', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const antes = projects.list().length
    const res = await fork(p1.id, { engine: 'claude' }, anaCookie)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('fork_admin_only')
    expect(projects.list()).toHaveLength(antes)
  })

  it('sem conversa: 409 no_conversation e nenhum terminal criado; corpo inválido: 400', async () => {
    const antes = projects.list().length
    let res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('no_conversation')
    // Claude trabalhando no primeiro turno: nada fechado para copiar.
    const { localId, s } = startMain(p1, 'claude', SRC)
    manager.send(localId, 'primeira')
    expect(s.status).toBe('working')
    const t = Date.now() + 1000
    transcript(p1.path, SRC, [linhaClaude('user', U(1), 'primeira', t)])
    res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('no_conversation')
    expect(projects.list()).toHaveLength(antes)
    expect((await fork(p1.id, { engine: 'nada' })).statusCode).toBe(400)
    expect((await fork(p1.id, { engine: 'claude', name: 3 })).statusCode).toBe(400)
    expect((await fork(9999, { engine: 'claude' })).statusCode).toBe(404)
  })

  it('sessão viva ainda sem id (conversa nova): no_conversation, sem copiar a conversa antiga do banco', async () => {
    const VELHA = '22222222-2222-4222-8222-222222222222'
    doisTurnos(p1.path, VELHA)
    const velha = startMain(p1, 'claude', VELHA)
    await manager.stop(velha.localId)
    // Conversa nova de pé, ainda sem o init.
    const nova = manager.start(p1, { engine: 'claude', continueLatest: false })
    expect(manager.get(nova.localId)?.engineSessionId).toBeFalsy()
    const antes = projects.list().length
    const res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('no_conversation')
    expect(projects.list()).toHaveLength(antes)
    // Sem sessão de pé, a mais recente do banco continua valendo.
    await manager.stop(nova.localId)
    await forkOk(p1.id, { engine: 'claude' })
  })

  it('volta da conversa pendente (id segurado até o primeiro result): 409 rewind_pending; depois do result, copia a conversa nova', async () => {
    const NOVA = '33333333-3333-4333-8333-333333333333'
    doisTurnos(p1.path)
    doisTurnos(p1.path, NOVA)
    const { localId } = startMain(p1, 'claude', SRC)
    // "Editar a partir daqui": a sessão sobe de novo com o id segurado; o init
    // já traz o id novo, mas o banco e o manager ainda mostram o antigo.
    await manager.relaunch(localId, { resumeSessionId: SRC, extraArgs: ['--fork-session'], holdEngineId: true })
    const s = created.at(-1)!
    s.init(NOVA)
    expect(manager.get(localId)?.engineSessionId).toBe(SRC)
    const antes = projects.list().length
    const res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('rewind_pending')
    expect(projects.list()).toHaveLength(antes)
    // O primeiro result solta o id: o ramo copia a conversa de depois da volta.
    manager.send(localId, 'primeira')
    s.result()
    await forkOk(p1.id, { engine: 'claude' })
    expect(created.at(-1)!.opts.forkFrom).toEqual({ sourceId: NOVA, cut: U(4) })
  })

  it('volta da conversa em curso (o desfazer segura o terminal): 409 rewind_in_progress, também no relançamento sem sessão de pé', async () => {
    doisTurnos(p1.path)
    const { localId } = startMain(p1, 'claude', SRC)
    // "Editar a partir daqui" interrompe, desfaz arquivos e relança: nesse meio a
    // conversa é a de antes da volta, e o ramo a copiaria.
    vi.spyOn(undo!.rewind, 'holds').mockImplementation((p, e) => p === p1.id && e === 'claude')
    const antes = projects.list().length
    let res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('rewind_in_progress')
    // No relançamento a sessão some do live por um instante: a do banco é a velha.
    await manager.stop(localId)
    res = await fork(p1.id, { engine: 'claude' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('rewind_in_progress')
    expect(projects.list()).toHaveLength(antes)
    // A volta terminou: o terminal fica livre.
    vi.mocked(undo!.rewind.holds).mockReturnValue(false)
    await forkOk(p1.id, { engine: 'claude' })
  })

  it('arquivos em escrita por um desfazer (sem volta da conversa) não recusam o /fork', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    vi.spyOn(undo!.service, 'holds').mockReturnValue(true)
    await forkOk(p1.id, { engine: 'claude' })
  })

  it('sessão viva com "continuar conversa" ainda sem id: copia a mais recente do banco (a que o --continue retoma)', async () => {
    const VELHA = '22222222-2222-4222-8222-222222222222'
    doisTurnos(p1.path, VELHA)
    const velha = startMain(p1, 'claude', VELHA)
    await manager.stop(velha.localId)
    // Terminal aberto com "continuar conversa", antes da primeira mensagem (sem init).
    const cont = manager.start(p1, { engine: 'claude', continueLatest: true })
    expect(manager.get(cont.localId)?.engineSessionId).toBeFalsy()
    expect(rowOf(cont.localId).continue_latest).toBe(1)
    await forkOk(p1.id, { engine: 'claude' })
    expect(created.at(-1)!.opts.forkFrom).toEqual({ sourceId: VELHA, cut: U(4) })
  })
})

describe('a sessão do ramo', () => {
  it('Claude: sessão com --resume src --fork-session --session-id escolhido --resume-session-at corte, e claude_session_id gravado na hora', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC, { model: 'opus', effort: 'high' })
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    expect(session.projectId).toBe(project.id)
    const o = created.at(-1)!.opts
    expect(o.forkFrom).toEqual({ sourceId: SRC, cut: U(4) })
    expect(o.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(o.sessionId).not.toBe(SRC)
    expect(o.model).toBe('opus')
    expect(o.effort).toBe('high')
    expect(o.resumeSessionId).toBeUndefined()
    expect(o.continueLatest).toBeFalsy()
    const args = claudeBranchArgs(buildClaudeArgs({ resumeSessionId: o.resumeSessionId, continueLatest: o.continueLatest }), o)
    const at = (flag: string) => args[args.indexOf(flag) + 1]
    expect(at('--resume')).toBe(SRC)
    expect(args).toContain('--fork-session')
    expect(at('--resume-session-at')).toBe(U(4))
    expect(at('--session-id')).toBe(o.sessionId)
    expect(args).not.toContain('--continue')
    const row = rowOf(session.localId)
    expect(row.claude_session_id).toBe(o.sessionId)
    expect(JSON.parse(row.fork_source!)).toMatchObject({ engine: 'claude', sourceId: SRC, cut: U(4), sessionId: o.sessionId })
    expect(project.forkedCutAt).toBe(JSON.parse(row.fork_source!).cutAt)
  })

  it('Claude no meio do turno: o corte é o último turno fechado', async () => {
    doisTurnos(p1.path)
    const { localId } = startMain(p1, 'claude', SRC)
    manager.send(localId, 'pergunta três')
    const t = Date.now() + 1000
    transcript(p1.path, SRC, [
      linhaClaude('user', U(5), 'pergunta três', t),
      linhaClaude('assistant', U(6), 'resposta três pela metade', t + 10),
    ], true)
    await forkOk(p1.id, { engine: 'claude' })
    expect(created.at(-1)!.opts.forkFrom).toEqual({ sourceId: SRC, cut: U(4) })
  })

  it('Codex: lastTurnId do último task_complete', async () => {
    rollout('20', null, Date.now())
    const { localId } = startMain(p1, 'codex', CODEX_ID)
    manager.send(localId, 'terceira pergunta, em curso')
    const { session } = await forkOk(p1.id, { engine: 'codex' })
    const o = created.at(-1)!.opts
    expect(o.forkFrom).toEqual({ sourceId: CODEX_ID, cut: T2 })
    expect(o.sessionId).toBeUndefined()
    expect(JSON.parse(rowOf(session.localId).fork_source!)).toMatchObject({ engine: 'codex', cut: T2, cutAt: '2026-11-20T10:05:10.000Z' })
  })

  it('OpenCode: ocioso guarda o corte e o pacote; trabalhando, só o pacote; ocioso sem corte: no_conversation', async () => {
    fakeCuts.opencode = { cut: 'msg_9', at: null, previewBefore: 7 }
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: pacote oc`, messages: 2, tokens: 10 }
    const main = startMain(p1, 'opencode', 'ses_src')
    let { session } = await forkOk(p1.id, { engine: 'opencode' })
    let o = created.at(-1)!.opts
    expect(o.forkFrom).toMatchObject({ sourceId: 'ses_src', seed: fakePacks.opencode.text })
    expect(typeof o.forkFrom!.nativeOk).toBe('function')
    expect(JSON.parse(rowOf(session.localId).fork_source!)).toMatchObject({ cut: 'msg_9', previewBefore: 7, seed: fakePacks.opencode.text })
    expect(collectCalls.at(-1)).toMatchObject({ engine: 'opencode', id: 'ses_src', opts: { working: false } })
    expect(collectCalls.at(-1)!.opts.before).toBeUndefined()

    manager.send(main.localId, 'em curso')
    fakeCuts.opencode = { cut: null, at: null, previewBefore: null }
    ;({ session } = await forkOk(p1.id, { engine: 'opencode' }))
    o = created.at(-1)!.opts
    expect(o.forkFrom).toMatchObject({ sourceId: 'ses_src', seed: fakePacks.opencode.text })
    expect(JSON.parse(rowOf(session.localId).fork_source!)).toMatchObject({ cut: null, previewBefore: null })
    expect(collectCalls.at(-1)!.opts).toEqual({ working: true })

    // Trabalhando sem pacote, ou ocioso sem corte: nada a copiar.
    fakePacks.opencode = null
    expect((await fork(p1.id, { engine: 'opencode' })).json().code).toBe('no_conversation')
    main.s.result()
    fakePacks.opencode = { text: 'p', messages: 1, tokens: 1 }
    expect((await fork(p1.id, { engine: 'opencode' })).json().code).toBe('no_conversation')
  })

  it('revive antes do primeiro turno copia de novo, com o mesmo corte', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { session } = await forkOk(p1.id, { engine: 'claude' })
    const primeira = created.at(-1)!.opts
    // O original anda: a cópia refeita continua no mesmo corte.
    transcript(p1.path, SRC, [linhaClaude('user', U(7), 'depois do ramo', Date.now())], true)
    await manager.stop(session.localId)
    manager.revive(session.localId)
    const o = created.at(-1)!.opts
    expect(o.forkFrom).toEqual({ sourceId: SRC, cut: U(4) })
    expect(o.sessionId).toBe(primeira.sessionId)
    expect(o.resumeSessionId).toBeUndefined()
  })

  it('primeiro turno bom limpa fork_source; o revive depois dele retoma o ramo, sem copiar de novo', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const s = created.at(-1)!
    const id = s.opts.sessionId!
    manager.send(session.localId, 'oi ramo')
    // Turno com erro e sem a cópia no disco: ainda não.
    s.result(true)
    expect(rowOf(session.localId).fork_source).not.toBeNull()
    // A CLI gravou a cópia: o fim do turno limpa.
    transcript(project.path, id, [linhaClaude('user', U(8), 'oi ramo', Date.now())])
    s.init(id)
    manager.send(session.localId, 'de novo')
    s.result()
    expect(rowOf(session.localId).fork_source).toBeNull()
    await manager.stop(session.localId)
    manager.revive(session.localId)
    const o = created.at(-1)!.opts
    expect(o.forkFrom).toBeUndefined()
    expect(o.sessionId).toBeUndefined()
    expect(o.resumeSessionId).toBe(id)
  })

  it('os dois terminais passam a usar ownResume (pasta compartilhada)', async () => {
    doisTurnos(p1.path)
    const main = startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    expect(isSharedPath(db, p1.id)).toBe(true)
    expect(isSharedPath(db, project.id)).toBe(true)
    // O ramo conversa: a conversa mais recente da pasta passa a ser a dele.
    const s = created.at(-1)!
    const id = s.opts.sessionId!
    manager.send(session.localId, 'oi')
    transcript(project.path, id, [linhaClaude('user', U(8), 'oi', Date.now() + 5000)])
    s.init(id)
    s.result()
    // O original, aberto com --continue, retoma a conversa DELE, não a do ramo.
    await manager.stop(main.localId)
    manager.start(projects.get(p1.id)!, { engine: 'claude', continueLatest: true })
    expect(created.at(-1)!.opts.resumeSessionId).toBe(SRC)
    expect(created.at(-1)!.opts.continueLatest).toBeFalsy()
    // E o ramo, a dele.
    await manager.stop(session.localId)
    manager.start(projects.get(project.id)!, { engine: 'claude', continueLatest: true })
    expect(created.at(-1)!.opts.resumeSessionId).toBe(id)
    expect(created.at(-1)!.opts.continueLatest).toBeFalsy()
  })
})

describe('prévia do histórico', () => {
  const textos = (res: any) => JSON.stringify(res.json().events)

  it('prévia: o histórico do ramo antes do primeiro turno é o do original até o corte', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    transcript(p1.path, SRC, [linhaClaude('user', U(7), 'depois do ramo', Date.now())], true)

    let res = await history(session.localId)
    expect(res.statusCode).toBe(200)
    expect(textos(res)).toContain('resposta dois')
    expect(textos(res)).toContain('pergunta um')
    expect(textos(res)).not.toContain('depois do ramo')

    // Página anterior: `before` menor que o corte vale.
    const eventos = res.json().events as Array<{ pos: number }>
    res = await history(session.localId, eventos[2].pos)
    expect(textos(res)).toContain('pergunta um')
    expect(textos(res)).not.toContain('pergunta dois')
    // `before` maior que o corte não passa dele.
    res = await history(session.localId, 10_000_000)
    expect(textos(res)).not.toContain('depois do ramo')

    // A cópia própria existe: o histórico é o dela.
    transcript(project.path, created.at(-1)!.opts.sessionId!, [linhaClaude('user', U(8), 'conversa do ramo', Date.now())])
    res = await history(session.localId)
    expect(textos(res)).toContain('conversa do ramo')
    expect(textos(res)).not.toContain('resposta dois')
  })

  it('Codex: a prévia lê o mesmo rollout em que o corte foi calculado, não o guardado em cache', async () => {
    const antigo = JSON.stringify({ timestamp: '2026-11-19T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'conteudo antigo' }] } }) + '\n'
    rollout('19', antigo.repeat(40), Date.now() - 3_600_000)
    // Alguém leu a conversa antes: o cache guarda o rollout antigo.
    await codexEngine.readHistoryPage!(p1.path, CODEX_ID, { minItems: 5 })
    // O rollout novo (depois de um revert) é o que o corte lê.
    rollout('20', null, Date.now())
    startMain(p1, 'codex', CODEX_ID)
    const { session } = await forkOk(p1.id, { engine: 'codex' })
    const res = await history(session.localId)
    expect(textos(res)).toContain('segunda resposta')
    expect(textos(res)).not.toContain('terceira pergunta')
    expect(textos(res)).not.toContain('conteudo antigo')
  })
})

describe('cópia recusada', () => {
  it('cópia recusada: revive em conversa nova e manda o pacote uma vez', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { session } = await forkOk(p1.id, { engine: 'claude' })
    const fonte = JSON.parse(rowOf(session.localId).fork_source!)
    transcript(p1.path, SRC, [linhaClaude('user', U(7), 'depois do ramo', Date.now())], true)
    const n = created.length
    // `--resume-session-at` recusado: morre antes do init.
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length > 0).toBe(true)
    const s2 = created.at(-1)!
    expect(s2.opts.forkFrom).toBeUndefined()
    expect(s2.opts.sessionId).toBeUndefined()
    expect(s2.opts.resumeSessionId).toBeUndefined()
    expect(s2.opts.continueLatest).toBeFalsy()
    expect(s2.writes).toHaveLength(1)
    expect(s2.writes[0].echo).toBe(true)
    expect(s2.writes[0].text.startsWith(HANDOFF_PREFIX)).toBe(true)
    expect(s2.writes[0].text).toContain('resposta dois')
    expect(s2.writes[0].text).not.toContain('depois do ramo')
    expect(collectCalls.at(-1)).toMatchObject({ engine: 'claude', id: SRC, opts: { working: false, before: fonte.previewBefore } })
    expect(rowOf(session.localId)).toMatchObject({ fork_source: null, claude_session_id: null })
    ramoSegueVivo(session.localId)

    // Morrer de novo não repete.
    s2.set('dead')
    await tick()
    expect(created).toHaveLength(n + 1)
  })

  it('cópia recusada com o desfazer segurando a pasta: pacote e mensagem esperam a soltura e saem, na ordem, no cutucão', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    // O desfazer começa a escrever na pasta (a mesma do ramo) e a cópia é recusada.
    const segura = vi.spyOn(undo!, 'holds').mockImplementation((p) => p === project.id)
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length).toBe(n + 1)
    await tick()
    const s2 = created.at(-1)!
    expect(s2.writes).toEqual([])
    // O desfazer solta e cutuca o árbitro do terminal.
    segura.mockReturnValue(false)
    nextSend!.poke(project.id, 'claude')
    expect(s2.writes).toHaveLength(2)
    expect(s2.writes[0].text.startsWith(HANDOFF_PREFIX)).toBe(true)
    expect(s2.writes[1]).toEqual({ text: 'minha pergunta', echo: true })
  })

  it('cópia recusada na primeira mensagem do operador: depois do pacote, a mensagem dele é reenviada uma vez', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length >= 2).toBe(true)
    await tick()
    const s2 = created.at(-1)!
    expect(s2.writes).toHaveLength(2)
    expect(s2.writes[0].text.startsWith(HANDOFF_PREFIX)).toBe(true)
    expect(s2.writes[1]).toEqual({ text: 'minha pergunta', echo: true })
    ramoSegueVivo(session.localId)
    s2.set('dead')
    await tick()
    expect(created).toHaveLength(n + 1)
  })

  it('Codex: thread/fork recusado com a mensagem do operador a caminho (result de erro e logo dead): o pacote sai e a mensagem é reenviada uma vez', async () => {
    rollout('20', null, Date.now())
    startMain(p1, 'codex', CODEX_ID)
    const { session } = await forkOk(p1.id, { engine: 'codex' })
    const s = created.at(-1)!
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    // Como o `fail` do Codex: `finish` emite o result de erro (e assenta), e só depois `dead`.
    s.emit('event', { kind: 'result', subtype: 'error', isError: true, resultText: 'fork recusado', costUsd: 0, raw: {} })
    s.set('needs_attention')
    s.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length >= 2).toBe(true)
    await tick()
    const s2 = created.at(-1)!
    expect(s2.opts.forkFrom).toBeUndefined()
    expect(s2.opts.resumeSessionId).toBeUndefined()
    expect(s2.writes).toHaveLength(2)
    expect(s2.writes[0].text.startsWith(HANDOFF_PREFIX)).toBe(true)
    expect(s2.writes[0].text).toContain('segunda resposta')
    expect(s2.writes[1]).toEqual({ text: 'minha pergunta', echo: true })
    ramoSegueVivo(session.localId)
  })

  it('OpenCode: o processo sai com erro na primeira mensagem (result de erro e logo dead): o pacote sai e a mensagem é reenviada uma vez, no turno seguinte', async () => {
    recusaNoTurno = true // o OpenCode recusa mensagem com o turno em andamento
    fakeCuts.opencode = { cut: 'msg_9', at: null, previewBefore: 7 }
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: pacote oc`, messages: 2, tokens: 10 }
    startMain(p1, 'opencode', 'ses_src')
    const { project, session } = await forkOk(p1.id, { engine: 'opencode' })
    const s = created.at(-1)!
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    // Como o close do OpenCode: o result de erro e, no mesmo passo, `dead`.
    s.emit('event', { kind: 'result', subtype: 'error', isError: true, resultText: 'exit 1', costUsd: 0, raw: {} })
    s.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length >= 1).toBe(true)
    await tick()
    const s2 = created.at(-1)!
    // O pacote ocupa o turno: a mensagem espera o fim dele, sem se perder.
    expect(s2.writes).toEqual([{ text: fakePacks.opencode.text, echo: true }])
    expect(avisosNoChat(session.localId)).toEqual([])
    s2.result()
    // O fim do turno: o árbitro oferece o lugar 2, antes da fila.
    nextSend!.poke(project.id, 'opencode')
    expect(s2.writes).toEqual([
      { text: fakePacks.opencode.text, echo: true },
      { text: 'minha pergunta', echo: true },
    ])
    expect(avisosNoChat(session.localId)).toEqual([])
    s2.result()
    ramoSegueVivo(session.localId)
  })

  it('a cópia recusada usa o motor do terminal do ramo (não o gravado na fonte) para a entrega', async () => {
    recusaNoTurno = true
    fakeCuts.opencode = { cut: 'msg_9', at: null, previewBefore: 7 }
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: pacote oc`, messages: 2, tokens: 10 }
    startMain(p1, 'opencode', 'ses_src')
    const { project, session } = await forkOk(p1.id, { engine: 'opencode' })
    // A fonte diz outro motor (um que aceita mensagem no meio do turno); o pacote guardado não relê nada.
    const fonte = JSON.parse(rowOf(session.localId).fork_source!)
    db.prepare('UPDATE sessions SET fork_source=? WHERE local_id=?').run(JSON.stringify({ ...fonte, engine: 'claude' }), session.localId)
    const s = created.at(-1)!
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    s.emit('event', { kind: 'result', subtype: 'error', isError: true, resultText: 'exit 1', costUsd: 0, raw: {} })
    s.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length >= 1).toBe(true)
    await tick()
    const s2 = created.at(-1)!
    expect(s2.writes).toHaveLength(1)
    expect(filaDe(project.id, 'opencode').texts).toEqual([])
    s2.result()
    nextSend!.poke(project.id, 'opencode')
    expect(s2.writes.map((w) => w.text)).toEqual([fakePacks.opencode.text, 'minha pergunta'])
  })

  it('o revive da cópia recusada falha (ramo fora do ar): a mensagem do operador volta à fila gravada, pausada, e o pacote vai ao chat do ramo', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    vi.spyOn(manager, 'revive').mockImplementation(() => { throw new Error('sem processo') })
    created.at(-1)!.set('dead')
    await expect.poll(() => avisosNoChat(session.localId).length).toBe(1)
    expect(created).toHaveLength(n)
    expect(avisosNoChat(session.localId)[0]).toContain(HANDOFF_PREFIX)
    expect(filaDe(project.id, 'claude')).toEqual({ texts: ['minha pergunta'], paused: true })
  })

  it('a montagem do pacote da cópia recusada falha: o motivo aparece no chat do ramo, e a mensagem do operador segue', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    collectError = new Error('transcript ilegível')
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length >= 1).toBe(true)
    await tick()
    expect(created.at(-1)!.writes).toEqual([{ text: 'minha pergunta', echo: true }])
    const avisos = avisosNoChat(session.localId)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('transcript ilegível')
  })

  it('a volta da conversa relança o ramo durante a espera: a espera não é descartada e sai depois da soltura', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    const segura = vi.spyOn(undo!, 'holds').mockImplementation((p) => p === project.id)
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length).toBe(n + 1)
    await tick()
    // "Editar a partir daqui": o stop do relaunch não anuncia o fim da sessão.
    await manager.relaunch(session.localId, { resumeSessionId: null })
    expect(created).toHaveLength(n + 2)
    expect(avisosNoChat(session.localId)).toEqual([])
    expect(filaDe(project.id, 'claude').texts).toEqual([])
    segura.mockReturnValue(false)
    nextSend!.poke(project.id, 'claude')
    const s3 = created.at(-1)!
    expect(s3.writes.map((w) => w.text.startsWith(HANDOFF_PREFIX) ? 'pacote' : w.text)).toEqual(['pacote', 'minha pergunta'])
  })

  it('o ramo é fechado enquanto a entrega espera o desfazer: o pacote vai ao chat e a mensagem à fila na hora, sem esperar o limite', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const n = created.length
    manager.send(session.localId, 'minha pergunta')
    vi.spyOn(undo!, 'holds').mockImplementation((p) => p === project.id)
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length).toBe(n + 1)
    await tick()
    expect(created.at(-1)!.writes).toEqual([])
    expect(avisosNoChat(session.localId)).toEqual([])
    await manager.stop(session.localId)
    expect(avisosNoChat(session.localId)).toEqual([expect.stringContaining(HANDOFF_PREFIX)])
    expect(filaDe(project.id, 'claude')).toEqual({ texts: ['minha pergunta'], paused: true })
  })

  it('OpenCode copiado no meio do turno: a cópia recusada manda o pacote guardado no /fork, não um refeito sem corte', async () => {
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: pacote até o /fork`, messages: 2, tokens: 10 }
    const main = startMain(p1, 'opencode', 'ses_src')
    manager.send(main.localId, 'em curso')
    fakeCuts.opencode = { cut: null, at: null, previewBefore: null }
    const { session } = await forkOk(p1.id, { engine: 'opencode' })
    const chamadas = collectCalls.length
    // O original andou depois do /fork: um pacote refeito agora traria isso.
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: com o turno em curso e o que veio depois`, messages: 4, tokens: 20 }
    const n = created.length
    created.at(-1)!.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length > 0).toBe(true)
    await tick()
    expect(created.at(-1)!.writes).toEqual([{ text: `${HANDOFF_PREFIX}: pacote até o /fork`, echo: true }])
    expect(collectCalls).toHaveLength(chamadas)
    ramoSegueVivo(session.localId)
  })

  it('Codex: o id do thread/fork sem rollout no disco não é cópia feita; morte antes do primeiro turno vira cópia recusada', async () => {
    rollout('20', null, Date.now())
    startMain(p1, 'codex', CODEX_ID)
    const { session } = await forkOk(p1.id, { engine: 'codex' })
    const s = created.at(-1)!
    // O thread/fork devolveu o id, mas o rollout dele ainda não existe.
    s.init(FORK_ID)
    expect(rowOf(session.localId).claude_session_id).toBe(FORK_ID)
    manager.send(session.localId, 'oi ramo')
    s.result()
    // Sem o arquivo, o fim do turno não encerra a cópia.
    expect(rowOf(session.localId).fork_source).not.toBeNull()
    await tick()
    const n = created.length
    s.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length > 0).toBe(true)
    await tick()
    const s2 = created.at(-1)!
    // Nada de `resume` de um thread sem arquivo (o "id fantasma"): conversa nova com o pacote.
    expect(s2.opts.resumeSessionId).toBeUndefined()
    expect(s2.opts.forkFrom).toBeUndefined()
    expect(s2.writes).toHaveLength(1)
    expect(s2.writes[0].text.startsWith(HANDOFF_PREFIX)).toBe(true)
    expect(rowOf(session.localId)).toMatchObject({ fork_source: null })
    ramoSegueVivo(session.localId)
  })

  it('Codex: com o rollout do id do thread/fork no disco, o fim do turno encerra a cópia', async () => {
    rollout('20', null, Date.now())
    startMain(p1, 'codex', CODEX_ID)
    const { session } = await forkOk(p1.id, { engine: 'codex' })
    const s = created.at(-1)!
    s.init(FORK_ID)
    manager.send(session.localId, 'oi ramo')
    const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', '20')
    writeFileSync(join(dir, `rollout-2026-11-20T11-00-00-${FORK_ID}.jsonl`), '')
    s.result()
    expect(rowOf(session.localId).fork_source).toBeNull()
  })

  it('OpenCode: result de erro sem init (pacote acima de 120 KB) é erro do turno, não cópia recusada', async () => {
    fakeCuts.opencode = { cut: 'msg_9', at: null, previewBefore: 7 }
    fakePacks.opencode = { text: `${HANDOFF_PREFIX}: pacote oc`, messages: 2, tokens: 10 }
    startMain(p1, 'opencode', 'ses_src')
    const { session } = await forkOk(p1.id, { engine: 'opencode' })
    const s = created.at(-1)!
    manager.send(session.localId, 'grande demais')
    s.result(true)
    expect(manager.get(session.localId)!.status).toBe('idle')
    // Sem cópia ainda: a próxima mensagem tenta de novo.
    expect(rowOf(session.localId).fork_source).not.toBeNull()
    // O turno acabou: a mensagem dele não volta numa morte posterior (num
    // passo seguinte do laço; a morte no mesmo passo do result é a recusa).
    await tick()
    const n = created.length
    s.set('dead')
    await expect.poll(() => created.length === n + 1 && created.at(-1)!.writes.length > 0).toBe(true)
    await tick()
    expect(created.at(-1)!.writes.map((w) => w.text)).toEqual([fakePacks.opencode.text])
    ramoSegueVivo(session.localId)
  })

  it('morte depois da cópia gravada não recria: só limpa o fork_source', async () => {
    doisTurnos(p1.path)
    startMain(p1, 'claude', SRC)
    const { project, session } = await forkOk(p1.id, { engine: 'claude' })
    const s = created.at(-1)!
    transcript(project.path, s.opts.sessionId!, [linhaClaude('user', U(8), 'oi', Date.now())])
    const n = created.length
    s.set('dead')
    await tick()
    expect(created).toHaveLength(n)
    expect(rowOf(session.localId)).toMatchObject({ fork_source: null, claude_session_id: s.opts.sessionId })
  })
})

describe('Kimi', () => {
  it('Kimi: conversa nova recebe o pacote como mensagem do Claudinei e nada vai à fila antes do fim desse turno', async () => {
    recusaNoTurno = true
    fakePacks.kimi = { text: `${HANDOFF_PREFIX}: pacote kimi`, messages: 3, tokens: 100 }
    startMain(p1, 'kimi', 'kimi-conv-1')
    const { session } = await forkOk(p1.id, { engine: 'kimi' })
    const s = created.at(-1)!
    expect(s.opts.forkFrom).toBeUndefined()
    expect(s.opts.resumeSessionId).toBeUndefined()
    expect(s.opts.continueLatest).toBeFalsy()
    expect(s.writes).toEqual([{ text: fakePacks.kimi.text, echo: true }])
    expect(manager.get(session.localId)!.status).toBe('working')
    expect(rowOf(session.localId).fork_source).toBeNull()
    expect(collectCalls.at(-1)).toEqual({ engine: 'kimi', id: 'kimi-conv-1', opts: { working: false } })
    // O árbitro da fila só entrega com a sessão fora de turno: até o fim do
    // turno do pacote, todo "livre" a encontra trabalhando.
    await tick()
    expect(available.filter((a) => a.localId === session.localId && a.status !== 'working')).toEqual([])
    s.result()
    await expect.poll(() => available.some((a) => a.localId === session.localId && a.status === 'idle')).toBe(true)
  })

  it('Kimi com o desfazer segurando a pasta: o pacote espera a soltura e sai no cutucão, antes da fila do ramo', async () => {
    recusaNoTurno = true
    fakePacks.kimi = { text: `${HANDOFF_PREFIX}: pacote kimi`, messages: 3, tokens: 100 }
    startMain(p1, 'kimi', 'kimi-conv-1')
    // Escrita do desfazer na pasta do original, que é a do ramo também.
    const segura = vi.spyOn(undo!.service, 'holds').mockReturnValue(true)
    const { project, session } = await forkOk(p1.id, { engine: 'kimi' })
    const s = created.at(-1)!
    await tick()
    expect(s.writes).toEqual([])
    const added = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/terminals/kimi/queue`, cookies: adminCookie, payload: { text: 'item da fila' } })
    expect(added.statusCode).toBe(201)
    segura.mockReturnValue(false)
    nextSend!.poke(project.id, 'kimi')
    expect(s.writes).toEqual([{ text: fakePacks.kimi.text, echo: true }])
    expect(manager.get(session.localId)!.status).toBe('working')
  })

  it('Kimi sem pacote: no_conversation', async () => {
    fakePacks.kimi = null
    startMain(p1, 'kimi', 'kimi-conv-1')
    const res = await fork(p1.id, { engine: 'kimi' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('no_conversation')
  })
})
