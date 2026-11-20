import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createTerminalStateStore, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { createRestartService, RESUME_PREFIX } from '../src/restart/boot.js'
import { createUsageLimitService } from '../src/limit/usage-limit.js'
import { LIMIT_RESUME_PREFIX, LIMIT_RESUME_TEXT } from '../src/limit/texts.js'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms))

// Relógio falso: ms; o resetsAt do limite é em epoch SEGUNDOS.
const T0 = 1_800_000_000_000
const segs = (ms: number) => Math.floor(ms / 1000)

let db: Db
let mgr: ReturnType<typeof createSessionManager>
let store: TerminalStateStore
let mgrBroadcasts: any[]
let stateBroadcasts: any[]
let brokenPaths: Set<string>
let clock: number
let timers: { fn: () => void; ms: number; cleared: boolean }[]
let sleeps: number[]
let logs: string[]
let onSleep: (() => void) | null
let restartSvc: ReturnType<typeof createRestartService>

const fakeFactory = (opts: SessionOptions) => {
  if (brokenPaths.has(opts.projectPath)) throw new Error('motor recusou')
  return new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
}

beforeEach(() => {
  db = openDb(':memory:')
  mgrBroadcasts = []
  stateBroadcasts = []
  brokenPaths = new Set()
  clock = T0
  timers = []
  sleeps = []
  logs = []
  onSleep = null
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m) })
  store = createTerminalStateStore(db)
})

afterEach(async () => { await mgr.stopAll() })

const makeService = () => {
  const restart = restartSvc = createRestartService({
    db, manager: mgr, store,
    orchestrator: () => undefined,
    broadcast: (m) => stateBroadcasts.push(m),
    closeInterruptedRuns: () => 0,
    log: () => {},
  })
  return createUsageLimitService({
    manager: mgr, store, restart,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return { clear() { t.cleared = true } }
    },
    // A espera entre lotes registra e pode rodar algo "no meio" (o operador agindo).
    sleep: async (ms) => { sleeps.push(ms); onSleep?.() },
    log: (m) => logs.push(m),
  })
}

const pending = () => timers.filter((t) => !t.cleared)

/** Avança o relógio até o timer pendente e o dispara, esperando o processamento. */
const fire = async () => {
  const live = pending()
  expect(live).toHaveLength(1)
  const t = live[0]
  t.cleared = true
  clock += t.ms
  await (t.fn() as unknown as Promise<void> | undefined)
}

const newProject = (name: string) =>
  createProjectsService(db).create({ name, path: mkdtempSync(join(tmpdir(), 'limite-')) })

