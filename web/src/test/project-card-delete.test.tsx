import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ProjectCard } from '../components/ProjectCard'
import { useStore } from '../store'
import type { Project, SessionInfo } from '../types'

const project: Project = { id: 1, name: 'AiShiba', path: '/tmp/a', color: '#ff0000', icon: '🐕' }

const okJson = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  useStore.setState({
    projects: [project],
    sessions: {},
    chat: {},
    unread: {},
    view: 'dashboard',
    activeLocalId: undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ProjectCard - excluir', () => {
  it('clicar no botão 🗑 abre o ConfirmDialog e não abre a sessão', () => {
    const openSession = vi.fn()
    useStore.setState({ openSession })
    render(<ProjectCard project={project} unread={0} />)

    fireEvent.click(screen.getByTitle('Excluir projeto'))

    expect(screen.getByText('Excluir AiShiba?')).toBeTruthy()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('confirmar exclusão chama DELETE na URL certa, recarrega projetos e fecha o diálogo', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/projects/1' ) return okJson(undefined, 204)
      if (String(url) === '/api/projects') return okJson([])
      throw new Error(`unexpected url ${url}`)
    })
    render(<ProjectCard project={project} unread={0} />)

    fireEvent.click(screen.getByTitle('Excluir projeto'))
    fireEvent.click(screen.getByText('Excluir'))

    await vi.waitFor(() => expect(useStore.getState().projects).toEqual([]))

    expect(spy).toHaveBeenCalledWith('/api/projects/1', expect.objectContaining({ method: 'DELETE' }))
    expect(screen.queryByText('Excluir AiShiba?')).toBeNull()
  })

  it('DELETE 409 mostra mensagem de erro no diálogo e não fecha', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'Sessão ativa: pare a sessão antes de excluir.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    render(<ProjectCard project={project} unread={0} />)

    fireEvent.click(screen.getByTitle('Excluir projeto'))
    fireEvent.click(screen.getByText('Excluir'))

    expect(await screen.findByText('Sessão ativa: pare a sessão antes de excluir.')).toBeTruthy()
    expect(screen.getByText('Excluir AiShiba?')).toBeTruthy()
  })

  it('reabrir o diálogo após um erro não mostra a mensagem antiga', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'projeto tem uma sessão ativa; finalize-a antes de excluir' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    render(<ProjectCard project={project} unread={0} />)

    fireEvent.click(screen.getByTitle('Excluir projeto'))
    fireEvent.click(screen.getByText('Excluir'))

    expect(await screen.findByText(/sessão ativa/)).toBeTruthy()

    fireEvent.click(screen.getByText('Cancelar'))
    fireEvent.click(screen.getByTitle('Excluir projeto'))

    expect(screen.queryByText(/sessão ativa/)).toBeNull()
  })
})

describe('ProjectCard - Reviver pergunta a engine', () => {
  const stoppedSession: SessionInfo = {
    localId: 's1', projectId: 1, status: 'stopped', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
  }

  it('clicar em Reviver abre o seletor de engine em vez de reviver direto', () => {
    render(<ProjectCard project={project} session={stoppedSession} unread={0} />)
    fireEvent.click(screen.getByText('Reviver'))
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
  })

  it('escolher a engine no seletor chama /revive daquela sessão e abre a sessão', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/sessions/s1/revive') {
        return new Response(JSON.stringify({ localId: 's1', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x', engine: 'claude' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const openSession = vi.fn()
    useStore.setState({ openSession, sessions: { s1: stoppedSession } })
    render(<ProjectCard project={project} session={stoppedSession} unread={0} />)

    fireEvent.click(screen.getByText('Reviver'))
    fireEvent.click(screen.getByText('Claude Code'))

    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/sessions/s1/revive', expect.objectContaining({ method: 'POST' })))
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledWith('s1'))
    spy.mockRestore()
  })
})
