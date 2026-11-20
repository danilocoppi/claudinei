import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createTerminalStateStore, toDto, type TerminalStateStore } from '../src/restart/terminal-state.js'

describe('terminal_state: limite de uso', () => {
  let db: Db
  let store: TerminalStateStore
  let p: number

  beforeEach(() => {
    db = openDb(':memory:')
    p = Number(db.prepare(`INSERT INTO projects (name, path) VALUES ('P', '/tmp/p')`).run().lastInsertRowid)
    store = createTerminalStateStore(db)
  })

  it('terminal sem linha: sem limite e interruptor do limite desligado', () => {
    const row = store.get(p, 'claude')
    expect(row.autoResumeLimit).toBe(false)
    expect(row.limitHitAt).toBeNull()
    expect(row.limitResetsAt).toBeNull()
    expect(row.limitAction).toBe('none')
    expect(row.limitOrigin).toBeNull()
    expect(row.limitTries).toBe(0)
    expect(toDto(row)).toMatchObject({ autoResumeLimit: false, usageLimit: null })
    expect(store.takeLimit(p, 'claude')).toBeNull()
    expect(store.listArmed()).toEqual([])
    expect(store.listSnoozed()).toEqual([])
  })

  it('recordUsageLimit grava hora, reabertura e origem sem tocar no reinício', () => {
    store.setPrefs(p, 'claude', { autoResume: true })
    store.markInterrupted(p, 'claude', 'L1', null)
    store.setHold(p, 'claude', 'question')
    store.bumpResume(p, 'claude')
    const before = store.get(p, 'claude')

    const row = store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'schedule' })
    expect(row.limitHitAt).not.toBeNull()
    expect(row.limitResetsAt).toBe(1_800_000_000)
    expect(row.limitOrigin).toBe('schedule')
    expect(row.limitAction).toBe('none')
    expect(row).toMatchObject({
      autoResume: true,
      interruptedAt: before.interruptedAt,
      interruptedLocalId: 'L1',
      holdReason: 'question',
      resumeCount: 1,
    })

    // Gravar de novo, já armado, volta a ação para 'none'.
    store.setLimitAction(p, 'claude', 'armed')
    const again = store.recordUsageLimit(p, 'claude', { resetsAt: null, origin: 'operator' })
    expect(again.limitAction).toBe('none')
    expect(again.limitResetsAt).toBeNull()
    expect(again.limitOrigin).toBe('operator')
  })

  it('takeLimit devolve uma vez só', () => {
    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'operator' })
    store.setLimitAction(p, 'claude', 'armed')
    const first = store.takeLimit(p, 'claude')
    expect(first).toMatchObject({ limitResetsAt: 1_800_000_000, limitAction: 'armed', limitOrigin: 'operator' })
    expect(first?.limitHitAt).not.toBeNull()
    expect(store.takeLimit(p, 'claude')).toBeNull()
    expect(store.get(p, 'claude')).toMatchObject({
      limitHitAt: null, limitResetsAt: null, limitAction: 'none', limitOrigin: null,
    })
  })

  it('clearLimit apaga o limite', () => {
    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'task' })
    store.setLimitAction(p, 'claude', 'snoozed')
    store.clearLimit(p, 'claude')
    expect(store.get(p, 'claude')).toMatchObject({
      limitHitAt: null, limitResetsAt: null, limitAction: 'none', limitOrigin: null,
    })
    expect(toDto(store.get(p, 'claude')).usageLimit).toBeNull()
  })

  it('listArmed só devolve os armados; listSnoozed só devolve os adiados', () => {
    const p2 = Number(db.prepare(`INSERT INTO projects (name, path) VALUES ('Q', '/tmp/q')`).run().lastInsertRowid)
    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'operator' })
    store.setLimitAction(p, 'claude', 'armed')
    store.recordUsageLimit(p2, 'claude', { resetsAt: 1_800_000_100, origin: 'operator' })
    store.setLimitAction(p2, 'claude', 'snoozed')
    store.recordUsageLimit(p, 'codex', { resetsAt: 1_800_000_200, origin: 'operator' })
    // Ação armada sem limite ativo não conta.
    store.setPrefs(p2, 'codex', { autostart: true })
    store.setLimitAction(p2, 'codex', 'armed')
    expect(store.get(p2, 'codex')).toMatchObject({ limitHitAt: null, limitAction: 'armed' })

    expect(store.listArmed().map((r) => [r.projectId, r.engine])).toEqual([[p, 'claude']])
    expect(store.listSnoozed().map((r) => [r.projectId, r.engine])).toEqual([[p2, 'claude']])
  })

  it('setPrefs com autoResumeLimit não mexe nos outros interruptores', () => {
    store.setPrefs(p, 'claude', { autostart: true, autoResume: true })
    const row = store.setPrefs(p, 'claude', { autoResumeLimit: true })
    expect(row).toMatchObject({ autostart: true, autoResume: true, autoResumeLimit: true })
    const row2 = store.setPrefs(p, 'claude', { autostart: false })
    expect(row2).toMatchObject({ autostart: false, autoResume: true, autoResumeLimit: true })
    // Terminal novo só com o interruptor do limite.
    expect(store.setPrefs(p, 'codex', { autoResumeLimit: true })).toMatchObject({
      autostart: false, autoResume: false, autoResumeLimit: true,
    })
    expect(toDto(store.get(p, 'claude')).autoResumeLimit).toBe(true)
  })

  it('toDto: usageLimit null sem limite; com limite traz resetsAt em segundos', () => {
    expect(toDto(store.get(p, 'claude')).usageLimit).toBeNull()

    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'claudinei' })
    store.setLimitAction(p, 'claude', 'snoozed')
    const row = store.get(p, 'claude')
    expect(toDto(row).usageLimit).toEqual({
      hitAt: row.limitHitAt, resetsAt: 1_800_000_000, action: 'snoozed', origin: 'claudinei',
    })

    // Sem horário conhecido o limite continua no DTO.
    store.recordUsageLimit(p, 'claude', { resetsAt: null, origin: 'operator' })
    expect(toDto(store.get(p, 'claude')).usageLimit).toMatchObject({ resetsAt: null, action: 'none' })

    // Ação ou origem inválidas no banco viram 'none' e 'operator'.
    db.prepare(`UPDATE terminal_state SET limit_action = 'xpto', limit_origin = NULL WHERE project_id = ?`).run(p)
    const bad = store.get(p, 'claude')
    expect(bad.limitAction).toBe('none')
    expect(toDto(bad).usageLimit).toMatchObject({ action: 'none', origin: 'operator' })
  })

  it('limit_tries sobrevive a recordUsageLimit e zera com resetLimitTries', () => {
    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_000, origin: 'operator' })
    store.bumpLimitTries(p, 'claude')
    store.recordUsageLimit(p, 'claude', { resetsAt: 1_800_000_500, origin: 'operator' })
    expect(store.get(p, 'claude').limitTries).toBe(1)
    store.takeLimit(p, 'claude')
    expect(store.get(p, 'claude').limitTries).toBe(1)
    store.bumpLimitTries(p, 'claude')
    expect(store.get(p, 'claude').limitTries).toBe(2)
    store.resetLimitTries(p, 'claude')
    expect(store.get(p, 'claude').limitTries).toBe(0)
    // Terminal sem linha também conta.
    store.bumpLimitTries(p, 'codex')
    expect(store.get(p, 'codex').limitTries).toBe(1)
  })
})
