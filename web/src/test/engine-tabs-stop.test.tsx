import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { EngineTabs } from '../components/EngineTabs'
import { useStore } from '../store'
import * as api from '../api'
import type { EngineMeta, Project, SessionInfo, SessionStatus } from '../types'

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

// As abas seguem a lista de motores do terminal: aqui ela tem os dois.
const PROJECT: Project = { id: 1, name: 'T', path: '/tmp/t', color: '#000', icon: 'x', engines: ['claude', 'kimi'] }

beforeEach(() => { useStore.setState({ projects: [PROJECT], terminalStates: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} }) })
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

describe('EngineTabs — engine não instalada', () => {
  // "não instalada" já diz tudo: mostrar "○ sem sessão" junto era redundância
  // que comia a largura da barra (as três ausentes estouravam o header).
  it('não instalada e sem sessão → só o selo, sem "sem sessão" nem bolinha', () => {
    // Listada mas não instalada não ganha aba sozinha (motores por terminal); o
    // aviso de trabalho interrompido é um dos casos em que ela aparece assim.
    useStore.setState({
      engines: [CLAUDE, { ...KIMI, available: false }],
      sessions: { c1: sess('c1', 'claude', 'idle') },
      terminalStates: { '1:kimi': { projectId: 1, engine: 'kimi', autostart: false, autoResume: false, interruption: { at: 'x', reason: 'off' }, autoResumeLimit: false, usageLimit: null, taskResults: [], taskResultsHeld: false, goal: null } },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const tabs = screen.getAllByRole('tab')
    const kimiTab = tabs.find((el) => el.textContent?.includes('Kimi Code'))!
    expect(kimiTab.textContent).toContain('não instalada')
    expect(kimiTab.textContent).not.toContain('sem sessão')
    expect(kimiTab.querySelector('.status-dot')).toBeNull()
  })

  it('instalada sem sessão continua com o "sem sessão" de sempre', () => {
    useStore.setState({
      engines: [CLAUDE, KIMI],
      sessions: { c1: sess('c1', 'claude', 'idle') },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const kimiTab = screen.getAllByRole('tab').find((el) => el.textContent?.includes('Kimi Code'))!
    expect(kimiTab.textContent).toContain('sem sessão')
    expect(kimiTab.querySelector('.status-dot')).toBeTruthy()
  })

  it('não instalada mas com sessão VIVA (binário sumiu depois) mantém o status visível', () => {
    useStore.setState({
      engines: [CLAUDE, { ...KIMI, available: false }],
      sessions: { c1: sess('c1', 'claude', 'idle'), k1: sess('k1', 'kimi', 'working') },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const kimiTab = screen.getAllByRole('tab').find((el) => el.textContent?.includes('Kimi Code'))!
    expect(kimiTab.querySelector('.status-dot')).toBeTruthy()
  })
})
