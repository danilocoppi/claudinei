import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TasksPanel } from '../components/TasksPanel'
import { useStore } from '../store'

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TasksPanel', () => {
  it('carrega e mostra tarefas com status variados, incluindo result', async () => {
    useStore.setState({ tasks: [] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse([
          {
            id: 3, fromProjectId: 1, fromProjectName: 'AiShiba', toProjectId: 2, toProjectName: 'Termaster',
            description: 'Rodar testes', status: 'in_progress', result: null,
            createdAt: '2026-07-09T10:00:00Z', updatedAt: '2026-07-09T10:00:00Z',
          },
          {
            id: 2, fromProjectId: null, fromProjectName: null, toProjectId: 2, toProjectName: 'Termaster',
            description: 'Corrigir bug', status: 'completed', result: 'Bug corrigido com sucesso',
            createdAt: '2026-07-09T09:00:00Z', updatedAt: '2026-07-09T09:30:00Z',
          },
          {
            id: 1, fromProjectId: 1, fromProjectName: 'AiShiba', toProjectId: 3, toProjectName: 'Outro',
            description: 'Deploy', status: 'failed', result: 'Erro de rede',
            createdAt: '2026-07-09T08:00:00Z', updatedAt: '2026-07-09T08:15:00Z',
          },
          {
            id: 4, fromProjectId: 2, fromProjectName: 'Termaster', toProjectId: 3, toProjectName: 'Outro',
            description: 'Escrever docs', status: 'queued', result: null,
            createdAt: '2026-07-09T11:00:00Z', updatedAt: '2026-07-09T11:00:00Z',
          },
        ]),
      ),
    )

    render(<TasksPanel />)

    expect(await screen.findByText('Rodar testes')).toBeTruthy()
    expect(screen.getByText('em andamento')).toBeTruthy()
    expect(screen.getByText('concluída')).toBeTruthy()
    expect(screen.getByText('falhou')).toBeTruthy()
    expect(screen.getByText('na fila')).toBeTruthy()
    expect(screen.getByText('Bug corrigido com sucesso')).toBeTruthy()
    expect(screen.getByText('Erro de rede')).toBeTruthy()
    // o from → to agora é dividido em spans (chips de engine entre eles)
    const fromTo = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.replace(/\s+/g, '').includes('operador→Termaster'))
    expect(fromTo).toBeTruthy()
    const fromTo2 = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.replace(/\s+/g, '').includes('AiShiba→Termaster'))
    expect(fromTo2).toBeTruthy()
  })

  it('mostra estado vazio quando não há tarefas', async () => {
    useStore.setState({ tasks: [] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))

    render(<TasksPanel />)

    expect(
      await screen.findByText('Nenhuma tarefa despachada ainda. Um agente pode delegar tarefas com a ferramenta dispatch_task.'),
    ).toBeTruthy()
  })
})

describe('engine responsável (quem despachou → quem executou)', () => {
  it('task entre engines do MESMO projeto mostra o chip de cada engine', async () => {
    useStore.setState({ tasks: [] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse([{
        id: 9, fromProjectId: 1, fromProjectName: 'Vaexa', toProjectId: 1, toProjectName: 'Vaexa',
        fromEngine: 'claude', toEngine: 'codex',
        description: 'Implementar H-19', status: 'completed', result: 'ok',
        createdAt: '2026-07-14T23:36:37Z', updatedAt: '2026-07-14T23:40:00Z',
      }])),
    )
    render(<TasksPanel />)
    expect(await screen.findByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(document.querySelectorAll('.task-engine')).toHaveLength(2)
  })

  it('task sem engines (antiga/operador) não mostra chip nenhum', async () => {
    useStore.setState({ tasks: [] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(jsonResponse([{
        id: 8, fromProjectId: null, fromProjectName: null, toProjectId: 2, toProjectName: 'Beta',
        fromEngine: null, toEngine: null,
        description: 'antiga', status: 'queued', result: null,
        createdAt: '2026-07-14T22:00:00Z', updatedAt: '2026-07-14T22:00:00Z',
      }])),
    )
    render(<TasksPanel />)
    expect(await screen.findByText('antiga')).toBeTruthy()
    expect(document.querySelectorAll('.task-engine')).toHaveLength(0)
  })
})
