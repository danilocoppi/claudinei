import { describe, it, expect } from 'vitest'
import { hermesCall, fakeApi } from './helpers/hermes.js'

// show_page: o agente publica uma página que aparece na conversa (projeto 15).
describe('hermes: show_page', () => {
  const ROTA = '/api/hermes/pages'

  it('show_page chama a rota com projeto, motor e campos', async () => {
    const api = await fakeApi(() => [201, { id: 'pg_0123456789abcdef', bytes: 2048, warnings: [] }], ROTA)
    const [r] = await hermesCall(api.url, { CLAUDINEI_ENGINE: 'codex' }, [{
      method: 'tools/call',
      params: { name: 'show_page', arguments: { html: '<p>oi</p>', title: 'Gráfico', height: 480 } },
    }])
    api.close()
    expect(api.got).toEqual([{ projectId: 1, engine: 'codex', html: '<p>oi</p>', title: 'Gráfico', height: 480 }])
    expect(r.result.isError).toBeFalsy()

    // Com path e sem motor: o motor cai no claude, e os campos ausentes não vão.
    const api2 = await fakeApi(() => [201, { id: 'pg_0123456789abcdef', bytes: 10, warnings: [] }], ROTA)
    await hermesCall(api2.url, {}, [{
      method: 'tools/call', params: { name: 'show_page', arguments: { path: 'docs/rel.html', title: 'Relatório' } },
    }])
    api2.close()
    expect(api2.got).toEqual([{ projectId: 1, engine: 'claude', path: 'docs/rel.html', title: 'Relatório' }])
  }, 30000)

  it('resultado traz o id e o tamanho em KB, e os avisos', async () => {
    const api = await fakeApi(() => [201, {
      id: 'pg_00000000000000aa', bytes: 34 * 1024 + 100,
      warnings: ['2 local references not embedded: img/a.png, img/b.png'],
    }], ROTA)
    const [r] = await hermesCall(api.url, {}, [{
      method: 'tools/call', params: { name: 'show_page', arguments: { html: '<p>x</p>', title: 'T' } },
    }])
    api.close()
    expect(r.result.isError).toBeFalsy()
    expect(r.result.content[0].text).toBe(
      'page shown to the operator (id pg_00000000000000aa, 34 KB)\n2 local references not embedded: img/a.png, img/b.png',
    )

    // Página minúscula: nunca "0 KB".
    const api2 = await fakeApi(() => [201, { id: 'pg_00000000000000bb', bytes: 12, warnings: [] }], ROTA)
    const [r2] = await hermesCall(api2.url, {}, [{
      method: 'tools/call', params: { name: 'show_page', arguments: { html: '<p>x</p>', title: 'T' } },
    }])
    api2.close()
    expect(r2.result.content[0].text).toBe('page shown to the operator (id pg_00000000000000bb, 1 KB)')
  }, 30000)

  it('recusa da rota vira isError com o motivo', async () => {
    const api = await fakeApi(() => [409, {
      error: 'no live session in this terminal; open it in Claudinei first', code: 'no_live_session',
    }], ROTA)
    const [r] = await hermesCall(api.url, {}, [{
      method: 'tools/call', params: { name: 'show_page', arguments: { html: '<p>x</p>', title: 'T' } },
    }])
    api.close()
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toBe('show_page rejected: no live session in this terminal; open it in Claudinei first')
  }, 20000)

  it('descrição ≤ 2000, cita check_page, jsdelivr e @tailwindcss/browser@4, e sem alwaysLoad', async () => {
    const [r] = await hermesCall('http://127.0.0.1:1', {}, [{ method: 'tools/list', params: {} }])
    const tool = r.result.tools.find((t: any) => t.name === 'show_page')
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeLessThanOrEqual(2000)
    expect(tool.description).toContain('check_page')
    expect(tool.description).toContain('https://cdn.jsdelivr.net')
    expect(tool.description).toContain('@tailwindcss/browser@4')
    expect(tool._meta?.['anthropic/alwaysLoad']).toBeUndefined()
    // O esquema: título obrigatório, html com teto, altura de 120 a 2000.
    const props = tool.inputSchema.properties
    expect(tool.inputSchema.required).toEqual(['title'])
    expect(props.html.maxLength).toBe(524288)
    expect(props.title).toMatchObject({ minLength: 1, maxLength: 120 })
    expect(props.height).toMatchObject({ minimum: 120, maximum: 2000 })
  }, 20000)
})
