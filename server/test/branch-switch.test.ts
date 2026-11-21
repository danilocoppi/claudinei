import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import type { SessionStatus } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createTerminalStateStore, type TerminalStateStore } from '../src/restart/terminal-state.js'
import type { RestartService } from '../src/restart/boot.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'
import type { GoalService } from '../src/goal/goal.js'
import type { EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { transcriptPath } from '../src/history.js'
import { collectHandoff, HANDOFF_PREFIX } from '../src/branch/handoff.js'
import type { BranchService } from '../src/branch/service.js'

/**
 * Continuar noutro motor (`POST /api/projects/:id/handoff`): o pacote da
 * conversa de origem abre uma conversa nova no destino. As sessões são falsas
 * (em memória), o storage do Claude vive num CLAUDE_CONFIG_DIR temporário e o
 * "instalado" sai de binários temporários: nunca a CLI real. O árbitro do
 * próximo envio, a fila e o goal são os de verdade (buildApp), ligados ao
 * manager como no index.ts.
 */

const SRC = '11111111-1111-4111-8111-111111111111'
const DEST_ID = '019f0000-0000-7000-8000-0000000000d1'
const U = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`

/** Sessão falsa: grava o que recebe e deixa o teste mandar no status e nos eventos. */
class FakeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  lastStderr = ''
  writes: Array<{ text: string; echo: boolean }> = []
  stopFails = false
  /** Como as sessões reais: o `stop` só resolve depois de um tempo (o processo saindo). */
  slowStop = false
  /** `stop` que resolve sem encerrar a sessão. */
  stopNoop = false
  /** `send` que lança (o envio do pacote falhando). */
  sendFails = false
  stops = 0
  constructor(readonly opts: EngineSessionOptions) { super() }
  set(s: SessionStatus) { if (this.status !== s) { this.status = s; this.emit('status', s) } }
  start(): void { this.set('idle') }
  send(text: string, o?: { echoToClients?: boolean }): void {
    if (this.sendFails) throw new Error('envio falhou')
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
  async stop(): Promise<void> {
    this.stops++
    if (this.stopFails) throw new Error('stop falhou')
    if (this.slowStop) await new Promise((r) => setTimeout(r, 30))
    if (this.stopNoop) return
    this.set('stopped')
  }
}

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDINEI_CODEX_BIN', 'CLAUDINEI_KIMI_BIN', 'CLAUDINEI_OPENCODE_BIN',
  'CLAUDINEI_KIMI_HOMES', 'KIMI_CODE_HOME'] as const
let envAntes: Record<string, string | undefined>
let tmp: string
let db: Db
let app: Awaited<ReturnType<typeof buildApp>>
let auth: AuthService
let store: TerminalStateStore
let manager: ReturnType<typeof createSessionManager>
let branch: BranchService | undefined
let created: FakeSession[]
let broadcasts: any[]
let collectCalls: Array<{ engine: string; id: string; opts: { working: boolean; before?: number } }>
/** Roda no meio do `collect`, antes de ele devolver o pacote (o destino mudando entre o menu e a confirmação). */
let duringCollect: (() => void) | undefined
/** Roda em cada sessão falsa criada (o teste ajusta a sessão nova do destino). */
let onCreate: ((s: FakeSession) => void) | undefined
let projects: ReturnType<typeof createProjectsService>
let p1: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

beforeEach(async () => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'branch-switch-'))
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
  process.env.CODEX_HOME = join(tmp, 'codex')
  // "Instalado": o Codex tem um binário (nunca executado: as sessões são falsas);
  // o Kimi e o OpenCode apontam para caminhos que não existem.
  const codexBin = join(tmp, 'codex-bin')
  writeFileSync(codexBin, '#!/bin/sh\nexit 1\n')
  chmodSync(codexBin, 0o755)
  process.env.CLAUDINEI_CODEX_BIN = codexBin
  process.env.CLAUDINEI_KIMI_BIN = join(tmp, 'nao-existe-kimi')
  process.env.CLAUDINEI_OPENCODE_BIN = join(tmp, 'nao-existe-opencode')
  process.env.CLAUDINEI_KIMI_HOMES = join(tmp, 'kimi-homes')
  process.env.KIMI_CODE_HOME = join(tmp, 'kimi-home')
  db = openDb(':memory:')
  auth = createAuthService({ db })
  store = createTerminalStateStore(db)
  created = []
  broadcasts = []
  collectCalls = []
  duringCollect = undefined
  onCreate = undefined
  branch = undefined
  let nextSend: NextSend | undefined
  let queue: OperatorQueueService | undefined
  let restart: RestartService | undefined
  let goal: GoalService | undefined
  const both = (...calls: Array<() => void>) => { for (const c of calls) { try { c() } catch (err) { console.error(err) } } }
  manager = createSessionManager({
    db, broadcast: () => {},
    sessionFactory: (opts) => { const s = new FakeSession(opts); created.push(s); onCreate?.(s); return s },
    // Como o index.ts: os ganchos chegam aos serviços pela referência.
    onSessionAvailable: (projectId, ctx) => { if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, ...ctx }) },
    onTurnResult: (projectId, engine, info) => both(
      () => restart?.onTurnResult(projectId, engine),
      () => queue?.onTurnResult(projectId, engine, info),
      () => goal?.onTurnResult(projectId, engine, info),
      () => branch?.onTurnResult(projectId, engine)),
    onOperatorMessage: (projectId, engine, info) => both(
      () => restart?.onOperatorMessage(projectId, engine),
      () => goal?.onOperatorMessage(projectId, engine, info),
      () => branch?.onOperatorMessage(projectId, engine, info)),
    onSessionDied: (projectId, engine) => both(
      () => queue?.onSessionDied(projectId, engine),
      () => branch?.onSessionDied(projectId, engine)),
    onSessionEnded: (p, e) => branch?.onSessionEnded(p, e),
    interceptCommand: (ctx, text) => goal?.command(ctx, text) ?? false,
  })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: any) => broadcasts.push(m), register: () => {} } as never,
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onRestartReady: (r) => { restart = r },
    onGoalReady: (g) => { goal = g },
    onBranchReady: (b) => { branch = b },
    branchTest: {
      // O pacote de verdade, sobre o storage temporário; o teste pode mexer no destino no meio dele.
      collect: async (engine, path, id, opts) => {
        collectCalls.push({ engine: engine.id, id, opts })
        const pack = await collectHandoff(engine, path, id, opts)
        duringCollect?.()
        return pack
      },
    },
  })
  projects = createProjectsService(db)
  const pasta = join(tmp, 'alfa')
  mkdirSync(pasta)
  p1 = projects.create({ name: 'Alfa', path: pasta, engines: ['claude', 'codex', 'kimi'] })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  manager.beginShutdown()
  await branch?.dispose()
  for (const s of created) s.stopFails = false
  await manager.stopAll()
  await app.close()
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

// ---------- storage falso do Claude ----------

const iso = (ms: number) => new Date(ms).toISOString()
const linhaClaude = (type: 'user' | 'assistant', uuid: string, text: string, at: number) => JSON.stringify(
  type === 'user'
    ? { type, uuid, timestamp: iso(at), message: { role: 'user', content: text } }
    : { type, uuid, timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }] } },
) + '\n'

function transcript(path: string, id: string, linhas: string[], append = false): void {
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, path, id)
  mkdirSync(dirname(file), { recursive: true })
  if (append) appendFileSync(file, linhas.join(''))
  else writeFileSync(file, linhas.join(''))
}

/** Dois turnos fechados há um minuto na conversa do Claude. */
function doisTurnos(path: string, id = SRC) {
  const t = Date.now() - 60_000
  transcript(path, id, [
    linhaClaude('user', U(1), 'pergunta um', t),
    linhaClaude('assistant', U(2), 'resposta um', t + 1000),
    linhaClaude('user', U(3), 'pergunta dois', t + 2000),
    linhaClaude('assistant', U(4), 'resposta dois', t + 3000),
  ])
}

// ---------- atalhos ----------

/** Sobe a sessão do motor no terminal e dá a ela a conversa `id` (o init). */
function startLive(engine: string, id: string) {
  const info = manager.start(projects.get(p1.id)!, { engine })
  const s = created.at(-1)!
  s.init(id)
  return { localId: info.localId, s }
}

const handoff = (payload: object, cookies = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/projects/${p1.id}/handoff`, cookies, payload })

