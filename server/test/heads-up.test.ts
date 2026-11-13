import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHeadsUp, type HeadsUpNode } from '../src/claude/heads-up.js'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project, type ProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import '../src/engine/index.js'

/**
 * Os avisos do plugin "You should know" do Claude CLI: o servidor anexa cada
 * terminal do Claude como superfície `desktop`, pede o desenho do AbovePrompt a
 * cada `ui_invalidate` e repassa o cartão às telas.
 */
const ENGINE = { type: 'engine', ref: 2 }
const card = (title: string) => ({ type: 'Box', children: [ENGINE, { type: 'Text', children: [title] },
  { type: 'Button', props: { key: 'x', label: 'Dispensar', role: 'dismiss' }, press: { plugin: 'p', handle: 1 } }] })
const rendered = (tree: unknown) => ({ tree, props: {}, rewritten: false, hooked: true, drawn_by: [] })

function fakeSurface(trees: unknown[]) {
  const calls: Array<[string, unknown]> = []
  let pending: Array<() => void> = []
  let hold = false
  const surface = {
    uiAttach: vi.fn(async () => { calls.push(['attach', null]); return { surfaces: ['desktop'] } }),
    uiDetach: vi.fn(async () => { calls.push(['detach', null]); return {} }),
    uiRender: vi.fn(async (props: unknown) => {
      calls.push(['render', props])
      if (hold) await new Promise<void>((r) => pending.push(r))
      const next = trees.length > 1 ? trees.shift() : trees[0]
      if (next instanceof Error) throw next
      return rendered(next)
    }),
    uiPress: vi.fn(async (p: unknown) => { calls.push(['press', p]); return { handled: true } }),
  }
  return { surface, calls, holdRenders: () => { hold = true }, release: () => { hold = false; const p = pending; pending = []; p.forEach((r) => r()) } }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('controlador dos avisos', () => {
  it('start anexa como desktop e pede o AbovePrompt; sem cartão do plugin, nada muda', async () => {
    const f = fakeSurface([ENGINE])
    const onChange = vi.fn()
    const h = createHeadsUp({ surface: f.surface, onChange })
    await h.start()
    expect(f.calls.map(([k]) => k)).toEqual(['attach', 'render'])
    expect(onChange).not.toHaveBeenCalled()
    expect(h.current()).toBeNull()
  })

  it('o cartão do plugin chega sem os nós do motor; o mesmo cartão de novo não repete o aviso', async () => {
    const f = fakeSurface([ENGINE, card('Risco grande'), card('Risco grande')])
    const onChange = vi.fn()
    const h = createHeadsUp({ surface: f.surface, onChange })
    await h.start()
    h.invalidate(); await flush(); await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
    const tree = onChange.mock.calls[0][0] as HeadsUpNode
    expect(JSON.stringify(tree)).toContain('Risco grande')
    expect(JSON.stringify(tree)).not.toContain('"engine"')
    h.invalidate(); await flush(); await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('quando o plugin volta a desenhar só o motor, o aviso sai (null)', async () => {
    const f = fakeSurface([ENGINE, card('A'), ENGINE])
    const onChange = vi.fn()
    const h = createHeadsUp({ surface: f.surface, onChange })
    await h.start()
    h.invalidate(); await flush(); await flush()
    h.invalidate(); await flush(); await flush()
    expect(onChange.mock.calls.map(([t]) => (t ? 'cartão' : null))).toEqual(['cartão', null])
    expect(h.current()).toBeNull()
  })

  it('vários ui_invalidate durante um desenho viram UM desenho a mais', async () => {
    const f = fakeSurface([ENGINE])
    const h = createHeadsUp({ surface: f.surface, onChange: () => {} })
    await h.start()
    f.holdRenders()
    h.invalidate(); h.invalidate(); h.invalidate(); h.invalidate()
    await flush()
    f.release(); await flush(); await flush()
    f.release(); await flush(); await flush()
    expect(f.calls.filter(([k]) => k === 'render')).toHaveLength(3) // start + o em voo + 1 coalescido
  })

  it('o clique vai ao plugin como ui_press da superfície desktop', async () => {
    const f = fakeSurface([ENGINE])
    const h = createHeadsUp({ surface: f.surface, onChange: () => {} })
    await h.start()
    await h.press({ plugin: 'cc-plugin-you-should-know', handle: 7, key: 'b7' })
    expect(f.surface.uiPress).toHaveBeenCalledWith({ plugin: 'cc-plugin-you-should-know', handle: 7, key: 'b7' })
  })

  it('um desenho que falha mantém o aviso que estava', async () => {
    const f = fakeSurface([card('A'), new Error('timeout')])
    const onChange = vi.fn()
    const h = createHeadsUp({ surface: f.surface, onChange })
    await h.start()
    h.invalidate(); await flush(); await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.current())).toContain('"A"')
  })

  it('stop solta a superfície, apaga o aviso e ignora o que vier depois', async () => {
    const f = fakeSurface([card('A')])
    const onChange = vi.fn()
    const h = createHeadsUp({ surface: f.surface, onChange })
    await h.start()
    await h.stop()
    expect(f.calls.map(([k]) => k)).toEqual(['attach', 'render', 'detach'])
    expect(onChange.mock.calls.map(([t]) => (t ? 'cartão' : null))).toEqual(['cartão', null])
    h.invalidate(); await flush()
    expect(f.calls.filter(([k]) => k === 'render')).toHaveLength(1)
  })
})

const FAKE = join(fileURLToPath(new URL('.', import.meta.url)), 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('avisos de ponta a ponta no servidor (CLI falso)', () => {
  let db: Db
  let projects: ProjectsService
  let project: Project
  let broadcasts: any[]
  beforeEach(() => {
    db = openDb(':memory:')
    projects = createProjectsService(db)
    project = projects.create({ name: 'P', path: mkdtempSync(join(tmpdir(), 'hu-')) })
    broadcasts = []
  })
  const makeManager = () => createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
  const avisos = () => broadcasts.filter((b) => b.type === 'heads_up')

  it('terminal novo nasce com os avisos ligados', () => {
    expect(project.headsUp).toBe(true)
  })

  it('o aviso do plugin chega às telas, e os botões dele funcionam', async () => {
    const mgr = makeManager()
    const { localId } = mgr.start(project)
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'faz-aviso')
    await waitUntil(() => avisos().length === 1)
    expect(avisos()[0]).toMatchObject({ type: 'heads_up', localId, projectId: project.id })
    expect(JSON.stringify(avisos()[0].tree)).toContain('O lucro de 27% esconde um risco de perda grande')
    expect(JSON.stringify(mgr.get(localId)?.headsUp)).toContain('O lucro de 27%')

    await mgr.pressHeadsUp(localId, { plugin: 'cc-plugin-you-should-know', handle: 2, key: 'b2' })
    await waitUntil(() => avisos().length === 2)
    expect(JSON.stringify(avisos()[1].tree)).toContain('Explicação curta')

    await mgr.pressHeadsUp(localId, { plugin: 'cc-plugin-you-should-know', handle: 1, key: 'b1' })
    await waitUntil(() => avisos().length === 3)
    expect(avisos()[2].tree).toBeNull()
    expect(mgr.get(localId)?.headsUp ?? null).toBeNull()
    await mgr.stop(localId)
  })

  it('terminal com os avisos desligados não se anexa e não recebe aviso', async () => {
    const off = projects.setHeadsUp(project.id, false)!
    const mgr = makeManager()
    const { localId } = mgr.start(off)
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'faz-aviso')
    await waitUntil(() => broadcasts.some((b) => b.type === 'session_event' && b.event?.kind === 'result'))
    await new Promise((r) => setTimeout(r, 200))
    expect(avisos()).toEqual([])
    await mgr.stop(localId)
  })

  it('desligar com o terminal rodando tira o aviso na hora; religar volta a anexar', async () => {
    const mgr = makeManager()
    const { localId } = mgr.start(project)
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    mgr.send(localId, 'faz-aviso')
    await waitUntil(() => avisos().length === 1)
    await mgr.setHeadsUp(project.id, false)
    await waitUntil(() => avisos().length === 2)
    expect(avisos()[1].tree).toBeNull()
    await mgr.setHeadsUp(project.id, true)
    await waitUntil(() => avisos().length === 3) // o plugin (falso) ainda tem o cartão: volta
    expect(JSON.stringify(avisos()[2].tree)).toContain('O lucro de 27%')
    await mgr.stop(localId)
  })
})
