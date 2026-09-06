import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import '../src/engine/index.js'

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
function setup(pct = 0, args: string[] = []) {
  const db = openDb(':memory:'); const messages: any[] = []
  const project = createProjectsService(db).create({ name: 'Codex', path: '/tmp' })
  const manager = createSessionManager({
    db, broadcast: (m) => messages.push(m), autoCompactPct: () => pct,
    sessionFactory: (o) => new CodexSession({ ...o, binOverride: process.execPath, extraArgsOverride: [fake, ...args] }),
  })
  cleanup.push(async () => { await manager.stopAll(); db.close() })
  const { localId } = manager.start(project, { engine: 'codex' })
  return { manager, localId, messages }
}
const wait = (check: () => boolean) => expect.poll(check, { timeout: 5000, interval: 10 }).toBe(true)
const compactions = (messages: any[]) => messages.filter((m) => m.event?.kind === 'system' && m.event.subtype === 'compact_boundary')

describe('contexto Codex no manager', () => {
  it('janela vem do Codex e snapshots/status preservam a medição', async () => {
    const { manager, localId, messages } = setup()
    expect(manager.get(localId)?.contextWindow).toBeUndefined()
    manager.send(localId, 'oi')
    await wait(() => manager.get(localId)?.status === 'needs_attention')
    expect(manager.get(localId)).toMatchObject({ contextTokens: 120000, contextWindow: 400000 })
    expect(messages.filter((m) => m.type === 'session_status').at(-1)).toMatchObject({ contextTokens: 120000, contextWindow: 400000 })
    // A antiga janela de 200k do Claude faria 30% parecer 60%.
    expect(manager.list()[0].contextWindow).toBe(400000)
  })
  it('limiar dispara compactação nativa ao fim do turno e não gera loop', async () => {
    const { manager, localId, messages } = setup(60, ['--keep-large'])
    manager.send(localId, '__large__')
    await wait(() => compactions(messages).length === 1 && manager.get(localId)?.status === 'needs_attention')
    expect(messages.some((m) => m.event?.kind === 'result' && m.event.resultText === 'echo:/compact')).toBe(false)
    expect(messages.some((m) => m.event?.kind === 'user' && JSON.stringify(m.event).includes('/compact'))).toBe(true)
    manager.send(localId, '__large__')
    await wait(() => messages.filter((m) => m.event?.resultText === 'echo:__large__').length === 2)
    expect(compactions(messages)).toHaveLength(1)
    // Desce abaixo do limiar, re-arma e compacta no próximo cruzamento.
    manager.send(localId, 'small')
    await wait(() => manager.get(localId)?.status === 'needs_attention')
    manager.send(localId, '__large__')
    await wait(() => compactions(messages).length === 2)
  })
  it('desligado/abaixo do limiar não dispara compactação extra', async () => {
    for (const [pct, text] of [[0, '__large__'], [60, 'small']] as const) {
      const { manager, localId, messages } = setup(pct)
      manager.send(localId, text)
      await wait(() => manager.get(localId)?.status === 'needs_attention')
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(compactions(messages)).toHaveLength(0)
    }
  })
  it('compactação manual não pode entrar em turno ocupado', async () => {
    const { manager, localId } = setup()
    manager.send(localId, '__hang__')
    expect(() => manager.send(localId, '/compact')).toThrow(/aguarde/)
    await manager.interrupt(localId)
    await wait(() => manager.get(localId)?.status === 'idle')
    manager.send(localId, '/compact')
    await wait(() => manager.get(localId)?.status === 'needs_attention')
  })
})
