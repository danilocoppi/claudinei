import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
// --model é propagado ao fake porque extraArgsOverride substitui o argv inteiro:
// sem isso o init não reportaria modelo nenhum e a janela cairia no default.
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({
    ...opts, claudeBin: process.execPath,
    extraArgsOverride: [FAKE, ...(opts.model ? ['--model', opts.model] : [])],
  })

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let db: Db
let project: Project
let broadcasts: any[]

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  broadcasts = []
})
afterEach(() => { delete process.env.CLAUDE_FAKE_CTX })

const ecos = () => broadcasts.filter((b) =>
  b.type === 'session_event' && b.event?.kind === 'result' && /^eco: /.test(b.event.resultText ?? ''))

describe('medidor de contexto', () => {
  it('o result alimenta contextTokens no SessionInfo (input + caches do usage)', async () => {
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'oi')
    await waitUntil(() => ecos().length >= 1)
    // fake: input 10 + cache_read 100 (default) + creation 0
    await waitUntil(() => mgr.get(localId)?.contextTokens === 110)
    await mgr.stopAll()
  })
})

describe('auto-compact por limiar', () => {
  it('contexto acima do limiar → envia /compact UMA vez (com eco na UI), sem loop', async () => {
    process.env.CLAUDE_FAKE_CTX = '150000' // 75% da janela de 200k
    const mgr = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m),
      autoCompactPct: () => 50,
    })
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'oi')

    // o /compact automático vira um turno de verdade no CLI (o fake ecoa)
    await waitUntil(() => ecos().some((b) => b.event.resultText === 'eco: /compact'))
    // e a UI recebe o eco do usuário para a sessão não "trabalhar sozinha"
    expect(broadcasts.some((b) =>
      b.type === 'session_event' && b.event?.kind === 'user' &&
      JSON.stringify(b.event.message).includes('"/compact"'))).toBe(true)

    // o result do próprio /compact também vem alto (o fake não encolhe o ctx):
    // o flag segura — nada de /compact atrás de /compact
    await new Promise((r) => setTimeout(r, 300))
    expect(ecos().filter((b) => b.event.resultText === 'eco: /compact')).toHaveLength(1)
    await mgr.stopAll()
  })

  it('desligado (pct 0/ausente) não compacta nem com contexto alto', async () => {
    process.env.CLAUDE_FAKE_CTX = '190000'
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'oi')
    await waitUntil(() => ecos().length >= 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(ecos().some((b) => b.event.resultText === 'eco: /compact')).toBe(false)
    await mgr.stopAll()
  })

  it('abaixo do limiar não dispara', async () => {
    process.env.CLAUDE_FAKE_CTX = '50000' // 25% < limiar 50%
    const mgr = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m),
      autoCompactPct: () => 50,
    })
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'oi')
    await waitUntil(() => ecos().length >= 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(ecos().some((b) => b.event.resultText === 'eco: /compact')).toBe(false)
    await mgr.stopAll()
  })
})

describe('janela de contexto por modelo (existem modelos de 1M)', () => {
  it('o SessionInfo traz a janela do modelo que o init reportou', async () => {
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    const { localId } = mgr.start(project, { model: 'opus' })
    await waitUntil(() => mgr.get(localId)?.contextWindow === 1_000_000)
    await mgr.stopAll()
  })

  it('modelo sem 1M conhecido fica no conservador de 200k', async () => {
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    const { localId } = mgr.start(project, { model: 'haiku' })
    await waitUntil(() => mgr.get(localId)?.contextWindow === 200_000)
    await mgr.stopAll()
  })

  it('o auto-compact mede contra a janela REAL: 150k num modelo de 1M é 15%, não 75%', async () => {
    process.env.CLAUDE_FAKE_CTX = '150000'
    const mgr = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m),
      autoCompactPct: () => 50,
    })
    const { localId } = mgr.start(project, { model: 'opus' })
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'oi')
    await waitUntil(() => ecos().length >= 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(ecos().some((b) => b.event.resultText === 'eco: /compact')).toBe(false)
    await mgr.stopAll()
  })
})