const tick = () => new Promise((r) => setTimeout(r, 20))
const sessionsCount = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n

// ---------- testes ----------

describe('validação', () => {
  it('mesmo motor: 400 handoff_same_engine', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const res = await handoff({ from: 'claude', to: 'claude' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('handoff_same_engine')
  })

  it('destino fora da lista do terminal, não instalado ou desconhecido: 409 handoff_engine_unavailable', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    for (const to of ['opencode', 'kimi', 'nada']) {
      const res = await handoff({ from: 'claude', to })
      expect(res.statusCode, to).toBe(409)
      expect(res.json().code, to).toBe('handoff_engine_unavailable')
    }
    expect(created).toHaveLength(1)
  })

  it('sem conversa de origem: 409 no_conversation; corpo e acesso', async () => {
    const r1 = await handoff({ from: 'claude', to: 'codex' })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().code).toBe('no_conversation')
    // Sessão viva sem nenhuma mensagem: o pacote é nulo.
    startLive('claude', SRC)
    const r2 = await handoff({ from: 'claude', to: 'codex' })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().code).toBe('no_conversation')
    expect(created).toHaveLength(1)

    expect((await handoff({ from: 'xx', to: 'codex' })).statusCode).toBe(400)
    expect((await handoff({ from: 'claude' })).statusCode).toBe(400)
    expect((await handoff({ from: 'claude', to: 'codex' }, anaCookie)).statusCode).toBe(403)
    const r404 = await app.inject({ method: 'POST', url: '/api/projects/999/handoff', cookies: adminCookie, payload: { from: 'claude', to: 'codex' } })
    expect(r404.statusCode).toBe(404)
  })
})

