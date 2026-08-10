import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions, type SessionStatus } from '../src/claude/session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')

const open = () =>
  new ClaudeSession({
    projectPath: mkdtempSync(join(tmpdir(), 'bgtask-')),
    claudeBin: process.execPath,
    extraArgsOverride: [FAKE_CLAUDE],
  } as SessionOptions)

let session: ClaudeSession | undefined
afterEach(async () => { await session?.stop(); session = undefined })

const feed = (s: ClaudeSession, obj: object) =>
  (s as unknown as { handleEvent: (e: unknown) => void }).handleEvent(obj)

const tasksChanged = (tasks: object[]) =>
  ({ kind: 'system', subtype: 'background_tasks_changed', raw: { subtype: 'background_tasks_changed', tasks } })

const started = (task_id: string, description: string, subagent_type = 'general-purpose') =>
  ({ kind: 'system', subtype: 'task_started', raw: { subtype: 'task_started', task_id, description, subagent_type, prompt: `faça ${description}` } })

const result = () => ({ kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} })

const ready = () => {
  const s = open()
  s.start()
  feed(s, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
  feed(s, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })
  return s
}

/**
 * Uma task em background continua rodando DEPOIS que o turno que a despachou
 * fecha. Se o result devolvesse a sessão para needs_attention, o terminal
 * apareceria parado enquanto ainda há trabalho em curso — e o filtro "somente
 * ativos" o esconderia.
 */
describe('tasks em background seguram o fim do turno', () => {
  it('com task ativa, o result NÃO devolve a sessão para needs_attention', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Contar' }]))
    feed(session, result())
    expect(session.status).toBe('working')
  })

  it('quando a lista esvazia, o próximo result fecha o turno normalmente', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Contar' }]))
    feed(session, result())
    feed(session, tasksChanged([]))
    feed(session, result())
    expect(session.status).toBe('needs_attention')
  })

  it('sem nenhuma task em background, o result fecha como sempre', () => {
    session = ready()
    feed(session, result())
    expect(session.status).toBe('needs_attention')
  })

  it('expõe as tasks ativas com descrição e tipo', () => {
    session = ready()
    feed(session, started('a1', 'Contar de 1 a 5', 'Explore'))
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Contar de 1 a 5' }]))
    expect(session.backgroundTasks).toEqual([
      { id: 'a1', description: 'Contar de 1 a 5', type: 'Explore' },
    ])
  })

  it('a lista recebida substitui a anterior (é autoritativa)', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }, { task_id: 'a2', description: 'Dois' }]))
    expect(session.backgroundTasks).toHaveLength(2)
    feed(session, tasksChanged([{ task_id: 'a2', description: 'Dois' }]))
    expect(session.backgroundTasks.map((t) => t.id)).toEqual(['a2'])
    feed(session, tasksChanged([]))
    expect(session.backgroundTasks).toEqual([])
  })

  it('avisa os clientes quando a lista de tasks muda', () => {
    session = ready()
    const seen: SessionStatus[] = []
    session.on('status', (s: SessionStatus) => seen.push(s))
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }]))
    // Reusa o canal de status: a UI precisa saber que a composição mudou mesmo
    // quando o status em si continua 'working'.
    expect(seen.length).toBeGreaterThan(0)
  })

  it('parar a sessão limpa as tasks (nada continua rodando)', async () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }]))
    await session.stop()
    expect(session.backgroundTasks).toEqual([])
  })
})
