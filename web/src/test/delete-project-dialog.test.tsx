import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeleteProjectDialog } from '../components/DeleteProjectDialog'
import { useStore } from '../store'
import type { EngineMeta, Project, SessionInfo } from '../types'

const project: Project = { id: 1, name: 'Alpha', path: '/tmp/a', icon: '📁', color: '#fff' }
const session = (localId: string, engine: string, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId: 1, status, engine, engineSessionId: 'x', updatedAt: 'x' })
const engine = (id: string, label: string) => ({ id, label }) as unknown as EngineMeta

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const deletes = (fetcher: { mock: { calls: unknown[][] } }) =>
  fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE').map(([url]) => String(url))

const excluir = () => screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement
const ciente = () => screen.getByRole('checkbox') as HTMLInputElement

beforeEach(() => {
  useStore.setState({
    projects: [project], sessions: {},
    engines: [engine('claude', 'Claude Code'), engine('codex', 'Codex'), engine('kimi', 'Kimi Code')],
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('DeleteProjectDialog', () => {
  it('sem sessão aberta: o diálogo de sempre, sem caixa de ciência', async () => {
    useStore.setState({ sessions: { a: session('a', 'claude', 'stopped'), b: session('b', 'codex', 'dead') } })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      init?.method === 'DELETE' ? json(204) : json(200, []))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} onDeleted={onDeleted} onClose={() => {}} />)
    expect(screen.getByText(/Não apaga os arquivos no disco/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(excluir())
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(deletes(fetcher)).toEqual(['/api/projects/1'])
  })

  it('com sessões abertas: lista cada uma e só exclui depois do "estou ciente"', async () => {
    useStore.setState({
      sessions: {
        a: session('a', 'claude', 'working'),
        b: session('b', 'codex', 'in_terminal'),
        c: session('c', 'kimi', 'stopped'),
      },
    })
    let liberar: (r: Response) => void = () => {}
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      init?.method === 'DELETE' ? new Promise<Response>((r) => { liberar = r }) : json(200, []))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} onDeleted={onDeleted} onClose={() => {}} />)

    expect(screen.getByText('Claude Code — trabalhando')).toBeTruthy()
    expect(screen.getByText('Codex — no terminal')).toBeTruthy()
    expect(screen.queryByText(/Kimi Code/)).toBeNull()
    expect(excluir().disabled).toBe(true)

    fireEvent.click(ciente())
    expect(ciente().checked).toBe(true)
    fireEvent.click(excluir())
    // Finalizar leva segundos: o botão não pode mandar o pedido duas vezes.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finalizando sessões…' })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Finalizando sessões…' }) as HTMLButtonElement).disabled).toBe(true)
    liberar(json(204))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(deletes(fetcher)).toEqual(['/api/projects/1?stopSessions=1'])
  })

  it('se uma sessão abriu depois, o servidor recusa e o diálogo pede a ciência com a lista dele', async () => {
    const respostas = [
      json(409, { error: 'projeto tem uma sessão ativa; finalize-a antes de excluir', sessions: [{ localId: 'z', engine: 'codex', status: 'working' }] }),
      json(204),
    ]
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      init?.method === 'DELETE' ? respostas.shift()! : json(200, []))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} onDeleted={onDeleted} onClose={() => {}} />)

    fireEvent.click(excluir())
    await waitFor(() => expect(screen.getByText('Codex — trabalhando')).toBeTruthy())
    expect(screen.getByText(/Uma sessão foi aberta/)).toBeTruthy()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(excluir().disabled).toBe(true)

    fireEvent.click(ciente())
    fireEvent.click(excluir())
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(deletes(fetcher)).toEqual(['/api/projects/1', '/api/projects/1?stopSessions=1'])
  })

  it('se o servidor não consegue finalizar, mostra o erro e não fecha', async () => {
    useStore.setState({ sessions: { a: session('a', 'claude', 'idle') } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => init?.method === 'DELETE'
      ? json(409, { error: 'não foi possível finalizar todas as sessões; o terminal não foi excluído', sessions: [{ localId: 'a', engine: 'claude', status: 'idle' }] })
      : json(200, []))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} onDeleted={onDeleted} onClose={() => {}} />)
    fireEvent.click(ciente())
    fireEvent.click(excluir())
    await waitFor(() => expect(screen.getByText(/não foi possível finalizar todas as sessões/)).toBeTruthy())
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByText('Claude Code — ociosa')).toBeTruthy()
  })
})