describe('o destino', () => {
  it('destino trabalhando: 409 handoff_target_busy e nada parado', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    manager.send(dest.localId, 'trabalho do codex')
    expect(dest.s.status).toBe('working')
    const antes = sessionsCount()

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('handoff_target_busy')
    expect(dest.s.stops).toBe(0)
    expect(dest.s.status).toBe('working')
    expect(created).toHaveLength(2)
    expect(sessionsCount()).toBe(antes)
  })

  it('destino que passa a trabalhar enquanto o pacote é montado: 409 handoff_target_busy e nada parado', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    // O "livre" do início do destino já passou: o goal ativo não manda o continue sozinho.
    await tick()
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    duringCollect = () => manager.send(dest.localId, 'chegou agora')

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('handoff_target_busy')
    expect(collectCalls).toHaveLength(1)
    expect(dest.s.stops).toBe(0)
    expect(created).toHaveLength(2)
    // O destino recebeu só a mensagem do operador; nenhuma sessão nova, nenhum pacote.
    expect(dest.s.writes.map((w) => w.text)).toEqual(['chegou agora'])
  })

  it('destino aberto no terminal interativo: 409 handoff_target_busy antes de qualquer efeito', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    db.prepare(`INSERT INTO sessions (local_id, project_id, status, engine) VALUES ('no-terminal', ?, 'in_terminal', 'codex')`).run(p1.id)
    const antes = sessionsCount()

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('handoff_target_busy')
    // Nem o pacote é montado, nem o goal pausado, nem sessão criada.
    expect(collectCalls).toHaveLength(0)
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'active', goalPause: null })
    expect(created).toHaveLength(1)
    expect(sessionsCount()).toBe(antes)
  })

  it('destino no limite: 409 handoff_target_limited', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    store.recordUsageLimit(p1.id, 'codex', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('handoff_target_limited')
    expect(dest.s.stops).toBe(0)
    expect(created).toHaveLength(2)
    expect(collectCalls).toHaveLength(0)
  })

  it('destino ocioso é encerrado e abre conversa nova com o pacote', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    const info = res.json()
    expect(dest.s.stops).toBe(1)
    expect(manager.get(dest.localId)?.status).toBe('stopped')
    expect(created).toHaveLength(3)
    const nova = created.at(-1)!
    expect(info).toMatchObject({ projectId: p1.id, engine: 'codex' })
    expect(info.localId).not.toBe(dest.localId)
    expect(manager.get(info.localId)?.status).toBe('working')
    // Conversa nova: nem retoma nem continua a anterior do destino.
    expect(nova.opts.continueLatest).toBe(false)
    expect(nova.opts.resumeSessionId).toBeUndefined()
    expect((db.prepare('SELECT continue_latest, claude_session_id FROM sessions WHERE local_id=?').get(info.localId) as any))
      .toEqual({ continue_latest: 0, claude_session_id: null })
    // O pacote é a primeira (e única) mensagem, como mensagem do Claudinei (ecoada no chat).
    expect(nova.writes).toHaveLength(1)
    expect(nova.writes[0].echo).toBe(true)
    expect(nova.writes[0].text.startsWith(`${HANDOFF_PREFIX}: This conversation continues one held with Claude Code`)).toBe(true)
    expect(nova.writes[0].text).toContain('=== operator ===\npergunta dois')
    expect(nova.writes[0].text).toContain('=== agent ===\nresposta dois')
    expect(collectCalls).toEqual([{ engine: 'claude', id: SRC, opts: { working: false } }])
  })

  it('destino sem sessão de pé: abre direto, sem parar nada', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    expect(created).toHaveLength(2)
    expect(created[1].writes.map((w) => w.text.startsWith(HANDOFF_PREFIX))).toEqual([true])
  })

  it('stop que falha: nada criado', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    // O "livre" do início do destino já passou: o goal ativo não manda o continue sozinho.
    await tick()
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    dest.s.stopFails = true
    const antes = sessionsCount()

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(500)
    expect(dest.s.stops).toBe(1)
    expect(created).toHaveLength(2)
    expect(sessionsCount()).toBe(antes)
    expect(dest.s.writes).toEqual([])
    // Nada pausado: o goal do destino segue ativo.
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'active', goalPause: null })
  })

  it('stop que resolve sem encerrar o destino: 409 handoff_target_busy, nada criado nem pausado', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    await tick()
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    dest.s.stopNoop = true

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('handoff_target_busy')
    expect(created).toHaveLength(2)
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'active', goalPause: null })
  })

  it('dois pedidos ao mesmo tempo para o mesmo destino: só um abre', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    // Destino ocioso cujo `stop` demora: sem a reserva, os dois pedidos o achariam
    // ocioso, os dois o encerrariam e o segundo esbarraria na sessão nova do primeiro.
    const dest = startLive('codex', DEST_ID)
    dest.s.slowStop = true
    const [a, b] = await Promise.all([handoff({ from: 'claude', to: 'codex' }), handoff({ from: 'claude', to: 'codex' })])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    expect([a, b].find((r) => r.statusCode === 409)!.json().code).toBe('handoff_target_busy')
    expect(dest.s.stops).toBe(1)
    expect(created).toHaveLength(3)
    expect(created[2].writes).toHaveLength(1)
  })
})

