import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMe, login } from '../api'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('api de auth', () => {
  it('fetchMe devolve setupRequired', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: true }))
    await expect(fetchMe()).resolves.toEqual({ setupRequired: true })
  })

  it('login POSTa credenciais', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root' }))
    await login('root', 's')
    expect(spy.mock.calls[0][0]).toBe('/api/auth/login')
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ username: 'root', password: 's' })
  })

  it('401 fora de /api/auth dispara claudinei:unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'unauthorized' }, 401))
    const handler = vi.fn()
    window.addEventListener('claudinei:unauthorized', handler)
    const { fetchProjects } = await import('../api')
    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
    window.removeEventListener('claudinei:unauthorized', handler)
  })

  it('401 do próprio login NÃO dispara o evento (senão loop)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'invalid_credentials' }, 401))
    const handler = vi.fn()
    window.addEventListener('claudinei:unauthorized', handler)
    await expect(login('root', 'errada')).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
    window.removeEventListener('claudinei:unauthorized', handler)
  })
})
