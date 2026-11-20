import { describe, it, expect } from 'vitest'
import { listedOf, tabEngines, pickableEngines, hiddenEngines } from '../terminalEngines'
import { primarySessionOf } from '../engineSession'
import type { EngineMeta, SessionInfo, SessionStatus } from '../types'

const meta = (id: string, extra: Partial<EngineMeta> = {}): EngineMeta => ({
  id, label: id, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [], ...extra,
})
const CLAUDE = meta('claude')
const CODEX = meta('codex')
const KIMI = meta('kimi')
const OPENCODE = meta('opencode')
const ALL = [CLAUDE, CODEX, KIMI, OPENCODE]

const sess = (localId: string, engine: string, status: SessionStatus, updatedAt = '2026-11-20T10:00:00Z', projectId = 1): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: null, updatedAt, engine })
const bySession = (...list: SessionInfo[]) => Object.fromEntries(list.map((s) => [s.localId, s]))

const ids = (list: EngineMeta[]) => list.map((e) => e.id)
const never = () => false

describe('tabEngines', () => {
  it('tabEngines mostra só os listados instalados', () => {
    const out = tabEngines({ engines: ALL, listed: ['claude'], projectId: 1, sessions: {}, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude'])
  })

  it('motor fora da lista com sessão viva ganha aba', () => {
    const sessions = bySession(sess('k1', 'kimi', 'working'))
    const out = tabEngines({ engines: ALL, listed: ['claude'], projectId: 1, sessions, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude', 'kimi'])
  })

  it('sessão viva de OUTRO terminal não dá aba aqui', () => {
    const sessions = bySession(sess('k1', 'kimi', 'working', undefined, 2))
    const out = tabEngines({ engines: ALL, listed: ['claude'], projectId: 1, sessions, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude'])
  })

  it('motor listado não instalado sem sessão não ganha aba', () => {
    const engines = [CLAUDE, { ...CODEX, available: false }, KIMI, OPENCODE]
    const out = tabEngines({ engines, listed: ['claude', 'codex'], projectId: 1, sessions: {}, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude'])
  })

  it('motor listado não instalado com sessão viva ganha aba', () => {
    const engines = [CLAUDE, { ...CODEX, available: false }, KIMI, OPENCODE]
    const sessions = bySession(sess('x1', 'codex', 'idle'))
    const out = tabEngines({ engines, listed: ['claude', 'codex'], projectId: 1, sessions, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude', 'codex'])
  })

  it('conversa aberta de motor escondido ganha aba', () => {
    const sessions = bySession(sess('k1', 'kimi', 'stopped'))
    const out = tabEngines({ engines: ALL, listed: ['claude'], projectId: 1, sessions, activeLocalId: 'k1', interrupted: never })
    expect(ids(out)).toEqual(['claude', 'kimi'])
  })

  it('motor escondido com aviso de interrompido ganha aba', () => {
    const out = tabEngines({
      engines: ALL, listed: ['claude'], projectId: 1, sessions: {}, activeLocalId: null,
      interrupted: (engine) => engine === 'codex',
    })
    expect(ids(out)).toEqual(['claude', 'codex'])
  })

  it('segue a ordem do store e ignora ids desconhecidos da lista', () => {
    const out = tabEngines({ engines: ALL, listed: ['kimi', 'futuro', 'claude'], projectId: 1, sessions: {}, activeLocalId: null, interrupted: never })
    expect(ids(out)).toEqual(['claude', 'kimi'])
  })
})

describe('listedOf', () => {
  it('listedOf trata lista ausente ou vazia como Claude', () => {
    expect(listedOf(undefined)).toEqual(['claude'])
    expect(listedOf({})).toEqual(['claude'])
    expect(listedOf({ engines: [] })).toEqual(['claude'])
  })

  it('devolve a lista do terminal, inclusive ids desconhecidos', () => {
    expect(listedOf({ engines: ['codex', 'futuro'] })).toEqual(['codex', 'futuro'])
  })
})

describe('pickableEngines e hiddenEngines', () => {
  it('pickableEngines devolve só os listados, na ordem do store', () => {
    expect(ids(pickableEngines(ALL, ['kimi', 'claude']))).toEqual(['claude', 'kimi'])
  })

  it('pickableEngines mantém o motor do agendamento existente', () => {
    expect(ids(pickableEngines(ALL, ['claude'], 'codex'))).toEqual(['claude', 'codex'])
    expect(ids(pickableEngines(ALL, ['claude'], null))).toEqual(['claude'])
  })

  it('hiddenEngines devolve os não listados, na ordem do store, inclusive os não instalados', () => {
    const engines = [CLAUDE, CODEX, { ...KIMI, available: false }, OPENCODE]
    expect(ids(hiddenEngines(engines, ['codex', 'futuro']))).toEqual(['claude', 'kimi', 'opencode'])
    expect(hiddenEngines(ALL, ['claude', 'codex', 'kimi', 'opencode'])).toEqual([])
  })
})

describe('primarySessionOf com a lista do terminal', () => {
  it('primarySessionOf com lista prefere a sessão parada de motor listado', () => {
    const sessions = bySession(
      sess('c1', 'claude', 'stopped', '2026-11-20T12:00:00Z'),
      sess('x1', 'codex', 'stopped', '2026-11-20T09:00:00Z'),
    )
    expect(primarySessionOf(1, sessions)?.localId).toBe('c1')
    expect(primarySessionOf(1, sessions, ['codex'])?.localId).toBe('x1')
  })

  it('primarySessionOf com lista não muda quando há sessão viva', () => {
    const sessions = bySession(
      sess('c1', 'claude', 'idle', '2026-11-20T08:00:00Z'),
      sess('x1', 'codex', 'stopped', '2026-11-20T12:00:00Z'),
    )
    expect(primarySessionOf(1, sessions, ['codex'])?.localId).toBe('c1')
  })

  it('sem sessão de motor listado, cai na regra atual', () => {
    const sessions = bySession(sess('c1', 'claude', 'stopped'))
    expect(primarySessionOf(1, sessions, ['codex'])?.localId).toBe('c1')
  })
})
