import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createTerminalStateStore, toDto, captureCrashed, type TerminalStateStore } from '../src/restart/terminal-state.js'
import type { Question } from '../src/claude/session.js'

const q: Question = {
  question: 'Qual caminho?',
  header: 'Caminho',
  options: [{ label: 'A', description: 'primeiro' }, { label: 'B', description: 'segundo' }],
  multiSelect: false,
}

describe('terminal_state', () => {
  let db: Db
  let store: TerminalStateStore
  let p: number

  beforeEach(() => {
    db = openDb(':memory:')
    p = Number(db.prepare(`INSERT INTO projects (name, path) VALUES ('P', '/tmp/p')`).run().lastInsertRowid)
    store = createTerminalStateStore(db)
  })

  it('get de terminal sem linha devolve tudo desligado', () => {
    const row = store.get(p, 'claude')
    expect(row.autostart).toBe(false)
    expect(row.autoResume).toBe(false)
    expect(row.interruptedAt).toBeNull()
    expect(row.resumeCount).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('setPrefs grava só o que veio', () => {
    store.setPrefs(p, 'claude', { autostart: true })
    const row = store.setPrefs(p, 'claude', { autoResume: true })
    expect(row.autostart).toBe(true)
    expect(row.autoResume).toBe(true)
    expect(store.get(p, 'claude')).toMatchObject({ autostart: true, autoResume: true })
    // O outro motor do mesmo projeto é outro terminal.
    expect(store.get(p, 'codex').autostart).toBe(false)
  })

  it('markInterrupted preserva prefs e contador', () => {
    store.setPrefs(p, 'claude', { autoResume: true })
    store.bumpResume(p, 'claude')
    store.setHold(p, 'claude', 'limit')
    store.markInterrupted(p, 'claude', 'L1', [q])
    const row = store.get(p, 'claude')
    expect(row.interruptedAt).not.toBeNull()
    expect(row.interruptedLocalId).toBe('L1')
    expect(row.lostQuestion).toEqual([q])
    expect(row.resumeCount).toBe(1)
    expect(row.holdReason).toBeNull()
    expect(row.autoResume).toBe(true)
  })

  it('takeInterruption devolve uma vez só', () => {
    store.markInterrupted(p, 'claude', 'L1', null)
    const first = store.takeInterruption(p, 'claude')
    expect(first?.interruptedAt).not.toBeNull()
    expect(first?.interruptedLocalId).toBe('L1')
    expect(store.takeInterruption(p, 'claude')).toBeNull()
    expect(store.get(p, 'claude').interruptedAt).toBeNull()
  })

  it('clearInterruption e resetResume', () => {
    store.markInterrupted(p, 'claude', 'L1', [q])
    store.bumpResume(p, 'claude')
    store.bumpResume(p, 'claude')
    expect(store.get(p, 'claude').resumeCount).toBe(2)
    store.clearInterruption(p, 'claude')
    const row = store.get(p, 'claude')
    expect(row.interruptedAt).toBeNull()
    expect(row.interruptedLocalId).toBeNull()
    expect(row.lostQuestion).toBeNull()
    expect(row.resumeCount).toBe(2)
    store.resetResume(p, 'claude')
    expect(store.get(p, 'claude').resumeCount).toBe(0)
  })

  it('toDto dá reason queued sem hold e o hold quando há', () => {
    expect(toDto(store.get(p, 'claude')).interruption).toBeNull()

    store.markInterrupted(p, 'claude', 'L1', null)
    const queued = toDto(store.get(p, 'claude'))
    expect(queued).toMatchObject({ projectId: p, engine: 'claude', autostart: false, autoResume: false })
    expect(queued.interruption?.reason).toBe('queued')
    expect(queued.interruption?.question).toBeUndefined()

    store.markInterrupted(p, 'claude', 'L2', [q])
    store.setHold(p, 'claude', 'question')
    const held = toDto(store.get(p, 'claude'))
    expect(held.interruption?.reason).toBe('question')
    expect(held.interruption?.question).toEqual([q])
    expect(held.interruption?.at).toBe(store.get(p, 'claude').interruptedAt)
  })

  it('lost_question com JSON inválido é lido como null', () => {
    store.markInterrupted(p, 'claude', 'L1', [q])
    db.prepare(`UPDATE terminal_state SET lost_question = '{quebrado' WHERE project_id = ?`).run(p)
    expect(store.get(p, 'claude').lostQuestion).toBeNull()
  })

  it('captureCrashed marca sessões working com a pergunta gravada', () => {
    const ins = db.prepare(`INSERT INTO sessions (local_id, project_id, status, engine, pending_question) VALUES (?, ?, ?, ?, ?)`)
    ins.run('W1', p, 'working', 'claude', JSON.stringify([{ question: 'Q?', header: 'H', options: [], multiSelect: false }]))
    ins.run('I1', p, 'idle', 'codex', null)
    expect(captureCrashed(db)).toBe(1)
    const row = store.get(p, 'claude')
    expect(row.interruptedLocalId).toBe('W1')
    expect(row.lostQuestion?.[0].question).toBe('Q?')
    expect(row.holdReason).toBeNull()
    expect(store.get(p, 'codex').interruptedAt).toBeNull()
  })

  it('apagar o projeto apaga o estado', () => {
    store.setPrefs(p, 'claude', { autostart: true })
    store.markInterrupted(p, 'codex', 'L1', null)
    expect(store.list()).toHaveLength(2)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(p)
    expect(store.list()).toEqual([])
  })
})
