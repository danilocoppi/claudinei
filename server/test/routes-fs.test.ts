import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
})

describe('GET /api/fs/list', () => {
  it('lista apenas subdiretórios (ignora arquivos), com parent e paths absolutos', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fs-'))
    mkdirSync(join(base, 'sub-a'))
    mkdirSync(join(base, 'sub-b'))
    writeFileSync(join(base, 'arquivo.txt'), 'x')
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(base)}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.path).toBe(base)
    expect(body.parent).toBe(dirname(base))
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('sub-a')
    expect(names).toContain('sub-b')
    expect(names).not.toContain('arquivo.txt')
    expect(body.entries.every((e: any) => e.isDir === true)).toBe(true)
    expect(body.entries.every((e: any) => e.path.startsWith(base))).toBe(true)
  })

  it('sem path usa o home do usuário', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe(homedir())
  })

  it('path inexistente retorna 400 com error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=/nao/existe/xyz-123' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('parent é null na raiz do filesystem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().parent).toBeNull()
  })
})
