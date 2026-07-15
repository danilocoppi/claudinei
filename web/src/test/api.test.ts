import { describe, it, expect, vi, afterEach } from 'vitest'
import { startSession, createProject } from '../api'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('api req headers', () => {
  it('POST sem corpo não envia Content-Type (evita FST_ERR_CTP_EMPTY_JSON_BODY)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ localId: 'x' }, 201))
    await startSession(1)
    const opts = spy.mock.calls[0][1] as RequestInit
    expect(opts.headers).toBeUndefined()
    expect(opts.body).toBeUndefined()
  })

  it('POST com corpo envia Content-Type application/json', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ id: 1 }, 201))
    await createProject({ name: 'X', path: '/tmp' })
    const opts = spy.mock.calls[0][1] as RequestInit
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('openTerminal faz POST em /terminal e devolve token+wsUrl', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 't', wsUrl: '/ws/terminal/a' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const { openTerminal } = await import('../api')
    await expect(openTerminal('a')).resolves.toEqual({ token: 't', wsUrl: '/ws/terminal/a' })
    expect(spy).toHaveBeenCalledWith('/api/sessions/a/terminal', expect.objectContaining({ method: 'POST' }))
    spy.mockRestore()
  })
})
