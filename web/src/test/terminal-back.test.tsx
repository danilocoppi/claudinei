import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  openTerminal: vi.fn(async () => ({ token: 'tk', wsUrl: 'ws://x' })),
  closeTerminal: vi.fn(async () => undefined),
  reviveSession: vi.fn(async () => ({ localId: 's1', status: 'idle' })),
}))
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => ({ open: vi.fn(), write: vi.fn(), dispose: vi.fn(), onData: vi.fn(() => ({ dispose: vi.fn() })), loadAddon: vi.fn(), focus: vi.fn() })) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn(), proposeDimensions: vi.fn() })) }))

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(_url: string) {}
}

import { TerminalView } from '../components/TerminalView'
import { closeTerminal, reviveSession } from '../api'
import { useStore } from '../store'

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  useStore.setState({ view: 'terminal', activeLocalId: 's1', sessions: { s1: { localId: 's1', projectId: 1, status: 'in_terminal' } as never }, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('voltar ao chat', () => {
  it('fecha o terminal, revive a sessão e navega para o chat', async () => {
    render(<TerminalView />)
    fireEvent.click(screen.getByText('← Voltar ao chat'))
    await waitFor(() => expect(useStore.getState().view).toBe('chat'))
    expect(closeTerminal).toHaveBeenCalledWith('s1')
    expect(reviveSession).toHaveBeenCalledWith('s1')
    expect(useStore.getState().activeLocalId).toBe('s1')
  })

  it('revive falhando ainda navega para o chat (fallback: botão Reviver lá)', async () => {
    ;(reviveSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('já viva'))
    render(<TerminalView />)
    fireEvent.click(screen.getByText('← Voltar ao chat'))
    await waitFor(() => expect(useStore.getState().view).toBe('chat'))
  })
})
