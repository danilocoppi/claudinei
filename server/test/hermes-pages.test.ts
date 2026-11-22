import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { hermesCall, fakeApi } from './helpers/hermes.js'
import { buildInstructions } from '../src/hermes/instructions.js'

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

// check_page: a página renderizada no navegador sem tela, sem publicar nada (projeto 15).
describe('hermes: check_page', () => {
  const ROTA = '/api/hermes/pages/check'
  const PNG = Buffer.from('png-de-teste').toString('base64')

  it('check_page repassa html/path/width e devolve image + text com o caminho', async () => {
    const api = await fakeApi(() => [200, {
      png: PNG, height: 3000, cropped: true, loaded: true, file: '/tmp/claudinei-check/check-0123456789abcdef.png',
      console: ['[pageerror] x is not defined', '[log] pronto'],
    }], ROTA)
    const [r] = await hermesCall(api.url, { CLAUDINEI_ENGINE: 'codex' }, [{
      method: 'tools/call', params: { name: 'check_page', arguments: { html: '<p>oi</p>', width: 800 } },
    }])
    api.close()
    expect(api.got).toEqual([{ projectId: 1, html: '<p>oi</p>', width: 800 }])
    expect(r.result.isError).toBeFalsy()
    expect(r.result.content).toEqual([
      { type: 'image', data: PNG, mimeType: 'image/png' },
      {
        type: 'text',
        text: 'content height: 3000 px (screenshot cut at 2000 px)\n'
          + 'screenshot copy: /tmp/claudinei-check/check-0123456789abcdef.png (kept 30 min)\n'
          + 'console (2 lines, errors first):\n[pageerror] x is not defined\n[log] pronto',
      },
    ])

    // Com path, sem width; load estourado e console vazio.
    const api2 = await fakeApi(() => [200, {
      png: PNG, height: 640, cropped: false, loaded: false, file: '/tmp/c/check-00000000000000aa.png', console: [],
    }], ROTA)
    const [r2] = await hermesCall(api2.url, {}, [{
      method: 'tools/call', params: { name: 'check_page', arguments: { path: 'docs/rel.html' } },
    }])
    api2.close()
    expect(api2.got).toEqual([{ projectId: 1, path: 'docs/rel.html' }])
    expect(r2.result.content[0]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' })
    expect(r2.result.content[1].text).toBe(
      'content height: 640 px\n'
      + 'the load event did not fire within 10 s; captured anyway\n'
      + 'screenshot copy: /tmp/c/check-00000000000000aa.png (kept 30 min)\n'
      + 'console: empty',
    )
  }, 30000)

  it('busy vira isError com "busy, try again"', async () => {
    const api = await fakeApi(() => [503, { error: 'busy, try again', code: 'browser_busy' }], ROTA)
    const [r] = await hermesCall(api.url, {}, [{
      method: 'tools/call', params: { name: 'check_page', arguments: { html: '<p>x</p>' } },
    }])
    api.close()
    expect(r.result.isError).toBe(true)
    expect(r.result.content).toEqual([{ type: 'text', text: 'check_page failed: busy, try again' }])
  }, 20000)

  it('descrição ≤ 2000 e sem alwaysLoad; width de 360 a 1920', async () => {
    const [r] = await hermesCall('http://127.0.0.1:1', {}, [{ method: 'tools/list', params: {} }])
    const tool = r.result.tools.find((t: any) => t.name === 'check_page')
    expect(tool).toBeDefined()
    expect(tool.description.length).toBeLessThanOrEqual(2000)
    for (const s of ['show_page', '2000', '50', '30 min', 'busy', '1024']) expect(tool.description).toContain(s)
    expect(tool._meta?.['anthropic/alwaysLoad']).toBeUndefined()
    const props = tool.inputSchema.properties
    expect(tool.inputSchema.required ?? []).toEqual([])
    expect(props.html.maxLength).toBe(524288)
    expect(props.path.type).toBe('string')
    expect(props.width).toMatchObject({ type: 'integer', minimum: 360, maximum: 1920 })
  }, 20000)

  it('instructions do Hermes iguais às de antes (buildInstructions para a mesma entrada)', () => {
    // Hashes tirados de buildInstructions em c94ecd5, antes do check_page.
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    const dois = buildInstructions(1, [
      { id: 1, name: 'Claudinei', group: 'Ferramentas', sector: 'Interno' },
      { id: 2, name: 'Páginas', sector: 'Clientes' },
    ])
    const generica = buildInstructions(0, undefined)
    expect([dois.length, generica.length]).toEqual([1996, 1942])
    expect(sha(dois)).toBe('56d9fc2b3e5db45ef9ee73757b84b6c663deb9a8a2f705c55577a4ef8c3b4b4e')
    expect(sha(generica)).toBe('eaee8d9cea6ea6ad7c6bff211a3ea0cab830d9e0cae4be8eaa4a6265f244bc48')
  })
})
