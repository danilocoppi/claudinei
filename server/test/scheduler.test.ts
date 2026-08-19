import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSchedulesStore, type SchedulesStore } from '../src/schedules/store.js'
import { createScheduler, type SchedulerManager } from '../src/schedules/scheduler.js'
import type { SessionInfo } from '../src/claude/manager.js'

let db: Db
let store: SchedulesStore
let projectId: number

const sessionInfo = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  localId: 's1', projectId, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...over,
} as SessionInfo)

/** Gerenciador de mentira que registra o que o agendador pediu. */
function fakeManager(over: Partial<SchedulerManager> & { sessions?: SessionInfo[] } = {}) {
  const calls = {
    sent: [] as { localId: string; text: string; wait: boolean }[],
    options: [] as { localId: string; opts: Record<string, unknown> }[],
    started: [] as { projectId: number; engine?: string; effort?: string }[],
    revived: [] as string[],
  }
  let sessions = over.sessions ?? [sessionInfo()]
  const manager: SchedulerManager = {
    list: () => sessions,
    start: (project, opts) => {
      calls.started.push({ projectId: project.id, engine: opts?.engine, effort: opts?.effort })
      const info = sessionInfo({ localId: 'novo', status: 'idle', engine: opts?.engine ?? 'claude', effort: opts?.effort ?? null })
      sessions = [...sessions, info]
      return info
    },
    revive: (localId) => {
      calls.revived.push(localId)
      const info = sessionInfo({ localId, status: 'idle' })
      sessions = sessions.map((s) => (s.localId === localId ? info : s))
      return info
    },
    setSessionOptions: async (localId, opts) => {
      calls.options.push({ localId, opts: opts as Record<string, unknown> })
      sessions = sessions.map((s) => (s.localId === localId ? { ...s, ...opts } as SessionInfo : s))
      return sessions.find((s) => s.localId === localId)!
    },
    sendAndWait: async (localId, text, opts) => {
      calls.sent.push({ localId, text, wait: opts?.wait !== false })
      return opts?.wait === false ? null : `resposta de ${text.slice(0, 12)}`
    },
    ...over,
  }
  return { manager, calls }
}

const base = { name: 'Preços', task: 'buscar preços', cadence: { kind: 'daily' as const, at: '12:00' } }
const overdue = (id: number, minutesAgo = 1) =>
  db.prepare(`UPDATE schedules SET next_run_at=? WHERE id=?`)
    .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), id)

beforeEach(() => {
  db = openDb(':memory:')
  store = createSchedulesStore(db, { dir: mkdtempSync(join(tmpdir(), 'sched-')) })
  projectId = createProjectsService(db).create({ name: 'alpha', path: mkdtempSync(join(tmpdir(), 'p-')) }).id
})

describe('disparo', () => {
  it('envia a tarefa com o selo do agendamento e guarda a resposta', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).tick()

    expect(calls.sent).toHaveLength(1)
    expect(calls.sent[0].text).toBe('[Agendamento: Preços #1]: buscar preços')
    const [run] = store.listRuns(s.id, 1)
    expect(run.status).toBe('ok')
    expect(store.readContent(s.id, run.seq)).toContain('resposta de')
  })

  it('recalcula a próxima execução para o futuro depois de disparar', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    await createScheduler({ db, store, manager: fakeManager().manager }).tick()
    expect(new Date(store.get(s.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
  })

  it('não dispara agendamento pausado, nem com horário vencido', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    store.setEnabled(s.id, false)
    overdue(s.id)
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).tick()
    expect(calls.sent).toHaveLength(0)
  })

  it('sem esperar resposta, fecha na hora e não guarda conteúdo', async () => {
    const s = store.create(projectId, { ...base, expectsResult: false })
    overdue(s.id)
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).tick()
    expect(calls.sent[0].wait).toBe(false)
    const [run] = store.listRuns(s.id, 1)
    expect(run.status).toBe('ok')
    expect(run.contentSize).toBeNull()
  })
})

describe('as três decisões da spec', () => {
  it('sobreposição: pula e REGISTRA em vez de enfileirar ou interromper', async () => {
    const s = store.create(projectId, base)
    store.startRun(s.id, {})           // uma execução ainda em curso
    overdue(s.id)
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).tick()

    expect(calls.sent).toHaveLength(0)
    expect(store.listRuns(s.id, 2)[0].status).toBe('skipped')
    expect(new Date(store.get(s.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
  })

  it('sessão ocupada com um turno do operador também é sobreposição', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [sessionInfo({ status: 'working' })] })
    await createScheduler({ db, store, manager }).tick()
    expect(calls.sent).toHaveLength(0)
    expect(store.listRuns(s.id, 1)[0].status).toBe('skipped')
  })

  it('execução perdida enquanto o servidor esteve fora roda UMA vez, marcada como atrasada', async () => {
    const s = store.create(projectId, base)
    overdue(s.id, 60 * 26)             // 26 h atrás: perdeu um dia inteiro
    const { manager, calls } = fakeManager()
    const scheduler = createScheduler({ db, store, manager })
    await scheduler.tick()
    await scheduler.tick()             // o segundo tick não deve disparar de novo

    expect(calls.sent).toHaveLength(1)
    expect(store.listRuns(s.id, 5)[0].late).toBe(true)
  })

  it('disparo no horário não é marcado como atrasado', async () => {
    const s = store.create(projectId, base)
    db.prepare(`UPDATE schedules SET next_run_at=? WHERE id=?`).run(new Date(Date.now() - 5_000).toISOString(), s.id)
    await createScheduler({ db, store, manager: fakeManager().manager }).tick()
    expect(store.listRuns(s.id, 1)[0].late).toBe(false)
  })
})

