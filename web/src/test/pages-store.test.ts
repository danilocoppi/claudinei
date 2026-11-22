import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyPagesWsMessage, usePagesStore } from '../pages/pagesStore'
import { useStore } from '../store'
import type { VisualPageDto } from '../../../shared/visual-pages'

const page = (id: string, localId = 'A', over: Partial<VisualPageDto> = {}): VisualPageDto => ({
  id, projectId: 1, engine: 'claude', localId, conversationId: 'conv', turnId: 1, turnKey: 'faça',
  title: 'Gráfico', height: null, bytes: 3000, source: 'html', createdAt: '2026-11-21 12:00:00', ...over,
})
const PG1 = 'pg_0000000000000001'
const PG2 = 'pg_0000000000000002'
const PG3 = 'pg_0000000000000003'

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const errJson = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
const event = (p: VisualPageDto) => ({ type: 'visual_page', projectId: p.projectId, engine: p.engine, localId: p.localId, page: p })

beforeEach(() => {
  usePagesStore.setState({ byLocal: {}, byId: {}, livePageId: null })
  useStore.setState({ activeLocalId: 'A' })
})
afterEach(() => vi.restoreAllMocks())

describe('pagesStore', () => {
  it('load busca a lista da conversa e preenche byId', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([page(PG1), page(PG2)]))
    await usePagesStore.getState().load('A')
    expect(spy.mock.calls[0][0]).toBe('/api/sessions/A/pages')
    expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG1, PG2])
    expect(usePagesStore.getState().byId[PG2]).toMatchObject({ id: PG2 })
  })

  it('visual_page do terminal ativo vira a viva; de outro terminal só entra na lista', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson([]))
    await usePagesStore.getState().load('A')
    await usePagesStore.getState().load('B')

    applyPagesWsMessage(event(page(PG1, 'B')))
    expect(usePagesStore.getState().byLocal.B?.map(p => p.id)).toEqual([PG1])
    expect(usePagesStore.getState().byId[PG1]).toMatchObject({ id: PG1 })
    expect(usePagesStore.getState().livePageId).toBeNull()

    applyPagesWsMessage(event(page(PG2, 'A')))
    expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG2])
    expect(usePagesStore.getState().livePageId).toBe(PG2)

    // Terminal não carregado: a lista dele continua por carregar (a carga traz tudo).
    applyPagesWsMessage(event(page(PG3, 'C')))
    expect(usePagesStore.getState().byLocal.C).toBeUndefined()
    expect(usePagesStore.getState().byId[PG3]).toMatchObject({ id: PG3 })
    // O mesmo evento duas vezes não duplica.
    applyPagesWsMessage(event(page(PG2, 'A')))
    expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG2])
  })

  it('uma viva por vez: setLive troca a anterior', () => {
    usePagesStore.getState().setLive(PG1)
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    usePagesStore.getState().setLive(PG2)
    expect(usePagesStore.getState().livePageId).toBe(PG2)
    // A chegada de outra página do terminal ativo também troca.
    applyPagesWsMessage(event(page(PG3, 'A')))
    expect(usePagesStore.getState().livePageId).toBe(PG3)
    usePagesStore.getState().setLive(null)
    expect(usePagesStore.getState().livePageId).toBeNull()
  })

  it('fetchOne com 403 e com 404 vira unavailable', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errJson(403, 'forbidden'))
      .mockResolvedValueOnce(errJson(404, 'not_found'))
      .mockResolvedValueOnce(okJson(page(PG3)))
    await usePagesStore.getState().fetchOne(PG1)
    await usePagesStore.getState().fetchOne(PG2)
    await usePagesStore.getState().fetchOne(PG3)
    expect(spy.mock.calls.map(c => c[0])).toEqual([`/api/pages/${PG1}`, `/api/pages/${PG2}`, `/api/pages/${PG3}`])
    expect(usePagesStore.getState().byId[PG1]).toBe('unavailable')
    expect(usePagesStore.getState().byId[PG2]).toBe('unavailable')
    expect(usePagesStore.getState().byId[PG3]).toMatchObject({ id: PG3 })
  })

  it('fetchOne com outra falha não marca unavailable (o cartão pode tentar de novo)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errJson(500, 'boom'))
    await expect(usePagesStore.getState().fetchOne(PG1)).rejects.toThrow()
    expect(usePagesStore.getState().byId[PG1]).toBeUndefined()
  })

  it('carga antiga que responde depois da nova não sobrescreve', async () => {
    const releases: ((r: Response) => void)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(r => { releases.push(r) }))
    const old = usePagesStore.getState().load('A')
    const fresh = usePagesStore.getState().load('A')
    releases[1](okJson([page(PG1), page(PG2)]))
    await fresh
    releases[0](okJson([page(PG1)]))
    await old
    expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG1, PG2])
  })

  it('visual_page que chega durante a carga não se perde', async () => {
    let release!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(r => { release = r }))
    const loading = usePagesStore.getState().load('A')
    applyPagesWsMessage(event(page(PG2, 'A')))
    // A resposta saiu antes da página nova.
    release(okJson([page(PG1)]))
    await loading
    expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG1, PG2])
  })

  it('na reconexão, recarrega as conversas carregadas', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson([]))
    await usePagesStore.getState().load('A')
    spy.mockResolvedValueOnce(okJson([page(PG1)]))
    useStore.setState(s => ({ progressEpoch: s.progressEpoch + 1 }))
    await vi.waitFor(() => expect(usePagesStore.getState().byLocal.A?.map(p => p.id)).toEqual([PG1]))
    expect(spy.mock.calls.map(c => c[0])).toEqual(['/api/sessions/A/pages', '/api/sessions/A/pages'])
  })
})
