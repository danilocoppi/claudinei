import { describe, it, expect } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { applyInput, createMoveLimiter, parseClientMessage } from '../src/browser/input.js'
import { createTerminalTab, type Actor } from '../src/browser/terminal-tab.js'
import { TEXTS } from '../src/browser/types.js'
import type { BrowserClientMsg } from '../../shared/browser.js'
import { FakeContext, type FakePage } from './browser-fakes.js'

const KEY = { projectId: 1, engine: 'claude' }
const ANA: Actor = { kind: 'operator', userId: 7, name: 'ana' }
const always = { canMove: () => true }

async function makeTab() {
  const context = new FakeContext({})
  const page = await context.newPage()
  const tab = createTerminalTab({
    key: KEY,
    context: context as unknown as BrowserContext,
    page: page as unknown as Page,
    now: () => 1_000,
    viewport: { width: 1280, height: 800 },
  })
  return { context, page, tab }
}

const mouseCalls = (p: FakePage) => p.calls.filter((c) => c.target === 'mouse')
const msg = (m: BrowserClientMsg) => m

describe('parseClientMessage', () => {
  it('parseClientMessage recusa tipo desconhecido, números não finitos, key não string e text > 10000 caracteres', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'explodir' }))).toBeNull()
    expect(parseClientMessage('não é json')).toBeNull()
    expect(parseClientMessage('null')).toBeNull()
    expect(parseClientMessage('42')).toBeNull()
    // JSON não tem Infinity: chega como número enorme (1e999 vira Infinity no parse) ou string.
    expect(parseClientMessage('{"type":"pointer","phase":"down","x":1e999,"y":1,"button":"left"}')).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'pointer', phase: 'down', x: '10', y: 1, button: 'left' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'pointer', phase: 'pular', x: 1, y: 1, button: 'left' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'pointer', phase: 'down', x: 1, y: 1, button: 'quarto' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'wheel', x: 1, y: 1, dx: null, dy: 1 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'resize', width: 0, height: 600 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'key', phase: 'down', key: 65, code: 'KeyA', alt: false, ctrl: false, meta: false, shift: false }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'key', phase: 'down', key: 'a', code: 'KeyA', alt: 'sim', ctrl: false, meta: false, shift: false }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'text', text: 'x'.repeat(10_001) }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'text', text: 5 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'navigate', url: 1 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'history', action: 'pular' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'dialog', accept: 'sim' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'freeze', on: 1 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'visible' }))).toBeNull()
  })

  it('aceita as mensagens válidas e devolve só os campos conhecidos', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'text', text: 'x'.repeat(10_000) }))).toEqual({ type: 'text', text: 'x'.repeat(10_000) })
    expect(parseClientMessage(JSON.stringify({ type: 'pointer', phase: 'down', x: 10.5, y: 20, button: 'left', clickCount: 2, extra: 1 })))
      .toEqual({ type: 'pointer', phase: 'down', x: 10.5, y: 20, button: 'left', clickCount: 2 })
    expect(parseClientMessage(JSON.stringify({ type: 'key', phase: 'up', key: 'Enter', code: 'Enter', alt: false, ctrl: true, meta: false, shift: false })))
      .toEqual({ type: 'key', phase: 'up', key: 'Enter', code: 'Enter', alt: false, ctrl: true, meta: false, shift: false })
    expect(parseClientMessage(JSON.stringify({ type: 'take' }))).toEqual({ type: 'take' })
    expect(parseClientMessage(JSON.stringify({ type: 'dialog', accept: true, text: 'oi' }))).toEqual({ type: 'dialog', accept: true, text: 'oi' })
    expect(parseClientMessage(JSON.stringify({ type: 'resize', width: 800, height: 600 }))).toEqual({ type: 'resize', width: 800, height: 600 })
    expect(parseClientMessage(JSON.stringify({ type: 'visible', visible: true }))).toEqual({ type: 'visible', visible: true })
  })
})