describe('a sessão certa, no estado certo', () => {
  it('sobe o terminal morto antes de enviar', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [sessionInfo({ status: 'dead' })] })
    await createScheduler({ db, store, manager }).tick()
    expect(calls.revived).toEqual(['s1'])
    expect(calls.sent).toHaveLength(1)
  })

  it('sem nenhuma sessão do projeto, inicia uma da engine pedida', async () => {
    const s = store.create(projectId, { ...base, engine: 'codex' })
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [] })
    await createScheduler({ db, store, manager }).tick()
    expect(calls.started).toEqual([{ projectId, engine: 'codex', effort: undefined }])
  })

  it('escolhe a sessão da engine do agendamento quando há mais de uma', async () => {
    const s = store.create(projectId, { ...base, engine: 'codex' })
    overdue(s.id)
    const { manager, calls } = fakeManager({
      sessions: [sessionInfo({ localId: 'cl', engine: 'claude' }), sessionInfo({ localId: 'cx', engine: 'codex' })],
    })
    await createScheduler({ db, store, manager }).tick()
    expect(calls.sent[0].localId).toBe('cx')
  })

  it('falha ao subir vira execução com erro e conta falha', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    const { manager } = fakeManager({
      sessions: [],
      start: () => { throw new Error('pasta do projeto sumiu') },
    })
    await createScheduler({ db, store, manager }).tick()
    const [run] = store.listRuns(s.id, 1)
    expect(run.status).toBe('error')
    expect(run.error).toMatch(/pasta do projeto sumiu/)
    expect(store.get(s.id)!.consecutiveFailures).toBe(1)
  })
})

describe('model e effort', () => {
  it('aplica o model só quando difere do atual', async () => {
    const s = store.create(projectId, { ...base, model: 'opus' })
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [sessionInfo({ model: 'sonnet' })] })
    await createScheduler({ db, store, manager }).tick()
    expect(calls.options).toEqual([{ localId: 's1', opts: { model: 'opus' } }])

    const s2 = store.create(projectId, { ...base, model: 'opus' })
    overdue(s2.id)
    const two = fakeManager({ sessions: [sessionInfo({ model: 'opus' })] })
    await createScheduler({ db, store, manager: two.manager }).tick()
    expect(two.calls.options).toEqual([])
  })

  /**
   * Effort não tem control_request: aplica-se mandando /effort como mensagem. Sem
   * esperar e DESCARTAR esse primeiro resultado, o que ficaria guardado no feed
   * seria a resposta do /effort, não a da tarefa.
   */
  it('numa sessão de pé, manda /effort antes e guarda o resultado da TAREFA', async () => {
    const s = store.create(projectId, { ...base, effort: 'high' })
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [sessionInfo({ effort: 'low' })] })
    await createScheduler({ db, store, manager }).tick()

    expect(calls.sent.map((c) => c.text)).toEqual(['/effort high', '[Agendamento: Preços #1]: buscar preços'])
    expect(store.readContent(s.id, 1)).toContain('[Agendamento')
  })

  it('quando é a execução que sobe a sessão, o effort vai como flag — sem turno extra', async () => {
    const s = store.create(projectId, { ...base, effort: 'high' })
    overdue(s.id)
    const { manager, calls } = fakeManager({ sessions: [] })
    await createScheduler({ db, store, manager }).tick()

    expect(calls.started[0].effort).toBe('high')
    expect(calls.sent.map((c) => c.text)).toEqual(['[Agendamento: Preços #1]: buscar preços'])
  })
})

describe('executar agora', () => {
  it('dispara sem mexer no horário da próxima execução', async () => {
    const s = store.create(projectId, base)
    const before = store.get(s.id)!.nextRunAt
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).runNow(s.id)
    expect(calls.sent).toHaveLength(1)
    expect(store.get(s.id)!.nextRunAt).toBe(before)
  })

  it('respeita a sobreposição como o disparo automático', async () => {
    const s = store.create(projectId, base)
    store.startRun(s.id, {})
    const { manager, calls } = fakeManager()
    await createScheduler({ db, store, manager }).runNow(s.id)
    expect(calls.sent).toHaveLength(0)
  })
})

describe('timeout', () => {
  it('conta como falha e não perde a execução', async () => {
    const s = store.create(projectId, base)
    overdue(s.id)
    const { manager } = fakeManager({
      sendAndWait: async () => { throw new Error('timed out waiting for the agent response') },
    })
    await createScheduler({ db, store, manager }).tick()
    const [run] = store.listRuns(s.id, 1)
    expect(run.status).toBe('timeout')
    expect(store.get(s.id)!.consecutiveFailures).toBe(1)
  })
})

describe('laço', () => {
  it('start/stop não deixa temporizador pendurado', () => {
    vi.useFakeTimers()
    const scheduler = createScheduler({ db, store, manager: fakeManager().manager })
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
