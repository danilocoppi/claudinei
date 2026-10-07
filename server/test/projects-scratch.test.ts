import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createScratchDir } from '../src/scratch.js'

let app: Awaited<ReturnType<typeof buildApp>>
let base: string

beforeEach(async () => {
  // A base NÃO existe ainda: a rota tem de criá-la na primeira vez.
  base = join(mkdtempSync(join(tmpdir(), 'tm-scratch-')), 'scratch')
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: { ...loadConfig({}), scratchDir: base }, db, manager })
})

const post = (payload?: unknown) =>
  app.inject({ method: 'POST', url: '/api/projects/scratch', ...(payload === undefined ? {} : { payload: payload as object }) })

describe('POST /api/projects/scratch', () => {
  it('cria uma pasta nova dentro da base e um terminal apontando para ela', async () => {
    const res = await post({ name: 'Temporário 04/10 19:42' })
    expect(res.statusCode).toBe(201)
    const p = res.json()
    expect(p.name).toBe('Temporário 04/10 19:42')
    expect(p.icon).toBe('🧪')
    expect(dirname(p.path)).toBe(base)
    expect(basename(p.path)).toMatch(/^temp-\d{8}-\d{6}(-\d+)?$/)
    expect(statSync(p.path).isDirectory()).toBe(true)
    expect(readdirSync(p.path)).toEqual([])

    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json().map((x: { id: number }) => x.id)).toContain(p.id)
  })

  it('duas criações seguidas nunca dividem a mesma pasta', async () => {
    const a = (await post({ name: 'A' })).json()
    const b = (await post({ name: 'B' })).json()
    expect(a.path).not.toBe(b.path)
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true)
  })

  it('ignora um path enviado pelo cliente: a pasta é sempre a reservada na base', async () => {
    const outra = mkdtempSync(join(tmpdir(), 'tm-outra-'))
    const res = await post({ name: 'X', path: outra })
    expect(res.statusCode).toBe(201)
    expect(dirname(res.json().path)).toBe(base)
  })

  it('sem nome, usa o nome da pasta', async () => {
    const res = await post()
    expect(res.statusCode).toBe(201)
    expect(res.json().name).toBe(basename(res.json().path))
  })

  it('aceita ícone e cor escolhidos', async () => {
    const res = await post({ name: 'Y', icon: 'mdi:flask', color: '#00ff88' })
    expect(res.statusCode).toBe(201)
    expect(res.json().icon).toBe('mdi:flask')
    expect(res.json().color).toBe('#00ff88')
  })

  it('recusa nome longo demais ou ícone inválido sem deixar pasta para trás', async () => {
    expect((await post({ name: 'n'.repeat(121) })).statusCode).toBe(400)
    expect((await post({ name: 'ok', icon: 'isto não é ícone' })).statusCode).toBe(400)
    expect((await post({ name: 42 })).statusCode).toBe(400)
    expect(existsSync(base) ? readdirSync(base) : []).toEqual([])
  })
})

describe('createScratchDir', () => {
  it('no mesmo segundo, acrescenta um sufixo em vez de reaproveitar a pasta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-scratch-unit-'))
    const quando = new Date(2026, 9, 4, 19, 42, 10)
    const a = createScratchDir(dir, quando)
    const b = createScratchDir(dir, quando)
    expect(basename(a)).toBe('temp-20261004-194210')
    expect(basename(b)).toBe('temp-20261004-194210-2')
  })
})
