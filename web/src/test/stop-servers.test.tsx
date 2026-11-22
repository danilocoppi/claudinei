import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { EngineTabs } from '../components/EngineTabs'
import { DeleteProjectDialog } from '../components/DeleteProjectDialog'
import { useStore } from '../store'
import * as api from '../api'
import * as browserApi from '../browser/api'
import { serversOf, serversSummary, stopAll } from '../browser/serversOnStop'
import type { LocalServer } from '../browser/api'
import type { EngineMeta, Project, SessionInfo, SessionStatus } from '../types'

/**
 * A pergunta pelos servidores de pé ao encerrar a sessão de um terminal ou
 * excluir o terminal: só os do marcador exato contam; sem nenhum, segue como
 * antes; com algum, "Parar e encerrar", "Só encerrar" ou "Cancelar".
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: [], slashSource: 'protocol', slashCommands: [],
}
const KIMI: EngineMeta = {
  id: 'kimi', label: 'Kimi Code', icon: '🌙',
  models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [],
}
const PROJECT: Project = { id: 1, name: 'T', path: '/tmp/t', color: '#000', icon: 'x', engines: ['claude', 'kimi'] }

const sess = (localId: string, engine: string, status: SessionStatus): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine })

const srv = (pid: number, port: number, label: string, marker: LocalServer['marker'] = 'exact'): LocalServer =>
  ({ pid, port, host: '127.0.0.1', label, startTime: `st${pid}`, marker })

const VITE = srv(101, 5173, 'vite')
const NODE = srv(102, 3000, 'node')
const ASK_TWO = 'Este terminal deixou 2 servidores no ar (:5173 vite, :3000 node). Parar também?'

beforeEach(() => {
  useStore.setState({
    projects: [PROJECT], engines: [CLAUDE, KIMI], terminalStates: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    sessions: { c1: sess('c1', 'claude', 'idle'), k1: sess('k1', 'kimi', 'idle') },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** Abre o "Encerrar Kimi Code?" e confirma. */
const endKimi = () => {
  render(<EngineTabs projectId={1} activeLocalId="c1" />)
  fireEvent.click(screen.getByTitle(/encerrar kimi code/i))
  fireEvent.click(screen.getByRole('button', { name: /^encerrar$/i }))
}

const mockServers = (byEngine: Record<string, LocalServer[]>) =>
  vi.spyOn(browserApi, 'fetchServers').mockImplementation(async (_p, engine) => ({ servers: byEngine[engine] ?? [] }))