describe('pendências do destino', () => {
  it('goal ativo do destino pausa por operator', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    store.startGoal(p1.id, 'codex', 'objetivo do codex')

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
    // A tela sabe na hora (restart.publish).
    expect(broadcasts.some((b) => b.type === 'terminal_state' && b.state?.projectId === p1.id && b.state?.engine === 'codex'
      && b.state?.goal?.status === 'paused')).toBe(true)

    // O turno do pacote termina: o goal pausado não manda o continue.
    const nova = created.at(-1)!
    nova.result()
    await tick()
    expect(nova.writes).toHaveLength(1)
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
  })

  it('goal esperando as tarefas também pausa por operator; o goal da origem não muda', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    store.setGoalStatus(p1.id, 'codex', 'waiting')
    store.startGoal(p1.id, 'claude', 'objetivo do claude')

    expect((await handoff({ from: 'claude', to: 'codex' })).statusCode).toBe(201)
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
    expect(store.get(p1.id, 'claude')).toMatchObject({ goalStatus: 'active', goalPause: null })
  })

  it('retomada pendente do destino sai na troca: a conversa nova não tem Continuar', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    const dest = startLive('codex', DEST_ID)
    await tick()
    store.markInterrupted(p1.id, 'codex', dest.localId, null)
    expect(store.get(p1.id, 'codex').interruptedAt).not.toBeNull()
    broadcasts.length = 0

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    expect(store.get(p1.id, 'codex')).toMatchObject({ interruptedAt: null, interruptedLocalId: null })
    // A tela sabe na hora: o Continuar some.
    expect(broadcasts.some((b) => b.type === 'terminal_state' && b.state?.projectId === p1.id && b.state?.engine === 'codex'
      && b.state?.interruption == null)).toBe(true)
  })

  it('envio do pacote que lança: responde com a sessão criada e o goal pausado', async () => {
    doisTurnos(p1.path)
    startLive('claude', SRC)
    store.startGoal(p1.id, 'codex', 'objetivo do codex')
    onCreate = (s) => { s.sendFails = true }

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    const info = res.json()
    expect(info).toMatchObject({ projectId: p1.id, engine: 'codex' })
    expect(manager.get(info.localId)).toBeDefined()
    expect(created).toHaveLength(2)
    expect(created[1].writes).toEqual([])
    expect(store.get(p1.id, 'codex')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
  })

  it('fila do destino sai só depois do turno do pacote', async () => {
    doisTurnos(p1.path)
    // A origem é a conversa mais recente do Claude, já encerrada.
    const orig = startLive('claude', SRC)
    await manager.stop(orig.localId)
    // O item espera na fila do destino (sem sessão de pé, nada sai).
    const added = await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/terminals/codex/queue`, cookies: adminCookie, payload: { text: 'item da fila' } })
    expect(added.statusCode).toBe(201)

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    const nova = created.at(-1)!
    await tick()
    // Só o pacote: a sessão nasce ocupada com ele, e o "livre" do início não entrega o item.
    expect(nova.writes.map((w) => w.text.startsWith(HANDOFF_PREFIX))).toEqual([true])

    // Fim do turno do pacote: o árbitro entrega o item.
    nova.result()
    await tick()
    expect(nova.writes).toHaveLength(2)
    expect(nova.writes[1]).toEqual({ text: 'item da fila', echo: true })
  })
})

describe('a origem', () => {
  it('origem trabalhando: o pacote vai até o último turno fechado', async () => {
    doisTurnos(p1.path)
    const orig = startLive('claude', SRC)
    manager.send(orig.localId, 'pergunta três')
    transcript(p1.path, SRC, [
      linhaClaude('user', U(5), 'pergunta três', Date.now()),
      linhaClaude('assistant', U(6), 'parcial três', Date.now() + 10),
    ], true)
    expect(orig.s.status).toBe('working')

    const res = await handoff({ from: 'claude', to: 'codex' })
    expect(res.statusCode, res.body).toBe(201)
    expect(collectCalls).toEqual([{ engine: 'claude', id: SRC, opts: { working: true } }])
    const pack = created.at(-1)!.writes[0].text
    expect(pack).toContain('resposta dois')
    expect(pack).not.toContain('pergunta três')
    expect(pack).not.toContain('parcial três')
  })

  it('origem segue viva e intocada', async () => {
    doisTurnos(p1.path)
    const orig = startLive('claude', SRC)
    const antes = manager.get(orig.localId)!

    expect((await handoff({ from: 'claude', to: 'codex' })).statusCode).toBe(201)
    await tick()
    expect(orig.s.stops).toBe(0)
    expect(orig.s.writes).toEqual([])
    const depois = manager.get(orig.localId)!
    expect(depois.status).toBe('idle')
    expect(depois.engineSessionId).toBe(antes.engineSessionId)
    expect(manager.list().filter((s) => s.projectId === p1.id && ['idle', 'working', 'starting'].includes(s.status)).map((s) => s.engine).sort())
      .toEqual(['claude', 'codex'])
  })
})
