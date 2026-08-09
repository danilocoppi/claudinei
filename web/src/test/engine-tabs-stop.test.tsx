import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { EngineTabs } from '../components/EngineTabs'
import { useStore } from '../store'
import * as api from '../api'
import type { EngineMeta, SessionInfo, SessionStatus } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: [], slashSource: 'protocol', slashCommands: [],
}
const KIMI: EngineMeta = {
  id: 'kimi', label: 'Kimi Code', icon: '🌙',
  models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [],
}

const sess = (localId: string, engine: string, status: SessionStatus): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine })

/** Claude viva e Kimi viva no mesmo terminal — o caso real do multi-engine. */
const withBoth = (kimiStatus: SessionStatus = 'idle') => {
  useStore.setState({
    engines: [CLAUDE, KIMI],
    sessions: { c1: sess('c1', 'claude', 'idle'), k1: sess('k1', 'kimi', kimiStatus) },
  })
}

const stopBtn = (label: RegExp) => screen.getByTitle(label)

beforeEach(() => { useStore.setState({ projects: [], chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('EngineTabs — encerrar sessão por engine', () => {
  it('oferece o botão de encerrar em cada engine viva', () => {
    withBoth()
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(stopBtn(/encerrar claude code/i)).toBeTruthy()
    expect(stopBtn(/encerrar kimi code/i)).toBeTruthy()
  })

  it('não oferece encerrar numa engine sem sessão viva', () => {
    useStore.setState({ engines: [CLAUDE, KIMI], sessions: { c1: sess('c1', 'claude', 'idle') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(screen.queryByTitle(/encerrar kimi code/i)).toBeNull()
  })

  it('clicar pede confirmação em vez de encerrar direto', () => {
    withBoth()
    const spy = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(stopBtn(/encerrar kimi code/i))
    expect(screen.getByText(/encerrar kimi code\?/i)).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })

  it('confirmar encerra a sessão DAQUELA engine', async () => {
    withBoth()
    const spy = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(stopBtn(/encerrar kimi code/i))
    fireEvent.click(screen.getByText(/^encerrar$/i))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('k1'))
  })

  it('cancelar não encerra nada', () => {
    withBoth()
    const spy = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(stopBtn(/encerrar kimi code/i))
    fireEvent.click(screen.getByText(/cancelar/i))
    expect(spy).not.toHaveBeenCalled()
  })

  it('avisa que o turno em andamento será perdido quando a engine está working', () => {
    withBoth('working')
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(stopBtn(/encerrar kimi code/i))
    expect(screen.getByText(/turno em andamento/i)).toBeTruthy()
  })
})
