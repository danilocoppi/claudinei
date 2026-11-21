import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyUndoWsMessage, useUndoStore } from '../undo/undoStore'
import { useStore } from '../store'
import type { TerminalTurnsDto, TurnDto } from '../../../shared/undo'
import type { SessionInfo } from '../types'

const turn = (id: number, over: Partial<TurnDto> = {}): TurnDto => ({
  id, localId: 'A', projectId: 1, engine: 'claude', origin: 'operator', key: `msg ${id}`, midTurn: false,
  state: 'ok', limited: false, endKind: 'result', summary: null, lastRun: null,
  startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})
const dto = (turns: TurnDto[], over: Partial<TerminalTurnsDto> = {}): TerminalTurnsDto =>
  ({ git: true, turns, outside: [], interactive: [], intervals: [], ...over })
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const session = (localId: string, projectId: number, engine = 'claude') =>
  ({ localId, projectId, engine, status: 'idle', engineSessionId: null, updatedAt: '' }) as SessionInfo

beforeEach(() => {
  useUndoStore.setState({ byLocal: {}, terminalOf: {} })
  useStore.setState({ sessions: { A: session('A', 1), B: session('B', 1, 'codex'), C: session('C', 2) } })
})
afterEach(() => vi.restoreAllMocks())

describe('undoStore', () => {
  it('load busca os turnos do terminal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(dto([turn(1)])))
    await useUndoStore.getState().load('A')
    expect(spy.mock.calls[0][0]).toBe('/api/undo/terminals/A/turns')
    expect(useUndoStore.getState().byLocal.A?.turns.map(t => t.id)).toEqual([1])
  })

  it('undo_turn insere e atualiza pelo id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(dto([turn(1), turn(3)])))
    await useUndoStore.getState().load('A')

    // Novo: entra na ordem dos ids.
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'A', engine: 'claude', turn: turn(2, { state: 'running', endedAt: null }) })
    expect(useUndoStore.getState().byLocal.A?.turns.map(t => [t.id, t.state])).toEqual([[1, 'ok'], [2, 'running'], [3, 'ok']])

    // Mesmo id: troca no lugar.
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'A', engine: 'claude', turn: turn(2, { state: 'late' }) })
    expect(useUndoStore.getState().byLocal.A?.turns.map(t => [t.id, t.state])).toEqual([[1, 'ok'], [2, 'late'], [3, 'ok']])

    // Atualiza onde estiver, inclusive fora da conversa atual.
    useUndoStore.setState(s => ({ byLocal: { ...s.byLocal, A: { ...s.byLocal.A!, outside: [turn(9)] } } }))
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'A', engine: 'claude', turn: turn(9, { lastRun: { id: 4, redone: false } }) })
    expect(useUndoStore.getState().byLocal.A?.outside[0].lastRun).toEqual({ id: 4, redone: false })
    expect(useUndoStore.getState().byLocal.A?.turns).toHaveLength(3)

    // Feito no terminal interativo: na lista dele.
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'A', engine: 'claude', turn: turn(10, { origin: 'interactive' }) })
    expect(useUndoStore.getState().byLocal.A?.interactive.map(t => t.id)).toEqual([10])
  })

  it('undo_turn de outro terminal (projeto ou motor) não mexe; o do mesmo terminal vale para outra sessão dele', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(dto([])))
    await useUndoStore.getState().load('A')
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'B', engine: 'codex', turn: turn(5, { localId: 'B', engine: 'codex' }) })
    applyUndoWsMessage({ type: 'undo_turn', projectId: 2, localId: 'C', engine: 'claude', turn: turn(6, { localId: 'C', projectId: 2 }) })
    expect(useUndoStore.getState().byLocal.A?.turns).toEqual([])
    // Sessão anterior do mesmo terminal (projeto + motor): os turnos são do terminal.
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'velha', engine: 'claude', turn: turn(7, { localId: 'velha' }) })
    expect(useUndoStore.getState().byLocal.A?.turns.map(t => t.id)).toEqual([7])
  })

  it('undo_turn que chega durante o load não se perde', async () => {
    let release!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(r => { release = r }))
    const loading = useUndoStore.getState().load('A')
    applyUndoWsMessage({ type: 'undo_turn', projectId: 1, localId: 'A', engine: 'claude', turn: turn(2, { state: 'running' }) })
    release(okJson(dto([turn(1)])))
    await loading
    expect(useUndoStore.getState().byLocal.A?.turns.map(t => [t.id, t.state])).toEqual([[1, 'ok'], [2, 'running']])
  })

  it('undo_run recarrega o terminal do projeto', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson(dto([turn(1)])))
    await useUndoStore.getState().load('A')
    await useUndoStore.getState().load('B')
    await useUndoStore.getState().load('C')
    spy.mockClear()
    spy.mockImplementation(async () => okJson(dto([turn(1, { lastRun: { id: 8, redone: false } })])))

    applyUndoWsMessage({ type: 'undo_run', projectId: 1, engine: 'claude', run: { id: 8, kind: 'undo', turnIds: [1], files: [], redone: false } })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    // Os dois terminais do projeto 1 (o desfazer muda os intervalos do repositório para os dois); o do projeto 2, não.
    expect(spy.mock.calls.map(c => c[0]).sort()).toEqual(['/api/undo/terminals/A/turns', '/api/undo/terminals/B/turns'])
    await vi.waitFor(() => expect(useUndoStore.getState().byLocal.A?.turns[0].lastRun).toEqual({ id: 8, redone: false }))
  })

  it('reconexão recarrega os terminais carregados', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson(dto([])))
    await useUndoStore.getState().load('A')
    spy.mockClear()
    useStore.getState().resyncOnReconnect()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0][0]).toBe('/api/undo/terminals/A/turns')
  })

  it('mensagem de outro tipo é ignorada', () => {
    const before = useUndoStore.getState()
    applyUndoWsMessage({ type: 'session_update', localId: 'A' })
    applyUndoWsMessage(null)
    expect(useUndoStore.getState()).toBe(before)
  })
})

describe('undo/api', () => {
  it('o 409 undo_changed chega como erro com code e a prévia nova', async () => {
    const { applyUndo, changedPreview } = await import('../undo/api')
    const preview = { token: 'novo', turnIds: [1], blockedBy: null, branchChanged: null, files: [], notUndoable: [], hiddenOutside: 0 }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'os arquivos mudaram', code: 'undo_changed', params: {}, preview }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ))
    const err = await applyUndo([1], { token: 'velho', decisions: {} }).catch(e => e)
    expect(err.code).toBe('undo_changed')
    expect(err.status).toBe(409)
    expect(changedPreview(err)).toEqual(preview)
    expect(changedPreview(new Error('outro'))).toBeNull()
  })

  it('os intervalos levam o terminal em ?localId=', async () => {
    const { fetchIntervalFiles, fetchIntervalDiff } = await import('../undo/api')
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson({ files: [], hiddenOutside: 0, warnings: [] }))
    await fetchIntervalFiles('A b', 3, 4)
    await fetchIntervalDiff('A', 3, 4, 'dir com espaço/a.ts')
    expect(spy.mock.calls.map(c => c[0])).toEqual([
      '/api/undo/intervals/3/4/files?localId=A+b',
      '/api/undo/intervals/3/4/diff?localId=A&path=dir+com+espa%C3%A7o%2Fa.ts',
    ])
  })
})