describe('applyInput', () => {
  it('pointer down toma o bastão e chama mouse.down com button e clickCount', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'pointer', phase: 'down', x: 10, y: 20, button: 'right', clickCount: 2 }), ANA, always)
    expect(tab.baton.state()).toEqual({ kind: 'operator', userId: 7, name: 'ana' })
    expect(mouseCalls(page)).toEqual([
      { target: 'mouse', method: 'move', args: [10, 20] },
      { target: 'mouse', method: 'down', args: [{ button: 'right', clickCount: 2 }] },
    ])
    await applyInput(tab, msg({ type: 'pointer', phase: 'up', x: 10, y: 20, button: 'right', clickCount: 2 }), ANA, always)
    expect(mouseCalls(page).at(-1)).toEqual({ target: 'mouse', method: 'up', args: [{ button: 'right', clickCount: 2 }] })
  })

  it('pointer move sem bastão do operador é ignorado', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'pointer', phase: 'move', x: 5, y: 5, button: 'left' }), ANA, always)
    expect(mouseCalls(page)).toEqual([])
    // Mover não toma o bastão.
    expect(tab.baton.state().kind).toBe('free')
    // Com o agente agindo, também não passa.
    tab.baton.beginAgent()
    await applyInput(tab, msg({ type: 'pointer', phase: 'move', x: 5, y: 5, button: 'left' }), ANA, always)
    expect(mouseCalls(page)).toEqual([])
    tab.baton.endAgent()
    // Com o bastão de outro operador, passa.
    tab.baton.operatorAct({ userId: 9, name: 'bia' })
    await applyInput(tab, msg({ type: 'pointer', phase: 'move', x: 6, y: 7, button: 'left' }), ANA, always)
    expect(mouseCalls(page)).toEqual([{ target: 'mouse', method: 'move', args: [6, 7] }])
    expect(tab.baton.state()).toMatchObject({ kind: 'operator', userId: 9 })
  })

  it('move com bastão passa no máximo 20 por segundo', async () => {
    const { page, tab } = await makeTab()
    let t = 0
    const limiter = createMoveLimiter(() => t)
    tab.baton.operatorAct({ userId: 7, name: 'ana' })
    const move = () => applyInput(tab, msg({ type: 'pointer', phase: 'move', x: 1, y: 1, button: 'left' }), ANA, { canMove: limiter })
    // 100 movimentos em 1 s (um a cada 10 ms): 20 passam.
    for (let i = 0; i < 100; i++) { t = i * 10; await move() }
    expect(mouseCalls(page)).toHaveLength(20)
    // Rajada de 30 no mesmo instante, mais de 1 s depois: 20 passam.
    t = 5_000
    for (let i = 0; i < 30; i++) await move()
    expect(mouseCalls(page)).toHaveLength(40)
    // Movimento sem bastão não gasta a cota.
    tab.baton.release()
    t = 10_000
    for (let i = 0; i < 30; i++) await move()
    tab.baton.operatorAct({ userId: 7, name: 'ana' })
    for (let i = 0; i < 20; i++) await move()
    expect(mouseCalls(page)).toHaveLength(60)
  })

  it("key down 'Unidentified' é ignorada", async () => {
    const { page, tab } = await makeTab()
    for (const key of ['Unidentified', 'Dead', 'Process']) {
      await expect(applyInput(tab, msg({ type: 'key', phase: 'down', key, code: '', alt: false, ctrl: false, meta: false, shift: false }), ANA, always)).resolves.toBeUndefined()
    }
    expect(page.calls).toEqual([])
    expect(tab.baton.state().kind).toBe('free')
    await applyInput(tab, msg({ type: 'key', phase: 'down', key: 'Enter', code: 'Enter', alt: false, ctrl: false, meta: false, shift: false }), ANA, always)
    await applyInput(tab, msg({ type: 'key', phase: 'up', key: 'Enter', code: 'Enter', alt: false, ctrl: false, meta: false, shift: false }), ANA, always)
    expect(page.calls).toEqual([
      { target: 'keyboard', method: 'down', args: ['Enter'] },
      { target: 'keyboard', method: 'up', args: ['Enter'] },
    ])
    expect(tab.baton.state().kind).toBe('operator')
  })

  it('text chama insertText', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'text', text: 'olá, mundo' }), ANA, always)
    expect(page.calls).toEqual([{ target: 'keyboard', method: 'insertText', args: ['olá, mundo'] }])
    expect(tab.baton.state()).toMatchObject({ kind: 'operator', name: 'ana' })
  })

  it('wheel toma o bastão, move e rola', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'wheel', x: 3, y: 4, dx: 0, dy: 120 }), ANA, always)
    expect(mouseCalls(page)).toEqual([
      { target: 'mouse', method: 'move', args: [3, 4] },
      { target: 'mouse', method: 'wheel', args: [0, 120] },
    ])
    expect(tab.baton.state().kind).toBe('operator')
  })

  it('navigate com javascript: não navega e anota o aviso', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'navigate', url: 'javascript:alert(1)' }), ANA, always)
    expect(page.navigations).toEqual([])
    expect(tab.state().notices).toContain(TEXTS.SCHEME_REFUSED)
    // O aviso é da coluna: o operador recusado não vira notícia para o agente.
    expect(tab.takeAgentNotices()).not.toContain(TEXTS.SCHEME_REFUSED)
    await applyInput(tab, msg({ type: 'navigate', url: 'localhost:5173' }), ANA, always)
    expect(page.navigations.map((n) => n.arg)).toEqual(['http://localhost:5173/'])
  })

  it('history toma o bastão e navega; dialog responde o diálogo', async () => {
    const { page, tab } = await makeTab()
    await applyInput(tab, msg({ type: 'history', action: 'reload' }), ANA, always)
    expect(page.navigations.map((n) => n.kind)).toEqual(['reload'])
    expect(tab.baton.state().kind).toBe('operator')
    let accepted: string | undefined
    page.emit('dialog', {
      type: () => 'prompt', message: () => 'nome?', defaultValue: () => '',
      accept: async (t?: string) => { accepted = t }, dismiss: async () => {},
    })
    expect(tab.state().dialog).toMatchObject({ type: 'prompt' })
    await applyInput(tab, msg({ type: 'dialog', accept: true, text: 'Ana' }), ANA, always)
    expect(accepted).toBe('Ana')
    expect(tab.state().dialog).toBeNull()
  })

  it('take toma o bastão; release devolve o bastão', async () => {
    const { tab } = await makeTab()
    await applyInput(tab, msg({ type: 'take' }), ANA, always)
    expect(tab.baton.state()).toEqual({ kind: 'operator', userId: 7, name: 'ana' })
    await applyInput(tab, msg({ type: 'release' }), ANA, always)
    expect(tab.baton.state()).toEqual({ kind: 'free' })
    expect(tab.takeAgentNotices()).toContain('control returned to the agent')
  })
})
