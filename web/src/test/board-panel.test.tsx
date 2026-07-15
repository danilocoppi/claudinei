import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BoardPanel } from '../components/BoardPanel'
import { useStore } from '../store'

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BoardPanel', () => {
  it('carrega e mostra posts do board (mais novo primeiro, como veio da API)', async () => {
    useStore.setState({
      projects: [{ id: 1, name: 'AiShiba', path: '/tmp/a', color: '#ff0000', icon: '🐕' }],
      board: [],
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        jsonResponse([
          { id: 2, projectId: 1, projectName: 'AiShiba', title: 'Segundo aviso', content: 'conteúdo 2', createdAt: '2026-07-09T10:00:00Z' },
          { id: 1, projectId: 1, projectName: 'AiShiba', title: 'Primeiro aviso', content: 'conteúdo 1', createdAt: '2026-07-09T09:00:00Z' },
        ]),
      ),
    )

    render(<BoardPanel />)

    expect(await screen.findByText('Segundo aviso')).toBeTruthy()
    expect(screen.getByText('Primeiro aviso')).toBeTruthy()
    expect(screen.getAllByText('AiShiba')).toHaveLength(2)
  })

  it('mostra estado vazio quando não há posts', async () => {
    useStore.setState({ projects: [], board: [] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))

    render(<BoardPanel />)

    expect(await screen.findByText('O mural está vazio. Os agentes publicam avisos aqui.')).toBeTruthy()
  })
})
