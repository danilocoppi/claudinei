import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { applySideMessage, requestAppend, useSideStore, useSideSync } from '../branch/sideStore'
import { useStore } from '../store'
import type { SideInfo } from '../branch/api'

/**
 * O estado da conversa lateral na web: um store à parte do principal, alimentado
 * pelos `side_state` / `side_event` do WebSocket e relido do servidor ao montar
 * e a cada reconexão.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const info = (o: Partial<SideInfo> = {}): SideInfo => ({
  id: 's1', projectId: 1, engine: 'claude', status: 'idle', mode: 'native', cutAt: '2026-11-20T12:00:00Z',
  files: 'no_edit_tools', question: null, openedAt: '2026-11-20T12:01:00Z', ...o,
})
const userEvt = (text: string) => ({ kind: 'user', message: { role: 'user', content: text }, raw: {} })
const assistantEvt = (text: string) => ({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, raw: {} })

beforeEach(() => {
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null })
  useStore.setState({ authStatus: 'ready', progressEpoch: 0, chat: {} })
})
afterEach(() => { vi.restoreAllMocks() })

describe('applySideMessage', () => {
  it('side_event monta itens; side_state null remove a lateral', () => {
    expect(applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })).toBe(true)
    expect(applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1', event: userEvt('por quê?') })).toBe(true)
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1', event: assistantEvt('porque sim') })
    const view = useSideStore.getState().sides['1:claude']
    expect(view?.info.id).toBe('s1')
    expect(view?.items.map((i) => i.kind)).toEqual(['user_text', 'assistant_text'])
    // Nada vai ao chat da principal.
    expect(useStore.getState().chat).toEqual({})

    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: null })
    expect(useSideStore.getState().sides['1:claude']).toBeUndefined()
  })

  it('side_state da mesma lateral troca o estado e guarda os itens', () => {
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1', event: userEvt('oi') })
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info({ status: 'working', question: 'oi' }) })
    const view = useSideStore.getState().sides['1:claude']
    expect(view?.info.status).toBe('working')
    expect(view?.items).toHaveLength(1)
  })

  it('lateral nova (replace) começa sem os itens da antiga', () => {
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1', event: userEvt('oi') })
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info({ id: 's2' }) })
    expect(useSideStore.getState().sides['1:claude']?.items).toEqual([])
  })

  it('evento de outra lateral ou de terminal sem lateral é consumido e ignorado', () => {
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })
    expect(applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 'velha', event: userEvt('x') })).toBe(true)
    expect(applySideMessage({ type: 'side_event', projectId: 2, engine: 'codex', sideId: 's9', event: userEvt('x') })).toBe(true)
    expect(useSideStore.getState().sides['1:claude']?.items).toEqual([])
    expect(useSideStore.getState().sides['2:codex']).toBeUndefined()
  })

  it('o erro que o servidor publica na lateral (processo morto, envio recusado) vira item de erro', () => {
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1',
      event: { kind: 'result', subtype: 'error', isError: true, resultText: 'O processo do agente encerrou inesperadamente.', costUsd: 0, raw: {} } })
    // O fim de turno comum, mesmo interrompido, não vira item.
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1',
      event: { kind: 'result', subtype: 'error_during_execution', isError: true, resultText: '', costUsd: 0, raw: {} } })
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1',
      event: { kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} } })
    expect(useSideStore.getState().sides['1:claude']?.items).toEqual([
      expect.objectContaining({ kind: 'command_output', text: 'O processo do agente encerrou inesperadamente.', isError: true }),
    ])
  })

  it('stream não vira item', () => {
    applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() })
    const antes = useSideStore.getState().sides['1:claude']
    applySideMessage({ type: 'side_event', projectId: 1, engine: 'claude', sideId: 's1', event: { kind: 'stream', text: 'pa', raw: {} } })
    expect(useSideStore.getState().sides['1:claude']).toBe(antes)
  })

  it('o que não é da lateral segue para o store principal', () => {
    expect(applySideMessage({ type: 'session_event', localId: 'c1', event: userEvt('x') })).toBe(false)
    expect(applySideMessage({ type: 'progress', projectId: 1, engine: 'claude' })).toBe(false)
    expect(applySideMessage(null)).toBe(false)
  })
})

describe('useSideSync', () => {
  it('lê ao montar e relê ao reconectar', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(200, { side: info(), events: [userEvt('pergunta'), assistantEvt('resposta')] }))
    const { result } = renderHook(() => useSideSync(1, 'claude'))
    await waitFor(() => expect(result.current?.items).toHaveLength(2))
    expect(fetch).toHaveBeenCalledWith('/api/projects/1/side?engine=claude', expect.anything())

    // A lateral fechou durante a queda: a releitura tira a coluna.
    fetch.mockImplementation(async () => json(200, { side: null, events: [] }))
    act(() => useStore.getState().resyncOnReconnect())
    await waitFor(() => expect(result.current).toBeUndefined())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('o que o WebSocket trouxe durante a leitura vence a resposta', async () => {
    let solta!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => { solta = r }))
    const { result } = renderHook(() => useSideSync(1, 'claude'))
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info({ id: 's2' }) }) })
    await act(async () => { solta(json(200, { side: null, events: [] })) })
    expect(result.current?.info.id).toBe('s2')
  })

  it('sem login não lê', () => {
    useStore.setState({ authStatus: 'login' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, { side: null, events: [] }))
    renderHook(() => useSideSync(1, 'claude'))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('requestAppend', () => {
  it('cada pedido ganha um seq novo', () => {
    requestAppend('c1', 'texto')
    const a = useSideStore.getState().appendRequest
    expect(a).toEqual({ localId: 'c1', text: 'texto', attachments: [], seq: 1 })
    requestAppend('c1', 'outro', [['[arq]', '/tmp/x.md']])
    expect(useSideStore.getState().appendRequest).toEqual({ localId: 'c1', text: 'outro', attachments: [['[arq]', '/tmp/x.md']], seq: 2 })
  })
})
