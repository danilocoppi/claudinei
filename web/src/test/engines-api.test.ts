import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fetchEngines } from '../api'
import { useStore, engineFor } from '../store'
import type { EngineMeta, SessionInfo } from '../types'

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude', icon: '🤖',
  models: ['opus', 'sonnet'], efforts: ['low', 'high'], permissions: ['default', 'plan'],
  slashSource: 'protocol', slashCommands: ['compact', 'cost'],
}
const CODEX: EngineMeta = {
  id: 'codex', label: 'Codex', icon: '🧠',
  models: ['gpt-5'], efforts: [], permissions: [],
  slashSource: 'curated', slashCommands: ['diff'],
}

afterEach(() => vi.restoreAllMocks())

describe('fetchEngines', () => {
  it('faz GET em /api/engines e devolve a lista', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([CLAUDE, CODEX]))
    await expect(fetchEngines()).resolves.toEqual([CLAUDE, CODEX])
    expect(spy).toHaveBeenCalledWith('/api/engines', expect.objectContaining({}))
  })
})

describe('engineFor', () => {
  beforeEach(() => {
    useStore.setState({ engines: [CLAUDE, CODEX] })
  })

  it('resolve a engine pelo campo session.engine', () => {
    const session = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'codex' } as SessionInfo
    expect(engineFor(session)).toEqual(CODEX)
  })

  it('sessão sem engine reconhecida cai no fallback claude', () => {
    const session = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'inexistente' } as SessionInfo
    expect(engineFor(session)).toEqual(CLAUDE)
  })

  it('sem sessão cai no fallback claude', () => {
    expect(engineFor(undefined)).toEqual(CLAUDE)
  })

  it('sem engine claude nas engines, cai no primeiro da lista', () => {
    useStore.setState({ engines: [CODEX] })
    expect(engineFor(undefined)).toEqual(CODEX)
  })
})