describe('encerrar com servidores de pé (EngineTabs)', () => {
  it('sem servidores encerra direto', async () => {
    const fetchSpy = mockServers({})
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    await waitFor(() => expect(stop).toHaveBeenCalledWith('k1'))
    expect(fetchSpy).toHaveBeenCalledWith(1, 'kimi')
    expect(screen.queryByText(/Parar também\?/)).toBeNull()
  })

  it("com dois servidores mostra 'Este terminal deixou 2 servidores no ar (:5173 vite, :3000 node). Parar também?'", async () => {
    mockServers({ kimi: [VITE, NODE] })
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    expect(await screen.findByText(ASK_TWO)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Parar e encerrar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Só encerrar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy()
    expect(stop).not.toHaveBeenCalled()
  })

  it('Parar e encerrar para os dois e depois encerra', async () => {
    mockServers({ kimi: [VITE, NODE] })
    const order: string[] = []
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockImplementation(async (_p, _e, pid) => {
      order.push(`srv:${pid}`)
      return { ok: true, target: 'group' }
    })
    const stop = vi.spyOn(api, 'stopSession').mockImplementation(async (id) => { order.push(`sess:${id}`) })
    endKimi()
    fireEvent.click(await screen.findByRole('button', { name: 'Parar e encerrar' }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith('k1'))
    expect(stopSrv).toHaveBeenCalledWith(1, 'kimi', 101, 'st101')
    expect(stopSrv).toHaveBeenCalledWith(1, 'kimi', 102, 'st102')
    expect(order).toEqual(['srv:101', 'srv:102', 'sess:k1'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Só encerrar não chama stopLocalServer', async () => {
    mockServers({ kimi: [VITE, NODE] })
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockResolvedValue({ ok: true, target: 'pid' })
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    fireEvent.click(await screen.findByRole('button', { name: 'Só encerrar' }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith('k1'))
    expect(stopSrv).not.toHaveBeenCalled()
  })

  it('Cancelar não encerra', async () => {
    mockServers({ kimi: [VITE, NODE] })
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockResolvedValue({ ok: true, target: 'pid' })
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    await screen.findByText(ASK_TWO)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stop).not.toHaveBeenCalled()
    expect(stopSrv).not.toHaveBeenCalled()
  })

  it('Cancelar o "Encerrar?" com a consulta em voo: a resposta que chega depois não encerra', async () => {
    let answer: (v: { servers: LocalServer[] }) => void = () => {}
    vi.spyOn(browserApi, 'fetchServers').mockImplementation(() => new Promise((r) => { answer = r }))
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    expect((screen.getByRole('button', { name: /^encerrar$/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    answer({ servers: [VITE] })
    await new Promise((r) => setTimeout(r, 20))
    expect(stop).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: /^encerrar$/i })).toBeNull()
  })

  it('Esc no diálogo é o Cancelar', async () => {
    mockServers({ kimi: [VITE, NODE] })
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    const dlg = await screen.findByRole('dialog')
    fireEvent.keyDown(dlg, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stop).not.toHaveBeenCalled()
  })

  it("servidor 'cwd' não entra na conta", async () => {
    mockServers({ kimi: [VITE, srv(103, 8080, 'python', 'cwd'), NODE] })
    vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    expect(await screen.findByText(ASK_TWO)).toBeTruthy()
  })

  it("só servidores 'cwd': encerra direto", async () => {
    mockServers({ kimi: [srv(103, 8080, 'python', 'cwd')] })
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    await waitFor(() => expect(stop).toHaveBeenCalledWith('k1'))
    expect(screen.queryByText(/Parar também\?/)).toBeNull()
  })

  it('a consulta falhou: encerra como antes, sem pergunta', async () => {
    vi.spyOn(browserApi, 'fetchServers').mockRejectedValue(Object.assign(new Error('proibido'), { status: 403 }))
    const stop = vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    await waitFor(() => expect(stop).toHaveBeenCalledWith('k1'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('um só servidor: a frase no singular', async () => {
    mockServers({ kimi: [VITE] })
    vi.spyOn(api, 'stopSession').mockResolvedValue(undefined as never)
    endKimi()
    expect(await screen.findByText('Este terminal deixou 1 servidor no ar (:5173 vite). Parar também?')).toBeTruthy()
  })
})

describe('excluir com servidores de pé (DeleteProjectDialog)', () => {
  const PROJ: Project = { ...PROJECT, name: 'Alpha' }
  const excluir = () => screen.getByRole('button', { name: 'Excluir' })

  it('excluir projeto consulta todos os motores com sessão', async () => {
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'stopped'), k1: sess('k1', 'kimi', 'dead') } })
    const fetchSpy = mockServers({})
    const del = vi.spyOn(api, 'deleteProject').mockResolvedValue(undefined as never)
    vi.spyOn(api, 'fetchProjects').mockResolvedValue([])
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={PROJ} onDeleted={onDeleted} onClose={() => {}} />)
    fireEvent.click(excluir())
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(fetchSpy.mock.calls.map(([p, e]) => `${p}:${e}`).sort()).toEqual(['1:claude', '1:kimi'])
    expect(del).toHaveBeenCalledWith(1, { stopSessions: false })
  })

  it('com servidores: "Parar e excluir" para os servidores de cada motor e depois exclui', async () => {
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'stopped'), k1: sess('k1', 'kimi', 'stopped') } })
    mockServers({ claude: [VITE], kimi: [NODE] })
    const order: string[] = []
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockImplementation(async (_p, engine, pid) => {
      order.push(`${engine}:${pid}`)
      return { ok: true, target: 'group' }
    })
    vi.spyOn(api, 'deleteProject').mockImplementation(async () => { order.push('delete') })
    vi.spyOn(api, 'fetchProjects').mockResolvedValue([])
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={PROJ} onDeleted={onDeleted} onClose={() => {}} />)
    fireEvent.click(excluir())
    expect(await screen.findByText(ASK_TWO)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Só excluir' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Parar e excluir' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(stopSrv).toHaveBeenCalledWith(1, 'claude', 101, 'st101')
    expect(stopSrv).toHaveBeenCalledWith(1, 'kimi', 102, 'st102')
    expect(order[order.length - 1]).toBe('delete')
  })

  it('com servidores: "Só excluir" exclui sem parar, e Cancelar volta sem excluir', async () => {
    useStore.setState({ sessions: { k1: sess('k1', 'kimi', 'stopped') } })
    mockServers({ kimi: [VITE, NODE] })
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockResolvedValue({ ok: true, target: 'pid' })
    const del = vi.spyOn(api, 'deleteProject').mockResolvedValue(undefined as never)
    vi.spyOn(api, 'fetchProjects').mockResolvedValue([])
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={PROJ} onDeleted={onDeleted} onClose={() => {}} />)
    fireEvent.click(excluir())
    await screen.findByText(ASK_TWO)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    // Cancelar a pergunta volta ao diálogo de excluir, sem excluir nada.
    await waitFor(() => expect(excluir()).toBeTruthy())
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(excluir())
    fireEvent.click(await screen.findByRole('button', { name: 'Só excluir' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(stopSrv).not.toHaveBeenCalled()
  })
})

describe('serversOnStop', () => {
  it('serversSummary junta porta e rótulo', () => {
    expect(serversSummary([VITE, NODE])).toBe(':5173 vite, :3000 node')
  })

  it('serversOf junta os motores, marca o motor e deixa de fora os sem marcador', async () => {
    mockServers({ claude: [VITE, srv(9, 9000, 'x', 'cwd')], kimi: [NODE] })
    expect(await serversOf(1, ['claude', 'kimi'])).toEqual([{ ...VITE, engine: 'claude' }, { ...NODE, engine: 'kimi' }])
  })

  it('serversOf: um motor que falha não esconde os outros', async () => {
    vi.spyOn(browserApi, 'fetchServers').mockImplementation(async (_p, engine) => {
      if (engine === 'claude') throw new Error('rede')
      return { servers: [NODE] }
    })
    expect(await serversOf(1, ['claude', 'kimi'])).toEqual([{ ...NODE, engine: 'kimi' }])
  })

  it('stopAll: uma falha não interrompe as outras', async () => {
    const stopSrv = vi.spyOn(browserApi, 'stopLocalServer').mockImplementation(async (_p, _e, pid) => {
      if (pid === 101) throw Object.assign(new Error('o processo já não é o mesmo'), { status: 409 })
      return { ok: true, target: 'group' }
    })
    await expect(stopAll(1, [{ ...VITE, engine: 'kimi' }, { ...NODE, engine: 'kimi' }])).resolves.toBeUndefined()
    expect(stopSrv).toHaveBeenCalledTimes(2)
  })
})
