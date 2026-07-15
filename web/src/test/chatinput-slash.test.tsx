import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo } from '../types'

beforeEach(() => {
  useStore.setState({
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    slashCommands: ['compact', 'cost', 'clear', 'exit', 'figma:figma-use'],
  })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, ta: screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('autocomplete de slash no ChatInput', () => {
  it('digitar "/co" abre o menu com os matches (sem exit)', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/co' } })
    expect(screen.getByTestId('slash-menu')).toBeTruthy()
    const items = screen.getAllByTestId('slash-item').map((el) => el.textContent)
    expect(items.some((t) => t?.includes('/compact'))).toBe(true)
    expect(items.some((t) => t?.includes('/exit'))).toBe(false)
  })

  it('Enter (sem navegar) PREENCHE o 1º e NÃO envia', () => {
    const { send, ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/c' } })
    fireEvent.keyDown(ta, { key: 'Enter' }) // seleciona o 1º (activeIndex 0)
    expect(ta.value).toBe('/compact ')
    expect(send).not.toHaveBeenCalled()
  })

  it('ArrowDown navega para o 2º item antes de selecionar', () => {
    const { send, ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/c' } }) // matches: compact, cost, clear
    fireEvent.keyDown(ta, { key: 'ArrowDown' }) // activeIndex 0 -> 1 (cost)
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('/cost ')
    expect(send).not.toHaveBeenCalled()
  })

  it('ArrowUp com wrap seleciona o último item', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/c' } })
    fireEvent.keyDown(ta, { key: 'ArrowUp' }) // 0 -> último (wrap): clear
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('/clear ')
  })

  it('Enter com o menu FECHADO envia', () => {
    const { send, ta } = renderInput()
    fireEvent.change(ta, { target: { value: 'ola mundo' } }) // não começa com /
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'ola mundo' })
  })

  it('clicar fora (blur) fecha o menu', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/co' } })
    expect(screen.getByTestId('slash-menu')).toBeTruthy()
    fireEvent.blur(ta)
    expect(screen.queryByTestId('slash-menu')).toBeNull()
  })

  it('Escape fecha o menu', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/co' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByTestId('slash-menu')).toBeNull()
  })

  it('texto com espaço após o comando fecha o menu', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/compact agora' } })
    expect(screen.queryByTestId('slash-menu')).toBeNull()
  })
})

describe('autocomplete de slash por engine (SP-C Task 6)', () => {
  const CLAUDE: EngineMeta = {
    id: 'claude', label: 'Claude Code', icon: '✳',
    models: ['', 'fable', 'opus', 'sonnet', 'haiku'], efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'], slashSource: 'protocol', slashCommands: [],
  }
  const CODEX: EngineMeta = {
    id: 'codex', label: 'Codex', icon: '◆',
    models: ['', 'gpt-5.6-sol'], efforts: ['low', 'medium', 'high', 'xhigh'], permissions: [],
    slashSource: 'curated', slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
  }
  const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
    ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })

  it('sessão Codex (slashSource curated) mostra a lista curada da engine, não a do protocolo', () => {
    useStore.setState({ engines: [CLAUDE, CODEX], sessions: { s1: sess({ engine: 'codex' }) } })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '/' } })
    const items = screen.getAllByTestId('slash-item').map((el) => el.textContent)
    expect(items.some((t) => t?.includes('/approvals'))).toBe(true)
    expect(items.some((t) => t?.includes('/undo'))).toBe(true)
    // não vaza o protocolo (ex.: 'figma:figma-use' só está em store.slashCommands)
    expect(items.some((t) => t?.includes('figma'))).toBe(false)
  })

  it('sessão Claude (slashSource protocol) continua usando store.slashCommands mesmo com engines carregadas', () => {
    useStore.setState({ engines: [CLAUDE, CODEX], sessions: { s1: sess({ engine: 'claude' }) } })
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/' } })
    const items = screen.getAllByTestId('slash-item').map((el) => el.textContent)
    expect(items.some((t) => t?.includes('/compact'))).toBe(true)
    expect(items.some((t) => t?.includes('figma'))).toBe(true)
    // curado do Codex não vaza pro Claude
    expect(items.some((t) => t?.includes('/approvals'))).toBe(false)
  })
})