/** Sessão anterior persistida (parada), como a que sobra depois do limite ou do reinício. */
const seedSession = (project: Project) => {
  const localId = randomUUID()
  db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`)
    .run(localId, project.id)
  return localId
}

const limitEchoes = () => mgrBroadcasts.filter((b) =>
  b.type === 'session_event' && b.event?.kind === 'user' &&
  String(b.event.message?.content?.[0]?.text ?? '').startsWith(LIMIT_RESUME_PREFIX))

const lastState = (projectId: number) =>
  stateBroadcasts.filter((b) => b.type === 'terminal_state' && b.state.projectId === projectId).at(-1)?.state

/** Terminal com a preferência ligada (ou não), uma sessão parada e o limite batido pelo operador. */
const limited = (svc: ReturnType<typeof makeService>, opts: {
  name?: string; auto?: boolean; origin?: 'operator' | 'schedule' | 'task' | 'claudinei'; resetsAt?: number | null
} = {}) => {
  const p = newProject(opts.name ?? 'P')
  const localId = seedSession(p)
  if (opts.auto) store.setPrefs(p.id, 'claude', { autoResumeLimit: true })
  const resetsAt = opts.resetsAt === undefined ? segs(T0) + 3600 : opts.resetsAt
  svc.onUsageLimit(p.id, 'claude', { localId, resetsAt, origin: opts.origin ?? 'operator' })
  return { p, localId, resetsAt }
}

describe('serviço do limite de uso', () => {
  it('limite sem interruptor: aviso em none, nada armado', () => {
    const svc = makeService()
    const { p, resetsAt } = limited(svc)
    expect(store.get(p.id, 'claude')).toMatchObject({ limitAction: 'none', limitResetsAt: resetsAt, limitOrigin: 'operator' })
    expect(lastState(p.id).usageLimit).toMatchObject({ action: 'none', resetsAt, origin: 'operator' })
    expect(pending()).toHaveLength(0)
  })

  it('interruptor ligado e origem operator: arma sozinho para resetsAt+60s', () => {
    const svc = makeService()
    const { p, resetsAt } = limited(svc, { auto: true })
    expect(store.get(p.id, 'claude').limitAction).toBe('armed')
    expect(lastState(p.id).usageLimit.action).toBe('armed')
    // resetsAt em SEGUNDOS: o timer é em ms, com a folga de 60 s.
    expect(pending()).toHaveLength(1)
    expect(pending()[0].ms).toBe((resetsAt! * 1000 + 60_000) - T0)
    expect(pending()[0].ms).toBe(3_660_000)
  })

  it('interruptor ligado e origem claudinei também arma', () => {
    const svc = makeService()
    const { p } = limited(svc, { auto: true, origin: 'claudinei' })
    expect(store.get(p.id, 'claude').limitAction).toBe('armed')
    expect(pending()).toHaveLength(1)
  })

  it('interruptor ligado e origem schedule ou task: não arma', () => {
    const svc = makeService()
    const a = limited(svc, { name: 'A', auto: true, origin: 'schedule' })
    const b = limited(svc, { name: 'B', auto: true, origin: 'task' })
    expect(store.get(a.p.id, 'claude')).toMatchObject({ limitAction: 'none', limitOrigin: 'schedule' })
    expect(store.get(b.p.id, 'claude')).toMatchObject({ limitAction: 'none', limitOrigin: 'task' })
    expect(pending()).toHaveLength(0)
  })

  it('interruptor ligado sem resetsAt ou com resetsAt passado: não arma', () => {
    const svc = makeService()
    const a = limited(svc, { name: 'A', auto: true, resetsAt: null })
    const b = limited(svc, { name: 'B', auto: true, resetsAt: segs(T0) - 10 })
    expect(store.get(a.p.id, 'claude').limitAction).toBe('none')
    expect(store.get(b.p.id, 'claude').limitAction).toBe('none')
    expect(pending()).toHaveLength(0)
  })

  it('armar e vencer: manda LIMIT_RESUME_TEXT uma vez, limit_tries=1, estado limpo', async () => {
    const svc = makeService()
    const { p, localId } = limited(svc)
    svc.arm(p.id, 'claude')
    await fire()
    await waitUntil(() => limitEchoes().length === 1)
    expect(limitEchoes()[0].localId).toBe(localId)
    expect(limitEchoes()[0].event.message.content[0].text).toBe(LIMIT_RESUME_TEXT)
    expect(store.get(p.id, 'claude')).toMatchObject({ limitHitAt: null, limitAction: 'none', limitTries: 1 })
    expect(lastState(p.id).usageLimit).toBeNull()
    expect(pending()).toHaveLength(0)
    await pause()
    expect(limitEchoes()).toHaveLength(1)
  })

  it('retomada que bate no limite de novo: volta a none e não rearma', async () => {
    const svc = makeService()
    const { p, localId } = limited(svc, { auto: true })
    await fire()
    await waitUntil(() => limitEchoes().length === 1)
    expect(store.get(p.id, 'claude').limitTries).toBe(1)

    // O turno da retomada é do Claudinei e bate no limite de novo, com o interruptor ligado.
    const resetsAt = segs(clock) + 7200
    svc.onUsageLimit(p.id, 'claude', { localId, resetsAt, origin: 'claudinei' })
    svc.onTurnResult(p.id, 'claude', { isError: true })
    expect(store.get(p.id, 'claude')).toMatchObject({ limitAction: 'none', limitResetsAt: resetsAt, limitTries: 1 })
    expect(lastState(p.id).usageLimit).toMatchObject({ action: 'none', resetsAt })
    expect(pending()).toHaveLength(0)
    // O clique ainda arma (a segunda tentativa é do operador).
    svc.arm(p.id, 'claude')
    expect(pending()).toHaveLength(1)
  })

  it('quatro armados vencendo juntos: lotes de 3, sleep(5000) uma vez', async () => {
    const svc = makeService()
    const ps = [0, 1, 2, 3].map((i) => limited(svc, { name: `P${i}`, auto: true }))
    expect(ps.every(({ p }) => store.get(p.id, 'claude').limitAction === 'armed')).toBe(true)
    await fire()
    expect(sleeps).toEqual([5000])
    await waitUntil(() => limitEchoes().length === 4)
    for (const { p } of ps) expect(store.get(p.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 1 })
    expect(pending()).toHaveLength(0)
  })

  /** Quatro armados vencendo juntos: o quarto fica no segundo lote, depois da espera. */
  const fourArmed = (svc: ReturnType<typeof makeService>) =>
    [0, 1, 2, 3].map((i) => limited(svc, { name: `P${i}`, auto: true }))
  const echoesTo = (localId: string) => limitEchoes().filter((b) => b.localId === localId)

  it('cancel durante a espera entre lotes: o segundo lote não manda', async () => {
    const svc = makeService()
    const ps = fourArmed(svc)
    onSleep = () => svc.cancel(ps[3].p.id, 'claude')
    await fire()
    await waitUntil(() => limitEchoes().length === 3)
    await pause()
    expect(echoesTo(ps[3].localId)).toHaveLength(0)
    expect(store.get(ps[3].p.id, 'claude')).toMatchObject({ limitAction: 'none', limitTries: 0 })
    expect(store.get(ps[3].p.id, 'claude').limitHitAt).not.toBeNull()
    expect(pending()).toHaveLength(0)
  })

  it('mensagem do operador durante a espera entre lotes: o segundo lote não manda', async () => {
    const svc = makeService()
    const ps = fourArmed(svc)
    onSleep = () => svc.onOperatorMessage(ps[3].p.id, 'claude')
    await fire()
    await waitUntil(() => limitEchoes().length === 3)
    await pause()
    expect(echoesTo(ps[3].localId)).toHaveLength(0)
    expect(store.get(ps[3].p.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 0 })
  })

  it('Continuar durante a espera que bate outro limite: o segundo lote não manda na janela fechada', async () => {
    const svc = makeService()
    const ps = fourArmed(svc)
    const semanal = segs(T0) + 7 * 24 * 3600
    onSleep = () => {
      // O clique retoma (sem contar tentativa) e o turno bate no limite semanal: rearma.
      expect(svc.continueNow(ps[3].p.id, 'claude')).toBe(true)
      svc.onUsageLimit(ps[3].p.id, 'claude', { localId: ps[3].localId, resetsAt: semanal, origin: 'claudinei' })
      expect(store.get(ps[3].p.id, 'claude').limitAction).toBe('armed')
    }
    await fire()
    await waitUntil(() => limitEchoes().length === 4)
    await pause()
    // Só a do clique: o lote viu que a linha rearmada ainda não venceu.
    expect(echoesTo(ps[3].localId)).toHaveLength(1)
    expect(store.get(ps[3].p.id, 'claude')).toMatchObject({ limitAction: 'armed', limitResetsAt: semanal, limitTries: 0 })
    // O relógio vai para a reabertura semanal.
    expect(pending()).toHaveLength(1)
    expect(pending()[0].ms).toBe(semanal * 1000 + 60_000 - clock)
  })

  it('no lote, um terminal que falha não para os outros', async () => {
    const svc = makeService()
    const ruim = limited(svc, { name: 'Ruim', auto: true })
    const bom = limited(svc, { name: 'Bom', auto: true })
    brokenPaths.add(ruim.p.path)
    await fire()
    await waitUntil(() => limitEchoes().length === 1)
    expect(limitEchoes()[0].localId).toBe(bom.localId)
    // O que falhou volta ao aviso (o operador decide) e não arma de novo: sem laço.
    expect(store.get(ruim.p.id, 'claude')).toMatchObject({ limitAction: 'none', limitTries: 0 })
    expect(store.get(ruim.p.id, 'claude').limitHitAt).not.toBeNull()
    expect(lastState(ruim.p.id).usageLimit.action).toBe('none')
    expect(logs.some((l) => l.includes('motor recusou'))).toBe(true)
    expect(pending()).toHaveLength(0)
  })

  it('no relógio, sessão trabalhando: volta a none sem mandar', async () => {
    const svc = makeService()
    const p = newProject('P')
    const { localId } = mgr.start(p, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    store.setPrefs(p.id, 'claude', { autoResumeLimit: true })
    svc.onUsageLimit(p.id, 'claude', { localId, resetsAt: segs(T0) + 3600, origin: 'operator' })
    mgr.send(localId, 'demorada')
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    await fire()
    expect(store.get(p.id, 'claude')).toMatchObject({ limitAction: 'none', limitTries: 0 })
    expect(store.get(p.id, 'claude').limitHitAt).not.toBeNull()
    expect(lastState(p.id).usageLimit.action).toBe('none')
    expect(limitEchoes()).toHaveLength(0)
    expect(pending()).toHaveLength(0)
  })

  it('boot: armado vencido dispara; armado futuro rearma; adiado vencido só limpa', async () => {
    // Estado deixado pela vida anterior do serviço.
    const vencido = newProject('Vencido')
    const futuro = newProject('Futuro')
    const adiado = newProject('Adiado')
    const adiadoFuturo = newProject('AdiadoFuturo')
    for (const p of [vencido, futuro, adiado, adiadoFuturo]) seedSession(p)
    const arm = (p: Project, resetsAt: number, action: 'armed' | 'snoozed') => {
      store.recordUsageLimit(p.id, 'claude', { resetsAt, origin: 'operator' })
      store.setLimitAction(p.id, 'claude', action)
    }
    arm(vencido, segs(T0) - 120, 'armed')
    arm(futuro, segs(T0) + 600, 'armed')
    arm(adiado, segs(T0) - 120, 'snoozed')
    arm(adiadoFuturo, segs(T0) + 1200, 'snoozed')

    const svc = makeService()
    await svc.boot()

    await waitUntil(() => limitEchoes().length === 1)
    expect(store.get(vencido.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 1 })
    expect(store.get(futuro.id, 'claude').limitAction).toBe('armed')
    expect(store.get(adiado.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 0 })
    expect(lastState(adiado.id).usageLimit).toBeNull()
    expect(store.get(adiadoFuturo.id, 'claude').limitAction).toBe('snoozed')
    // O relógio vai para o próximo vencimento: o armado futuro (resetsAt + 60 s).
    expect(pending()).toHaveLength(1)
    expect(pending()[0].ms).toBe(660_000)

    await fire()
    await waitUntil(() => limitEchoes().length === 2)
    expect(store.get(futuro.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 1 })
    // Agora o adiado futuro: vence, só limpa, sem mandar nada.
    expect(pending()[0].ms).toBe(600_000)
    await fire()
    expect(store.get(adiadoFuturo.id, 'claude').limitHitAt).toBeNull()
    expect(lastState(adiadoFuturo.id).usageLimit).toBeNull()
    await pause()
    expect(limitEchoes()).toHaveLength(2)
    expect(pending()).toHaveLength(0)
  })

  it('boot: armado dentro da folga rearma para o restante', async () => {
    const p = newProject('P')
    seedSession(p)
    store.recordUsageLimit(p.id, 'claude', { resetsAt: segs(T0) - 20, origin: 'operator' })
    store.setLimitAction(p.id, 'claude', 'armed')
    const svc = makeService()
    await svc.boot()
    expect(store.get(p.id, 'claude').limitAction).toBe('armed')
    expect(pending()[0].ms).toBe(40_000)
    expect(limitEchoes()).toHaveLength(0)
  })

  it('boot do reinício e do limite juntos: marca com retomada armada vencida manda uma mensagem só', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autoResume: true, autoResumeLimit: true })
    store.markInterrupted(p.id, 'claude', localId, null)
    // Vencida no relógio real (o do reinício) e no falso (o do limite).
    store.recordUsageLimit(p.id, 'claude', { resetsAt: segs(Date.now()) - 3600, origin: 'operator' })
    store.setLimitAction(p.id, 'claude', 'armed')

    const svc = makeService()
    await restartSvc.boot()
    await svc.boot()

    await waitUntil(() => limitEchoes().length === 1)
    await pause()
    const resumes = mgrBroadcasts.filter((b) =>
      b.type === 'session_event' && b.event?.kind === 'user' &&
      String(b.event.message?.content?.[0]?.text ?? '').startsWith(RESUME_PREFIX))
    expect(resumes).toHaveLength(0)
    expect(limitEchoes()).toHaveLength(1)
    expect(store.get(p.id, 'claude')).toMatchObject({ interruptedAt: null, limitHitAt: null, limitTries: 1 })
  })

  it('arm/snooze sem resetsAt ou com resetsAt passado: reset_unknown', () => {
    const svc = makeService()
    const semHora = limited(svc, { name: 'A', resetsAt: null })
    const passado = limited(svc, { name: 'B', resetsAt: segs(T0) - 1 })
    const agora = limited(svc, { name: 'C', resetsAt: segs(T0) })
    for (const { p } of [semHora, passado, agora]) {
      expect(() => svc.arm(p.id, 'claude')).toThrow(expect.objectContaining({ code: 'reset_unknown' }))
      expect(() => svc.snooze(p.id, 'claude')).toThrow(expect.objectContaining({ code: 'reset_unknown' }))
      expect(store.get(p.id, 'claude').limitAction).toBe('none')
    }
    expect(pending()).toHaveLength(0)
  })

  it('sem limite: arm, snooze, cancel e continueNow respondem no_usage_limit', () => {
    const svc = makeService()
    const p = newProject('P')
    for (const f of ['arm', 'snooze', 'cancel', 'continueNow'] as const) {
      expect(() => svc[f](p.id, 'claude')).toThrow(expect.objectContaining({ code: 'no_usage_limit' }))
    }
  })

  it('snooze adia; arm de um adiado arma; cancel de armado volta a none; cancel de none limpa', () => {
    const svc = makeService()
    const { p, resetsAt } = limited(svc)
    svc.snooze(p.id, 'claude')
    expect(store.get(p.id, 'claude').limitAction).toBe('snoozed')
    expect(lastState(p.id).usageLimit.action).toBe('snoozed')
    // O adiado também tem relógio: some na reabertura.
    expect(pending()).toHaveLength(1)
    expect(pending()[0].ms).toBe(resetsAt! * 1000 + 60_000 - T0)

    svc.arm(p.id, 'claude')
    expect(store.get(p.id, 'claude').limitAction).toBe('armed')
    expect(pending()).toHaveLength(1)
    svc.snooze(p.id, 'claude')
    expect(store.get(p.id, 'claude').limitAction).toBe('snoozed')

    svc.cancel(p.id, 'claude')
    expect(store.get(p.id, 'claude').limitAction).toBe('none')
    expect(store.get(p.id, 'claude').limitHitAt).not.toBeNull()
    expect(lastState(p.id).usageLimit.action).toBe('none')
    expect(pending()).toHaveLength(0)

    store.bumpLimitTries(p.id, 'claude')
    svc.cancel(p.id, 'claude')
    expect(store.get(p.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 1 })
    expect(lastState(p.id).usageLimit).toBeNull()
  })

  it('continueNow com sessão trabalhando: session_busy; parada: revive e manda', async () => {
    const svc = makeService()
    // Trabalhando.
    const ocupado = newProject('Ocupado')
    const { localId: vivo } = mgr.start(ocupado, {})
    await waitUntil(() => mgr.get(vivo)?.status === 'idle')
    svc.onUsageLimit(ocupado.id, 'claude', { localId: vivo, resetsAt: segs(T0) + 3600, origin: 'operator' })
    mgr.send(vivo, 'demorada')
    await waitUntil(() => mgr.get(vivo)?.status === 'working')
    expect(() => svc.continueNow(ocupado.id, 'claude')).toThrow(expect.objectContaining({ code: 'session_busy' }))
    expect(store.get(ocupado.id, 'claude').limitHitAt).not.toBeNull()

    // Parada: revive a sessão do limite e manda; o clique não conta tentativa.
    const { p, localId } = limited(svc, { name: 'Parado', auto: true })
    expect(svc.continueNow(p.id, 'claude')).toBe(true)
    expect(mgr.list().find((s) => s.projectId === p.id && s.status !== 'stopped')?.localId).toBe(localId)
    await waitUntil(() => limitEchoes().length === 1)
    expect(limitEchoes()[0].localId).toBe(localId)
    expect(store.get(p.id, 'claude')).toMatchObject({ limitHitAt: null, limitTries: 0 })
    expect(lastState(p.id).usageLimit).toBeNull()
    // O armado saiu do relógio.
    expect(pending()).toHaveLength(0)
    // Segundo clique: já não há limite.
    expect(() => svc.continueNow(p.id, 'claude')).toThrow(expect.objectContaining({ code: 'no_usage_limit' }))
  })

  it('envio que falha: o limite volta em none com a mesma origem e o erro sobe', () => {
    const svc = makeService()
    const { p, resetsAt } = limited(svc, { origin: 'claudinei' })
    vi.spyOn(mgr, 'sendAsClaudinei').mockImplementation(() => { throw new Error('não enviou') })
    expect(() => svc.continueNow(p.id, 'claude')).toThrow('não enviou')
    expect(store.get(p.id, 'claude')).toMatchObject({ limitAction: 'none', limitResetsAt: resetsAt, limitOrigin: 'claudinei' })
    expect(lastState(p.id).usageLimit).toMatchObject({ action: 'none', origin: 'claudinei' })
  })

  it('turno sem erro limpa e desarma; mensagem do operador limpa e desarma', () => {
    const svc = makeService()
    const a = limited(svc, { name: 'A', auto: true })
    store.bumpLimitTries(a.p.id, 'claude')
    svc.onTurnResult(a.p.id, 'claude', { isError: true })
    expect(store.get(a.p.id, 'claude').limitAction).toBe('armed')
    expect(pending()).toHaveLength(1)
    svc.onTurnResult(a.p.id, 'claude', { isError: false })
    expect(store.get(a.p.id, 'claude')).toMatchObject({ limitHitAt: null, limitAction: 'none', limitTries: 0 })
    expect(lastState(a.p.id).usageLimit).toBeNull()
    expect(pending()).toHaveLength(0)

    const b = limited(svc, { name: 'B', auto: true })
    expect(pending()).toHaveLength(1)
    svc.onOperatorMessage(b.p.id, 'claude')
    expect(store.get(b.p.id, 'claude')).toMatchObject({ limitHitAt: null, limitAction: 'none' })
    expect(lastState(b.p.id).usageLimit).toBeNull()
    expect(pending()).toHaveLength(0)
  })

  it('limite com marca do reinício: a marca é absorvida', () => {
    const svc = makeService()
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    svc.onUsageLimit(p.id, 'claude', { localId, resetsAt: segs(T0) + 3600, origin: 'operator' })
    const st = store.get(p.id, 'claude')
    expect(st.interruptedAt).toBeNull()
    expect(st.limitHitAt).not.toBeNull()
    expect(lastState(p.id)).toMatchObject({ interruption: null, usageLimit: expect.objectContaining({ action: 'none' }) })
  })

  it('durante o encerramento o relógio não envia', async () => {
    const svc = makeService()
    const { p } = limited(svc, { auto: true })
    mgr.beginShutdown()
    await fire()
    await pause()
    expect(limitEchoes()).toHaveLength(0)
    // Continua armado para a próxima subida, e o relógio não entra em laço.
    expect(store.get(p.id, 'claude')).toMatchObject({ limitAction: 'armed', limitTries: 0 })
    expect(pending()).toHaveLength(0)
    expect(svc.continueNow(p.id, 'claude')).toBe(false)
  })

  it('dispose limpa o relógio', () => {
    const svc = makeService()
    limited(svc, { auto: true })
    expect(pending()).toHaveLength(1)
    svc.dispose()
    expect(pending()).toHaveLength(0)
  })
})
