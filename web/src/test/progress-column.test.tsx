import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ProgressColumn, ProgressButton } from '../components/ProgressColumn'
import { useStore, progressKey } from '../store'
import type { Progress } from '../types'

/**
 * A coluna do acompanhamento de tarefas longas, à direita do chat: o que o
 * agente informou pela ferramenta update_progress, do terminal (projeto + motor)
 * da aba aberta. Ver docs/superpowers/specs/2026-11-18-acompanhamento-de-tarefas-design.md.
 */
const PATH = '/home/u/.claudinei/acompanhamento/1-claude.json'
const andamento = (o: Partial<Progress> = {}): Progress => ({
  title: 'Três páginas do site',
  now: { title: 'Fazendo contato.html', detail: 'título e um parágrafo' },
  tasks: [
    { name: 'cardapio.html', status: 'done' },
    { name: 'encomendas.html', status: 'done', note: 'com formulário' },
    { name: 'contato.html', status: 'in_progress' },
  ],
  waiting: ['Qual telefone pôr no contato?'],
  updatedAt: new Date().toISOString(),
  ...o,
})
const api = (progress: Progress | null) => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ progress, path: PATH }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  return spy
}

beforeEach(() => { localStorage.clear(); useStore.setState({ progress: {}, progressOpen: true }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('coluna do acompanhamento', () => {
  it('sem acompanhamento mostra o vazio', async () => {
    api(null)
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="idle" />)
    expect(await screen.findByText(/ainda não tem tarefa longa/)).toBeTruthy()
  })

  it('desenha título, contagem, agora, tarefas com estado e esperando você', async () => {
    api(andamento())
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="working" />)
    expect(await screen.findByText('Três páginas do site')).toBeTruthy()
    expect(screen.getByText('2 de 3')).toBeTruthy()
    expect(screen.getByText('Fazendo contato.html')).toBeTruthy()
    expect(screen.getByText('título e um parágrafo')).toBeTruthy()
    expect(screen.getAllByText('concluída')).toHaveLength(2)
    expect(screen.getByText('em andamento')).toBeTruthy()
    expect(screen.getByText('com formulário')).toBeTruthy()
    expect(screen.getByText('Esperando você')).toBeTruthy()
    expect(screen.getByText('Qual telefone pôr no contato?')).toBeTruthy()
    expect(screen.getByText(PATH)).toBeTruthy()
  })

  it('estado novo pelo WebSocket atualiza a coluna', async () => {
    api(andamento())
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="working" />)
    await screen.findByText('2 de 3')
    act(() => useStore.getState().applyWsMessage({ type: 'progress', projectId: 1, engine: 'claude',
      progress: andamento({ tasks: andamento().tasks.map((t) => ({ ...t, status: 'done' as const })), waiting: [] }) }))
    expect(screen.getByText('3 de 3')).toBeTruthy()
    expect(screen.queryByText('Esperando você')).toBeNull()
  })

  it('botão abre e fecha, e a bolinha só com tarefa em andamento', () => {
    useStore.setState({ progressOpen: false })
    useStore.getState().setProgress(1, 'claude', andamento())
    const { container, rerender } = render(<ProgressButton projectId={1} engine="claude" sessionStatus="working" />)
    const botao = screen.getByRole('button', { name: 'Acompanhamento' })
    expect(botao.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(botao)
    expect(useStore.getState().progressOpen).toBe(true)
    expect(container.querySelector('.progress-btn__dot')).not.toBeNull()
    rerender(<ProgressButton projectId={1} engine="claude" sessionStatus="dead" />)
    expect(container.querySelector('.progress-btn__dot')).toBeNull()
    act(() => useStore.getState().setProgress(1, 'claude', andamento({ tasks: [{ name: 'a', status: 'done' }] })))
    rerender(<ProgressButton projectId={1} engine="claude" sessionStatus="working" />)
    expect(container.querySelector('.progress-btn__dot')).toBeNull()
  })

  it('terminal parado com tarefa em andamento avisa; ocioso não', async () => {
    api(andamento())
    const { rerender, container } = render(<ProgressColumn projectId={1} engine="claude" sessionStatus="dead" />)
    expect(await screen.findByText(/pode estar desatualizado/)).toBeTruthy()
    expect(container.querySelector('.progress__pulse--off')).not.toBeNull()
    rerender(<ProgressColumn projectId={1} engine="claude" sessionStatus="idle" />)
    expect(screen.queryByText(/pode estar desatualizado/)).toBeNull()
    rerender(<ProgressColumn projectId={1} engine="claude" />)
    expect(screen.getByText(/pode estar desatualizado/)).toBeTruthy()
  })

  it('motor da aba: a coluna do Codex não mostra o do Claude', async () => {
    useStore.getState().setProgress(1, 'claude', andamento())
    api(null)
    render(<ProgressColumn projectId={1} engine="codex" sessionStatus="idle" />)
    expect(await screen.findByText(/ainda não tem tarefa longa/)).toBeTruthy()
    expect(screen.queryByText('Três páginas do site')).toBeNull()
  })

  it('descartar pede confirmação e apaga', async () => {
    const fetchSpy = api(andamento())
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="idle" />)
    await screen.findByText('Três páginas do site')
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(fetchSpy.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Descartar acompanhamento' }))
    await waitFor(() => expect(fetchSpy.mock.calls.some(([u, i]) => i?.method === 'DELETE' && String(u).includes('/api/projects/1/progress?engine=claude'))).toBe(true))
    await waitFor(() => expect(useStore.getState().progress[progressKey(1, 'claude')]).toBeNull())
  })

  it('atualizado há mais de 45 min fica âmbar com tarefa aberta', async () => {
    api(andamento({ updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }))
    const { container } = render(<ProgressColumn projectId={1} engine="claude" sessionStatus="idle" />)
    await screen.findByText('Três páginas do site')
    expect(container.querySelector('.progress__updated--old')).not.toBeNull()
    act(() => useStore.getState().setProgress(1, 'claude', andamento()))
    expect(container.querySelector('.progress__updated--old')).toBeNull()
  })
})
