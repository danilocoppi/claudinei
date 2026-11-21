import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  addToQueue: vi.fn(),
}))
vi.mock('../branch/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../branch/api')>()),
  openSide: vi.fn(),
  forkTerminal: vi.fn(),
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import { DEFAULT_APPEARANCE } from '../appearance'
import { addToQueue } from '../api'
import { forkTerminal, openSide, type SideInfo } from '../branch/api'
import type { EngineMeta, SessionInfo } from '../types'

/**
 * `/side`, `/btw` e `/fork` nunca entram na fila nem no turno: o campo chama a
 * rota na hora, inclusive no meio de um turno do Kimi e com Alt+Enter.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [], midTurnInput: true,
}
const KIMI: EngineMeta = {
  id: 'kimi', label: 'Kimi', icon: 'kimi', models: [''], efforts: ['auto'],
  permissions: [], slashSource: 'none', slashCommands: [],
}
const sess = (localId: string, engine: string, status: SessionInfo['status'] = 'working'): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine })
const side = (engine: string): SideInfo => ({
  id: 's1', projectId: 1, engine, status: 'starting', mode: 'seed', cutAt: null, files: 'can_write',
  question: null, openedAt: '2026-11-20T12:00:00Z',
})

let enviadas: any[]
const ws = { send: (m: any) => enviadas.push(m) } as never

beforeEach(() => {
  enviadas = []
  localStorage.clear()
  vi.mocked(addToQueue).mockReset()
  vi.mocked(openSide).mockReset()
  vi.mocked(openSide).mockImplementation(async (_p, engine) => side(engine))
  vi.mocked(forkTerminal).mockReset()
  vi.mocked(forkTerminal).mockImplementation(() => new Promise(() => {}))
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null })
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { c1: sess('c1', 'claude'), k1: sess('k1', 'kimi') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, queues: {},
    view: 'chat', activeLocalId: 'k1', engines: [CLAUDE, KIMI], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrir = (localId: string) =>
  render(<WsContext.Provider value={ws}><ChatInput key={localId} localId={localId} disabled={false} /></WsContext.Provider>)
const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement
const digitar = (texto: string) => fireEvent.change(campo(), { target: { value: texto } })
const enter = () => fireEvent.keyDown(campo(), { key: 'Enter' })
const altEnter = () => fireEvent.keyDown(campo(), { key: 'Enter', altKey: true })

describe('/side, /btw e /fork no campo', () => {
  it('/side no meio do turno do Kimi chama openSide e não vai à fila', async () => {
    abrir('k1')
    digitar('/side por que isso quebrou?')
    enter()
    expect(openSide).toHaveBeenCalledWith(1, 'kimi', 'por que isso quebrou?')
    expect(addToQueue).not.toHaveBeenCalled()
    expect(enviadas).toEqual([])
    await waitFor(() => expect(useSideStore.getState().sides['1:kimi']?.info.id).toBe('s1'))
  })

  it('Alt+Enter com /btw também chama a rota', () => {
    useStore.setState({ activeLocalId: 'c1' })
    abrir('c1')
    digitar('/btw e o lint?')
    altEnter()
    expect(openSide).toHaveBeenCalledWith(1, 'claude', 'e o lint?')
    expect(addToQueue).not.toHaveBeenCalled()
    expect(enviadas).toEqual([])
  })

  it('/btw sozinho: o menu completa o comando e o envio seguinte abre a lateral sem pergunta', () => {
    useStore.setState({ activeLocalId: 'c1' })
    abrir('c1')
    digitar('/btw')
    altEnter()
    expect(campo().value).toBe('/btw ')
    expect(openSide).not.toHaveBeenCalled()
    altEnter()
    expect(openSide).toHaveBeenCalledWith(1, 'claude', undefined)
    expect(addToQueue).not.toHaveBeenCalled()
  })

  it('o campo limpa e nenhum balão otimista aparece', () => {
    useStore.setState({ activeLocalId: 'c1', sessions: { c1: sess('c1', 'claude', 'idle') } })
    abrir('c1')
    digitar('/side e o teste?')
    enter()
    expect(campo().value).toBe('')
    expect(useStore.getState().chat.c1 ?? []).toEqual([])
    expect(enviadas).toEqual([])
  })

  it('/fork chama a rota do ramo, sem fila nem turno', () => {
    abrir('k1')
    digitar('/fork Experimento')
    altEnter()
    expect(forkTerminal).toHaveBeenCalledWith(1, 'kimi', 'Experimento')
    expect(addToQueue).not.toHaveBeenCalled()
    expect(enviadas).toEqual([])
    expect(campo().value).toBe('')
  })

  it('/sidebar segue como mensagem comum', () => {
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'idle') } })
    abrir('c1')
    digitar('/sidebar')
    enter()
    expect(openSide).not.toHaveBeenCalled()
    expect(enviadas).toEqual([{ type: 'send_message', localId: 'c1', text: '/sidebar' }])
  })
})
