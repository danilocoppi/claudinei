import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { renderComJanela as render } from './viewport'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useUndoStore } from '../undo/undoStore'
import type { ChatItem, EngineMeta, SessionInfo } from '../types'
import type { TerminalTurnsDto, TurnDto } from '../../../shared/undo'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }

const turn = (id: number, key: string, over: Partial<TurnDto> = {}): TurnDto => ({
  id, localId: 'a', projectId: 1, engine: 'claude', origin: 'operator', key, midTurn: false,
  state: 'ok', limited: false, endKind: 'result',
  summary: { files: 3, added: 40, removed: 12, outside: 0, uncertain: 0, unsnapshotted: 0 },
  lastRun: null, startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const ITEMS: ChatItem[] = [
  { kind: 'user_text', text: 'faça X', key: 'k0' },
  { kind: 'assistant_text', text: 'fazendo', key: 'k1' },
  { kind: 'assistant_text', text: 'feito X', key: 'k2' },
  { kind: 'user_text', text: 'faça Y', key: 'k3' },
  { kind: 'assistant_text', text: 'feito Y', key: 'k4' },
]

let dto: TerminalTurnsDto
beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  dto = { git: true, turns: [turn(1, 'faça X'), turn(2, 'faça Y', { summary: { files: 1, added: 2, removed: 0, outside: 0, uncertain: 0, unsnapshotted: 0 } })], outside: [], interactive: [], intervals: [] }
  useUndoStore.setState({ byLocal: {}, terminalOf: {} })
  useStore.setState({
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁' }],
    sessions: { a: sess }, chat: { a: ITEMS }, unread: {}, streaming: {},
    historyLoadedFor: { a: 'c' }, historyCursor: { a: { before: 0, atStart: true, conv: 'c' } },
    view: 'chat', activeLocalId: 'a', engines: [CLAUDE],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    json(String(url).startsWith('/api/undo/terminals/a/turns') ? dto
      : String(url).startsWith('/api/undo/turns/') ? { files: [], hiddenOutside: 0, warnings: [] } : []))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const entradaDe = (el: HTMLElement) => el.closest<HTMLElement>('.chat-entry')?.dataset.key

describe('ChatView com as linhas do turno', () => {
  it('ChatView desenha a linha depois do último item do bloco', async () => {
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const tres = await screen.findByText('3 arquivos')
    expect(entradaDe(tres)).toBe('k2')
    // A linha vem depois do texto do item, no fim da entrada.
    const entrada = tres.closest('.chat-entry')!
    expect(entrada.textContent!.indexOf('feito X')).toBeLessThan(entrada.textContent!.indexOf('3 arquivos'))
    expect(entradaDe(screen.getByText('1 arquivo'))).toBe('k4')
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u))).toContain('/api/undo/terminals/a/turns')
  })

  it('Ver mudanças abre o painel do turno e fecha', async () => {
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const tres = await screen.findByText('3 arquivos')
    const linha = tres.closest<HTMLElement>('.undo-line')!
    fireEvent.click(linha.querySelector<HTMLButtonElement>('button')!)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u))).toContain('/api/undo/turns/1/files')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Desfazer da linha abre a tela de desfazer; ao terminar, recarrega os turnos', async () => {
    const run = { id: 8, kind: 'undo', turnIds: [1], files: [{ path: 'a.ts', result: 'reverted' }], redone: false }
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/undo/terminals/a/turns')) return json(dto)
      if (u === '/api/undo/preview') {
        return json({ token: 't', turnIds: [1], blockedBy: null, branchChanged: null, files: [{ path: 'a.ts', class: 'own', verdict: 'revert', mergeable: false, overlapped: false, checked: true }], notUndoable: [], hiddenOutside: 0 })
      }
      if (u === '/api/undo/apply') return json(run)
      return json([])
    })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const linha = (await screen.findByText('3 arquivos')).closest<HTMLElement>('.undo-line')!
    fireEvent.click(within(linha).getByText('Desfazer'))
    const dialog = await screen.findByRole('dialog', { name: 'Desfazer as mudanças nos arquivos' })
    await within(dialog).findByText('a.ts')
    const turnsAntes = vi.mocked(globalThis.fetch).mock.calls.filter(([u]) => String(u).startsWith('/api/undo/terminals/a/turns')).length
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desfazer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const chamadas = vi.mocked(globalThis.fetch).mock.calls
    expect(chamadas.find(([u]) => String(u) === '/api/undo/apply')?.[1]?.body).toBe(JSON.stringify({ turnIds: [1], token: 't', decisions: { 'a.ts': 'revert' } }))
    expect(chamadas.filter(([u]) => String(u).startsWith('/api/undo/terminals/a/turns')).length).toBe(turnsAntes + 1)
  })

  it('Refazer da linha abre a mesma tela com o último desfazer', async () => {
    dto.turns[0] = { ...dto.turns[0], lastRun: { id: 6, redone: false } }
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const linha = (await screen.findByText('3 arquivos')).closest<HTMLElement>('.undo-line')!
    fireEvent.click(within(linha).getByText('Refazer'))
    expect(await screen.findByRole('dialog', { name: 'Refazer as mudanças nos arquivos' })).toBeTruthy()
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.map(([u]) => String(u))).toContain('/api/undo/runs/6/redo/preview'))
  })
})
