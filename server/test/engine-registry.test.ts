import { describe, it, expect, beforeEach } from 'vitest'
import { registerEngine, getEngine, hasEngine, listEngines, DEFAULT_ENGINE_ID, __resetRegistry } from '../src/engine/registry.js'
import type { Engine } from '../src/engine/types.js'

const stubEngine = (id: string): Engine => ({
  id,
  bin: () => 'fake-bin',
  createSession: () => { throw new Error('not used in this test') },
  readHistory: () => [],
  latestConversationId: () => null,
  terminalCommand: () => ({ file: 'x', args: [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none', label: id, icon: '?', slashCommands: [] }),
})

describe('engine registry', () => {
  beforeEach(() => __resetRegistry())

  it('register/get/has/list', () => {
    expect(hasEngine('a')).toBe(false)
    const a = stubEngine('a')
    registerEngine(a)
    expect(hasEngine('a')).toBe(true)
    expect(getEngine('a')).toBe(a)
    expect(listEngines().map((e) => e.id)).toEqual(['a'])
  })

  it('id duplicado lança', () => {
    registerEngine(stubEngine('a'))
    expect(() => registerEngine(stubEngine('a'))).toThrow('engine_already_registered')
  })

  it('id desconhecido lança', () => {
    expect(() => getEngine('nope')).toThrow('unknown_engine')
  })

  it('DEFAULT_ENGINE_ID é claude', () => {
    expect(DEFAULT_ENGINE_ID).toBe('claude')
  })
})
