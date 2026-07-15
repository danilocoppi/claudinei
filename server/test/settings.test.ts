import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createSettingsService } from '../src/settings.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

describe('settings', () => {
  it('get/set persiste e sobrescreve', () => {
    const s = createSettingsService(db)
    expect(s.get('x')).toBeUndefined()
    s.set('x', 'a'); expect(s.get('x')).toBe('a')
    s.set('x', 'b'); expect(s.get('x')).toBe('b')
  })
  it('slash commands: round-trip por JSON; vazio/ inválido → []', () => {
    const s = createSettingsService(db)
    expect(s.getSlashCommands()).toEqual([])
    s.setSlashCommands(['compact', 'cost', 'superpowers:writing-plans'])
    expect(s.getSlashCommands()).toEqual(['compact', 'cost', 'superpowers:writing-plans'])
    db.prepare('UPDATE settings SET value=? WHERE key=?').run('nao-json', 'slash_commands')
    expect(s.getSlashCommands()).toEqual([])
  })
})

describe('captura de slashCommands no manager (onSlashCommands)', () => {
  it('evento init com slashCommands chama onSlashCommands', async () => {
    const { createSessionManager } = await import('../src/claude/manager.js')
    const { createProjectsService } = await import('../src/projects.js')
    const { ClaudeSession } = await import('../src/claude/session.js')
    const { fileURLToPath } = await import('node:url')
    const { join } = await import('node:path')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const FAKE = join(fileURLToPath(new URL('.', import.meta.url)), 'fake-claude.mjs')
    const project = createProjectsService(db).create({ name: 'P', path: mkdtempSync(join(tmpdir(), 'tm-')) })
    let captured: string[] | null = null
    const mgr = createSessionManager({
      db,
      sessionFactory: (o: any) => new ClaudeSession({ ...o, claudeBin: process.execPath, extraArgsOverride: [FAKE, '--slash', 'compact,cost'] }),
      broadcast: () => {},
      onSlashCommands: (c) => { captured = c },
    })
    const info = mgr.start(project)
    const start = Date.now()
    while (!captured && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 20))
    expect(captured).toEqual(['compact', 'cost'])
    await mgr.stop(info.localId)
  })
})
