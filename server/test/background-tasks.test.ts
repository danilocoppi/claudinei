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

  it('encerra a resposta com Hardhat, DynamoDB e backend em background sem parar os processos', () => {
    session = ready()
    feed(session, tasksChanged(['Hardhat', 'DynamoDB', 'Backend'].map((description, i) => ({ task_id: `b${i}`, task_type: 'local_bash', description }))))
    feed(session, result())
    expect(session.status).toBe('needs_attention')
    expect(session.backgroundTasks).toHaveLength(3)
    expect(session.backgroundTasks.every((task) => task.taskType === 'local_bash')).toBe(true)
    session.markRead()
    expect(session.status).toBe('idle')
    session.send('próxima tarefa')
    expect(session.status).toBe('working')
  })

  it('espera pelo agente real e encerra quando ele termina, mesmo com shell ainda ligado e sem outro result', () => {
    session = ready()
    feed(session, tasksChanged([
      { task_id: 'a1', task_type: 'local_agent', description: 'Revisão' },
      { task_id: 'b1', task_type: 'local_bash', description: 'Servidor' },
    ]))
    feed(session, result())
    expect(session.status).toBe('working')
    feed(session, { kind: 'system', subtype: 'task_notification', raw: { subtype: 'task_notification', task_id: 'a1', status: 'completed' } })
    expect(session.status).toBe('needs_attention')
    expect(session.backgroundTasks.map((task) => task.id)).toEqual(['b1'])
    // O turno automático da notificação é trabalho novo e continua funcionando.
    feed(session, { kind: 'system', subtype: 'turn_starting', raw: { subtype: 'turn_starting', mode: 'task-notification' } })
    expect(session.status).toBe('working')
    feed(session, result())
    expect(session.status).toBe('needs_attention')
  })

  it('esvaziar a lista não encerra uma resposta que ainda está sendo gerada', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', task_type: 'local_agent' }]))
    feed(session, tasksChanged([]))
    expect(session.status).toBe('working')
    feed(session, result())
    expect(session.status).toBe('needs_attention')
  })

  it('conclusão por snapshot basta quando o turno principal já terminou', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', task_type: 'local_agent' }]))
    feed(session, result())
    feed(session, tasksChanged([]))
    expect(session.status).toBe('needs_attention')
  })

  it.each(['stopped', 'failed', 'killed'])('remove task com status %s', (status) => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', task_type: 'local_agent' }]))
    feed(session, result())
    feed(session, { kind: 'system', subtype: 'task_updated', raw: { subtype: 'task_updated', task_id: 'a1', patch: { status } } })
    expect(session.backgroundTasks).toEqual([])
    expect(session.status).toBe('needs_attention')
  })

  it('a mudança para ambient libera a sessão e atualiza clientes sem mudança de IDs', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', task_type: 'local_agent', ambient: false }]))
    feed(session, result())
    const statuses: string[] = []
    session.on('status', (s) => statuses.push(s))
    feed(session, tasksChanged([{ task_id: 'a1', task_type: 'local_agent', ambient: true }]))
    expect(session.status).toBe('needs_attention')
    expect(session.backgroundTasks[0].ambient).toBe(true)
    expect(statuses).toContain('needs_attention')
  })

  it('expõe as tasks ativas com descrição e tipo', () => {
    session = ready()
    feed(session, started('a1', 'Contar de 1 a 5', 'Explore'))
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Contar de 1 a 5' }]))
    expect(session.backgroundTasks).toEqual([
      { id: 'a1', description: 'Contar de 1 a 5', type: 'Explore', prompt: 'faça Contar de 1 a 5' },
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

/**
 * O task_started traz também o `prompt`. Sem guardá-lo, expandir um subagente de
 * background mostrava um painel vazio: a lista não repete a descrição longa e a
 * atividade interna não vem no stream principal.
 */
describe('detalhe da task em background', () => {
  it('guarda o prompt que o task_started trouxe', () => {
    session = ready()
    feed(session, started('a1', 'Contar', 'Explore'))
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Contar' }]))
    expect(session.backgroundTasks[0]).toMatchObject({
      id: 'a1', description: 'Contar', type: 'Explore', prompt: 'faça Contar',
    })
  })

  it('sem task_started prévio, expõe a task mesmo assim (sem prompt)', () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'zz', description: 'Órfã' }]))
    expect(session.backgroundTasks[0]).toMatchObject({ id: 'zz', description: 'Órfã', prompt: '' })
  })
})

/**
 * "Parar" precisa parar TUDO. O control `interrupt` aborta o TURNO, e uma task de
 * background não vive dentro do turno — era por isso que o Stop do chat a deixava
 * rodando. O protocolo tem um comando próprio para ela:
 *   { subtype: 'stop_task', task_id }   "Stops a running task."
 */
describe('parar tasks em background', () => {
  it('interrupt informa a falha e mantém working se um subagente não parou', async () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'stop-fails', task_type: 'local_agent', description: 'Revisão' }]))
    feed(session, result())
    await expect(session.interrupt()).rejects.toThrow('task não parou')
    expect(session.backgroundTasks).toHaveLength(1)
    expect(session.status).toBe('working')
  })

  it('não retira da lista um processo cuja parada falhou', async () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'stop-fails', task_type: 'local_bash', description: 'Servidor' }]))
    feed(session, result())
    await expect(session.stopTask('stop-fails')).rejects.toThrow('task não parou')
    expect(session.backgroundTasks.map((task) => task.id)).toEqual(['stop-fails'])
    expect(session.status).toBe('needs_attention')
  })

  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 25))
  }

  it('stopTask tira a task da lista', async () => {
    session = ready()
    feed(session, started('a1', 'Um'))
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }]))
    expect(session.backgroundTasks).toHaveLength(1)

    await session.stopTask('a1')
    await wait(() => session!.backgroundTasks.length === 0)
    expect(session.backgroundTasks).toEqual([])
  })

  it('interrupt para também as tasks em background', async () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }, { task_id: 'a2', description: 'Dois' }]))

    await session.interrupt()
    await wait(() => session!.backgroundTasks.length === 0)
    expect(session.backgroundTasks).toEqual([])
  })

  /**
   * O guard antigo (`status !== 'working'` → no-op) deixava o Stop sem efeito
   * nenhum e sem aviso. Com task em background ainda há o que parar.
   */
  it('interrupt fora de working ainda para as tasks pendentes', async () => {
    session = ready()
    feed(session, tasksChanged([{ task_id: 'a1', description: 'Um' }]))
    ;(session as unknown as { setStatus: (s: string) => void }).setStatus('idle')

    await session.interrupt()
    await wait(() => session!.backgroundTasks.length === 0)
    expect(session.backgroundTasks).toEqual([])
  })
})
