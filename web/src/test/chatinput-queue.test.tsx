import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// Só a fila é falsa: o upload segue pelo fetch (espionado nos testes que precisam).
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  addToQueue: vi.fn(),
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { addToQueue } from '../api'
import type { EngineMeta, OperatorQueue, SessionInfo } from '../types'

/**
 * A fila no campo: Alt+Enter enfileira em qualquer motor; Enter no meio do turno
 * entra no turno atual no Claude e no Codex (mensagem nova é ACRÉSCIMO, nunca
 * cancelamento) e vai para a fila no Kimi e no OpenCode, que recusam mensagem
 * no meio do turno.
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

const fila = (engine: string, o: Partial<OperatorQueue> = {}): OperatorQueue =>
  ({ projectId: 1, engine, items: [], paused: false, pauseReason: null, ...o })

let enviadas: any[]
const ws = { send: (m: any) => enviadas.push(m) } as never
const enfileirar = vi.mocked(addToQueue)

beforeEach(() => {
  enviadas = []
  localStorage.clear()
  enfileirar.mockReset()
  enfileirar.mockImplementation(async (projectId, engine, text) =>
    fila(engine, { items: [{ id: 7, text, createdAt: '2026-11-20 12:00:00' }] }))
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { c1: sess('c1', 'claude'), k1: sess('k1', 'kimi') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, queues: {},
    view: 'chat', activeLocalId: 'c1', engines: [CLAUDE, KIMI], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrir = (localId: string) =>
  render(<WsContext.Provider value={ws}><ChatInput key={localId} localId={localId} disabled={false} /></WsContext.Provider>)
const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement
const digitar = (texto: string) => fireEvent.change(campo(), { target: { value: texto } })
const altEnter = () => fireEvent.keyDown(campo(), { key: 'Enter', altKey: true })
const enter = () => fireEvent.keyDown(campo(), { key: 'Enter' })

describe('a fila no campo', () => {
  it('Alt+Enter no Claude trabalhando chama addToQueue e limpa o campo', async () => {
    abrir('c1')
    digitar('depois disso, rode os testes')
    expect(altEnter(), 'o Alt+Enter não pode virar quebra de linha').toBe(false)
    expect(enfileirar).toHaveBeenCalledWith(1, 'claude', 'depois disso, rode os testes')
    expect(campo().value).toBe('')
    // não entrou no turno atual
    expect(enviadas).toEqual([])
    // a resposta já atualiza a fila do terminal, sem esperar o WebSocket
    await waitFor(() => expect(useStore.getState().queues['1:claude']?.items.map((i) => i.id)).toEqual([7]))
  })

  it('Enter no Claude trabalhando continua mandando send_message', () => {
    abrir('c1')
    digitar('e confira o lint também')
    enter()
    expect(enviadas).toEqual([{ type: 'send_message', localId: 'c1', text: 'e confira o lint também' }])
    expect(enfileirar).not.toHaveBeenCalled()
  })

  it('Enter no Kimi trabalhando vai para a fila', () => {
    abrir('k1')
    digitar('próximo passo')
    enter()
    expect(enfileirar).toHaveBeenCalledWith(1, 'kimi', 'próximo passo')
    expect(enviadas).toEqual([])
    expect(campo().value).toBe('')
  })

  it('Enter no Kimi livre manda na hora, sem fila', () => {
    useStore.setState({ sessions: { k1: sess('k1', 'kimi', 'idle') } })
    abrir('k1')
    digitar('oi')
    enter()
    expect(enviadas).toEqual([{ type: 'send_message', localId: 'k1', text: 'oi' }])
    expect(enfileirar).not.toHaveBeenCalled()
  })

  it('Alt+Enter com upload em andamento não faz nada', async () => {
    // upload que não termina: o token ainda não tem caminho
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    abrir('c1')
    digitar('veja o anexo')
    fireEvent.paste(campo(), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await waitFor(() => expect(campo().placeholder).toMatch(/enviando anexo/))
    altEnter()
    expect(enfileirar).not.toHaveBeenCalled()
    expect(campo().value).toBe('veja o anexo')
  })

  it('o texto enfileirado troca os tokens dos anexos pelos caminhos', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ path: '/ups/001-a.png', name: '001-a.png' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    abrir('c1')
    fireEvent.paste(campo(), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await waitFor(() => expect(campo().value).toContain('[📎 001-a.png]'))
    digitar(`olhe ${campo().value}`)
    altEnter()
    expect(enfileirar).toHaveBeenCalledWith(1, 'claude', 'olhe /ups/001-a.png')
  })

  it('!comando nunca vai para a fila: roda como comando de terminal', () => {
    abrir('k1')
    digitar('!ls')
    altEnter()
    expect(enfileirar).not.toHaveBeenCalled()
    expect(enviadas).toEqual([{ type: 'shell', localId: 'k1', command: 'ls' }])
  })

  it('fila pausada no Kimi: Enter entra na fila e o campo avisa fila pausada', () => {
    useStore.setState({ queues: { '1:kimi': fila('kimi', { paused: true, pauseReason: 'error', items: [{ id: 3, text: 'a', createdAt: 'x' }] }) } })
    abrir('k1')
    expect(campo().placeholder).toMatch(/fila pausada/)
    digitar('mais um')
    enter()
    expect(enfileirar).toHaveBeenCalledWith(1, 'kimi', 'mais um')
    expect(enviadas).toEqual([])
    expect(campo().placeholder).toMatch(/fila pausada/)
  })

  it('a fila recusou (cheia): o texto volta ao campo e o erro aparece', async () => {
    enfileirar.mockRejectedValue(new Error('A fila já tem 20 mensagens.'))
    abrir('c1')
    digitar('vigésima primeira')
    altEnter()
    await waitFor(() => expect(campo().value).toBe('vigésima primeira'))
    expect(screen.getByText(/A fila já tem 20 mensagens/)).toBeTruthy()
  })

  it('a resposta do addToQueue que chega depois do WebSocket não sobrescreve a fila', async () => {
    let responde!: (q: OperatorQueue) => void
    enfileirar.mockReturnValue(new Promise<OperatorQueue>((r) => { responde = r }))
    abrir('c1')
    digitar('um')
    altEnter()
    // Outra aba enfileirou logo depois: o WebSocket já traz os dois.
    const dois = fila('claude', { items: [{ id: 7, text: 'um', createdAt: 'x' }, { id: 8, text: 'dois', createdAt: 'x' }] })
    useStore.getState().applyWsMessage({ type: 'operator_queue', projectId: 1, engine: 'claude', queue: dois })
    responde(fila('claude', { items: [{ id: 7, text: 'um', createdAt: 'x' }] }))
    await new Promise((r) => setTimeout(r, 0))
    expect(useStore.getState().queues['1:claude'].items.map((i) => i.id)).toEqual([7, 8])
  })
})
