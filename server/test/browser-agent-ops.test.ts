import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { createTerminalTab } from '../src/browser/terminal-tab.js'
import { OperatorInControlError } from '../src/browser/baton.js'
import { TEXTS, type TabCloseReason } from '../src/browser/types.js'
import {
  agentOps, maskPasswords, statusLine, PAGE_BUSY,
  BadArgsError, DialogPendingError, StaleRefError, TabGoneError,
} from '../src/browser/agent-ops.js'
import { FakeContext } from './browser-fakes.js'

const KEY = { projectId: 1, engine: 'claude' }

// A snapshot do dublê, no formato do `ariaSnapshot({ mode: 'ai' })` do Chromium 1255.
const SNAP = [
  '- generic [ref=e1]:',
  '  - textbox "Senha" [active] [ref=e3]: hunter2',
  '  - textbox [ref=e4]',
  '  - button "Enviar" [ref=e6] [cursor=pointer]',
  '  - combobox "Cor" [ref=e7]:',
  '    - option "azul" [selected]',
  '  - textbox "Diz \\"oi\\"" [ref=e8]',
].join('\n')

async function makeOps() {
  const context = new FakeContext({})
  const page = await context.newPage()
  let clock = 1_000
  const now = () => clock
  const tab = createTerminalTab({
    key: KEY,
    context: context as unknown as BrowserContext,
    page: page as unknown as Page,
    now,
    viewport: { width: 1280, height: 800 },
  })
  page.snapshotText = SNAP
  const closeReasons: string[] = []
  const closeTab = vi.fn(async (reason: TabCloseReason) => { closeReasons.push(reason); await tab.close(reason) })
  const ops = agentOps(tab, { closeTab, now })
  return { context, page, tab, ops, closeTab, closeReasons, tick: (ms = 1) => { clock += ms; return clock } }
}

/** Deixa as promessas encadeadas nos ouvintes terminarem. */
const flush = () => new Promise((r) => setTimeout(r, 0))

function fakeDialog(type: string, message: string) {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => '',
    accept: vi.fn(async (_text?: string) => {}),
    dismiss: vi.fn(async () => {}),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('maskPasswords', () => {
  it('maskPasswords troca cada valor e deixa o resto', () => {
    const snap = '- textbox "Senha": hunter2\n- text: x hunter2 y\n- textbox "PIN": 4321\n- button "Entrar"'
    expect(maskPasswords(snap, ['hunter2', '', '4321'])).toBe('- textbox "Senha": ••••\n- text: x •••• y\n- textbox "PIN": ••••\n- button "Entrar"')
    expect(maskPasswords(snap, [])).toBe(snap)
    // O valor mais longo sai antes: um valor contido no outro não deixa sobra.
    expect(maskPasswords('a: abc123', ['abc', 'abc123'])).toBe('a: ••••')
    // Caractere especial de regex no valor não quebra nada.
    expect(maskPasswords('a: p.s$w(rd', ['p.s$w(rd'])).toBe('a: ••••')
  })

  it('não mascara dentro dos marcadores da snapshot ([ref=e6], [level=1], [cursor=pointer])', () => {
    const snap = [
      '- heading "Título 1" [level=1] [ref=e2]',
      '- textbox "PIN" [ref=e6]: 6',
      '- button "Enviar" [ref=e16] [cursor=pointer]',
      '- text: lote 6 [ref=e6]',
    ].join('\n')
    expect(maskPasswords(snap, ['6'])).toBe([
      '- heading "Título 1" [level=1] [ref=e2]',
      '- textbox "PIN" [ref=e6]: ••••',
      '- button "Enviar" [ref=e16] [cursor=pointer]',
      '- text: lote •••• [ref=e6]',
    ].join('\n'))
    expect(maskPasswords('- heading "Nível 1" [level=1] [ref=e3]', ['1'])).toBe('- heading "Nível ••••" [level=1] [ref=e3]')
    expect(maskPasswords('- button "pointer" [ref=e1] [cursor=pointer]', ['pointer'])).toBe('- button "••••" [ref=e1] [cursor=pointer]')
    // O mesmo texto fora de um marcador de verdade (sem o espaço antes, ou atributo que não existe) sai mascarado.
    expect(maskPasswords('- text: x[ref=e6] [pw=e6]', ['e6'])).toBe('- text: x[ref=••••] [pw=••••]')
  })

  it('valores que se cruzam saem numa máscara só, sem sobra', () => {
    expect(maskPasswords('a: abcd.', ['ab', 'bcd'])).toBe('a: ••••.')
    expect(maskPasswords('a: abcde', ['cde', 'abc'])).toBe('a: ••••')
  })
})

describe('agentOps: snapshot', () => {
  it('snapshot chama ariaSnapshot({ mode: \'ai\', depth }) e mascara os valores de input[type=password]', async () => {
    const { page, ops } = await makeOps()
    page.passwordValues = ['hunter2']
    const out = await ops.snapshot(3)
    expect(page.snapshots).toEqual([expect.objectContaining({ mode: 'ai', depth: 3 })])
    expect(out).toContain('textbox "Senha" [active] [ref=e3]: ••••')
    expect(out).not.toContain('hunter2')
    // A leitura dos valores vai como string (o pkg perde o texto das funções).
    expect(page.evaluated.some((e) => e.includes('input[type=password]'))).toBe(true)
  })

  it('snapshot maior que 60000 caracteres sai cortada com SNAPSHOT_CUT no fim', async () => {
    const { page, ops } = await makeOps()
    page.snapshotText = 'x'.repeat(70_000)
    const out = await ops.snapshot()
    expect(out.endsWith(TEXTS.SNAPSHOT_CUT)).toBe(true)
    expect(out.length).toBe(60_000 + TEXTS.SNAPSHOT_CUT.length)
    // Sem corte, sem aviso.
    page.snapshotText = 'y'.repeat(60_000)
    expect(await ops.snapshot()).toBe('y'.repeat(60_000))
  })

  it('senha dentro de shadow root: a leitura desce pelas shadow roots abertas (expressão em string)', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    const expr = page.evaluated.find((e) => e.includes('input[type=password]'))!
    expect(expr).toContain('shadowRoot')
    // A expressão roda num DOM mínimo com uma shadow root aberta e devolve os dois valores.
    const el = (tag: string, value: string, shadow?: unknown) => ({
      matches: (sel: string) => sel === 'input[type=password]' && tag === 'pw',
      value,
      shadowRoot: shadow ?? null,
    })
    const shadow = { querySelectorAll: () => [el('pw', 'segredoShadow')] }
    const document = { querySelectorAll: () => [el('div', ''), el('host', '', shadow), el('pw', 'hunter2')] }
    expect(new Function('document', `return ${expr}`)(document)).toEqual(['segredoShadow', 'hunter2'])
  })

  it('quadro principal que não responde à leitura das senhas: recusa com PAGE_BUSY (falha fechada), sem snapshot', async () => {
    vi.useFakeTimers()
    const { page, tab, ops } = await makeOps()
    page.passwordValues = ['hunter2']
    page.mainFrame().hang = true
    const p = ops.snapshot().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    const err = await p
    expect((err as Error).message).toBe(PAGE_BUSY)
    expect(page.snapshots).toHaveLength(0)
    expect(tab.agentSnapshot).toBeFalsy()
  })

  it('iframe que não responde à leitura das senhas: a snapshot segue com as do quadro principal', async () => {
    vi.useFakeTimers()
    const { page, ops } = await makeOps()
    page.passwordValues = ['hunter2']
    page.addFrame().hang = true
    page.addFrame().passwordValues = ['4321']
    page.snapshotText = SNAP + '\n  - textbox "PIN" [ref=f1e2]: 4321'
    const p = ops.snapshot()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    const out = await p
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('4321')
    expect(out).toContain('[ref=f1e2]: ••••')
  })

  it('página travada: snapshot responde com o aviso, sem chamar o Playwright', async () => {
    const { page, ops } = await makeOps()
    page.emit('crash')
    await expect(ops.snapshot()).rejects.toThrow('page crashed; use browser_navigate action=reload')
    expect(page.snapshots).toHaveLength(0)
  })
})

describe('agentOps: act', () => {
  it("act com ref vira o seletor 'aria-ref=e6'", async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    expect(await ops.act({ action: 'click', ref: 'e6' })).toBe("clicked 'Enviar'")
    expect(page.calls).toContainEqual(expect.objectContaining({ target: 'aria-ref=e6', method: 'click' }))
  })

  it('cada ação devolve a descrição verbatim', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    expect(await ops.act({ action: 'type', ref: 'e3', text: 'abc' })).toBe("typed into 'Senha'")
    expect(await ops.act({ action: 'fill', ref: 'e8', text: 'x' })).toBe('filled \'Diz "oi"\'')
    expect(await ops.act({ action: 'press', key: 'Enter' })).toBe('pressed Enter')
    expect(await ops.act({ action: 'press', ref: 'e3', key: 'Tab' })).toBe('pressed Tab')
    expect(await ops.act({ action: 'hover', ref: 'e6' })).toBe("hovered 'Enviar'")
    expect(await ops.act({ action: 'select', ref: 'e7', text: 'azul' })).toBe("selected 'azul' in 'Cor'")
    // Sem nome acessível, vale o papel.
    expect(await ops.act({ action: 'click', ref: 'e4' })).toBe("clicked 'textbox'")
    expect(page.calls.map((c) => `${c.target} ${c.method}`)).toEqual([
      'aria-ref=e3 pressSequentially',
      'aria-ref=e8 fill',
      'keyboard press',
      'aria-ref=e3 press',
      'aria-ref=e6 hover',
      'aria-ref=e7 selectOption',
      'aria-ref=e4 click',
    ])
  })

  it('argumento faltando → BadArgsError, sem tocar na página', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    await expect(ops.act({ action: 'click' })).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.act({ action: 'fill', ref: 'e3' })).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.act({ action: 'press' })).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.act({ action: 'dialog' })).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.act({ action: 'nada' as never })).rejects.toBeInstanceOf(BadArgsError)
    expect(page.calls).toHaveLength(0)
  })

  it('act com ref depois de operatorAct (epoch mudou desde a última snapshot) → StaleRefError', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    tab.baton.operatorAct({ userId: 1, name: 'Ana' })
    tab.baton.release()
    const err = await ops.act({ action: 'click', ref: 'e6' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StaleRefError)
    expect((err as StaleRefError).code).toBe('stale_ref')
    expect((err as Error).message).toBe(TEXTS.STALE_REF)
    expect(page.calls).toHaveLength(0)
    // Uma snapshot nova vale de novo.
    await ops.snapshot()
    expect(await ops.act({ action: 'click', ref: 'e6' })).toBe("clicked 'Enviar'")
  })

  it('act com ref sem snapshot nenhuma → StaleRefError', async () => {
    const { page, ops } = await makeOps()
    await expect(ops.act({ action: 'click', ref: 'e6' })).rejects.toBeInstanceOf(StaleRefError)
    expect(page.calls).toHaveLength(0)
  })

  it('a ref que sumiu da página (navegou depois da snapshot) → StaleRefError na hora', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    page.counts.set('aria-ref=e6', 0)
    await expect(ops.act({ action: 'click', ref: 'e6' })).rejects.toBeInstanceOf(StaleRefError)
    expect(page.calls).toHaveLength(0)
  })

  it('a ref de um quadro que já não existe (count rejeita "Invalid frame in aria-ref") → StaleRefError', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    page.locator = ((sel: string) => ({ count: () => Promise.reject(new Error(`locator.count: Invalid frame in aria-ref selector "${sel}"`)) })) as never
    await expect(ops.act({ action: 'click', ref: 'e6' })).rejects.toBeInstanceOf(StaleRefError)
  })

  it('act scroll usa mouse.wheel(dx, dy) e não exige ref', async () => {
    const { page, ops } = await makeOps()
    expect(await ops.act({ action: 'scroll', dx: 0, dy: 300 })).toBe('scrolled 0,300')
    expect(page.calls).toEqual([{ target: 'mouse', method: 'wheel', args: [0, 300] }])
    expect(await ops.act({ action: 'scroll', dy: -50 })).toBe('scrolled 0,-50')
  })

  it("lastAction recebe \"clicked 'Enviar'\" e point", async () => {
    const { page, tab, ops, tick } = await makeOps()
    await ops.snapshot()
    page.boxes.set('aria-ref=e6', { x: 10, y: 20, width: 100, height: 40 })
    const onState = vi.fn()
    tab.onState(onState)
    const at = tick(500)
    await ops.act({ action: 'click', ref: 'e6' })
    expect(tab.state().lastAction).toEqual({ text: "clicked 'Enviar'", at, point: { x: 60, y: 40 } })
    expect(onState).toHaveBeenCalled()
    // Ação sem ponto: o ponto antigo não fica.
    await ops.act({ action: 'scroll', dy: 10 })
    expect(tab.state().lastAction).toEqual({ text: 'scrolled 0,10', at })
  })
})

describe('agentOps: prazo geral (página ocupada)', () => {
  it('ação pendurada (Playwright sem resposta): rejeita com PAGE_BUSY em 35 s e solta o bastão', async () => {
    vi.useFakeTimers()
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    page.actHang = true
    let err: unknown
    const p = ops.act({ action: 'click', ref: 'e6' }).catch((e: unknown) => { err = e })
    await vi.advanceTimersByTimeAsync(34_999)
    expect(err).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect((err as Error).message).toBe(PAGE_BUSY)
    expect(tab.baton.state()).toEqual({ kind: 'free' })
  })

  it('count() da ref sem resposta: PAGE_BUSY; quando ele volta, a ação abandonada não clica', async () => {
    vi.useFakeTimers()
    const { page, ops } = await makeOps()
    await ops.snapshot()
    let answer!: (n: number) => void
    const real = page.locator.bind(page)
    page.locator = ((sel: string) => Object.assign(real(sel), { count: () => new Promise<number>((r) => { answer = r }) })) as never
    const p = ops.act({ action: 'click', ref: 'e6' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(((await p) as Error).message).toBe(PAGE_BUSY)
    answer(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(page.calls).toHaveLength(0)
  })

  it('wait seconds 30 (o teto) termina antes do prazo geral', async () => {
    vi.useFakeTimers()
    const { ops } = await makeOps()
    const p = ops.wait({ seconds: 30 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await p).toBe('waited 30 s')
  })
})

describe('agentOps: bastão', () => {
  it('navigate, act, open com url e close com o operador no comando → OperatorInControlError; snapshot, screenshot, console e wait seguem', async () => {
    const { page, tab, ops, closeTab } = await makeOps()
    await ops.snapshot()
    tab.baton.operatorAct({ userId: 1, name: 'Ana' })
    await expect(ops.navigate({ url: 'http://127.0.0.1:5173/' })).rejects.toBeInstanceOf(OperatorInControlError)
    await expect(ops.navigate({ action: 'reload' })).rejects.toBeInstanceOf(OperatorInControlError)
    await expect(ops.act({ action: 'click', ref: 'e6' })).rejects.toBeInstanceOf(OperatorInControlError)
    await expect(ops.act({ action: 'scroll', dy: 10 })).rejects.toBeInstanceOf(OperatorInControlError)
    await expect(ops.open('http://127.0.0.1:5173/')).rejects.toBeInstanceOf(OperatorInControlError)
    await expect(ops.close()).rejects.toBeInstanceOf(OperatorInControlError)
    expect(closeTab).not.toHaveBeenCalled()
    expect(page.navigations.filter((n) => n.kind === 'goto')).toHaveLength(0)
    expect(page.calls).toHaveLength(0)

    expect(await ops.snapshot()).toContain('[ref=e6]')
    expect(await ops.screenshot()).toBeInstanceOf(Buffer)
    expect(ops.console()).toEqual([])
    await expect(ops.wait({ seconds: 0 })).resolves.toBeTypeOf('string')
    // open sem url é leitura.
    await expect(ops.open()).resolves.toBeTypeOf('string')
    // O bastão continua do operador.
    expect(tab.baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
  })

  it('a ação do agente segura o bastão só enquanto dura', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    page.actHang = true
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    expect(tab.baton.state()).toEqual({ kind: 'agent' })
    page.releaseActs()
    await p
    expect(tab.baton.state()).toEqual({ kind: 'free' })
    // Recusa por argumento não deixa o bastão preso.
    await ops.act({ action: 'click' }).catch(() => {})
    expect(tab.baton.state()).toEqual({ kind: 'free' })
  })
})

describe('agentOps: diálogo pendente', () => {
  it('com diálogo pendente: act click → DialogPendingError na hora (sem chamar o Playwright); act dialog accept=true responde; snapshot funciona', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    const d = fakeDialog('confirm', 'certeza?')
    page.emit('dialog', d)
    // Mesmo com a página pendurada, a recusa é imediata.
    page.actHang = true
    const err = await ops.act({ action: 'click', ref: 'e6' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DialogPendingError)
    expect((err as DialogPendingError).code).toBe('dialog_pending')
    expect((err as Error).message).toBe(TEXTS.DIALOG_PENDING)
    await expect(ops.navigate({ url: 'http://127.0.0.1/' })).rejects.toBeInstanceOf(DialogPendingError)
    await expect(ops.open('http://127.0.0.1/')).rejects.toBeInstanceOf(DialogPendingError)
    await expect(ops.wait({ text: 'oi' })).rejects.toBeInstanceOf(DialogPendingError)
    // O Chromium não captura a tela com o diálogo aberto (o ensaio pendura): recusa na hora.
    await expect(ops.screenshot()).rejects.toBeInstanceOf(DialogPendingError)
    expect(page.calls).toHaveLength(0)
    expect(page.screenshots).toHaveLength(0)
    expect(tab.baton.state()).toEqual({ kind: 'free' })

    // A leitura segue: a snapshot descreve o diálogo sem tocar na página (que está bloqueada).
    const snap = await ops.snapshot()
    expect(snap).toContain('confirm "certeza?"')
    expect(snap).toContain('browser_act action=dialog')
    expect(page.snapshots).toHaveLength(1)
    expect(ops.console()).toEqual([])
    await expect(ops.open()).resolves.toBeTypeOf('string')

    expect(await ops.act({ action: 'dialog', accept: true })).toBe('answered dialog: accept')
    expect(d.accept).toHaveBeenCalled()
    expect(tab.state().dialog).toBeNull()
    expect(tab.state().lastAction?.text).toBe('answered dialog: accept')
  })

  it('act dialog sem diálogo pendente → erro legível', async () => {
    const { ops } = await makeOps()
    await expect(ops.act({ action: 'dialog', accept: false })).rejects.toThrow('no dialog is pending')
  })

  it('act dialog accept=false recusa', async () => {
    const { page, ops } = await makeOps()
    const d = fakeDialog('prompt', 'nome?')
    page.emit('dialog', d)
    expect(await ops.act({ action: 'dialog', accept: false })).toBe('answered dialog: dismiss')
    expect(d.dismiss).toHaveBeenCalled()
  })

  it('o clique que abre um diálogo volta na hora com a descrição, sem esperar o Playwright', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    page.actHang = true
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    page.emit('dialog', fakeDialog('confirm', 'certeza?'))
    expect(await p).toBe("clicked 'Enviar'")
    expect(tab.baton.state()).toEqual({ kind: 'free' })
    expect(statusLine(tab)).toContain('Notice: dialog pending: confirm "certeza?"')
    // A resposta solta o clique do Playwright, que não regrava a última ação.
    await ops.act({ action: 'dialog', accept: true })
    page.releaseActs()
    await flush()
    expect(tab.state().lastAction?.text).toBe('answered dialog: accept')
  })

  it('diálogo enquanto a ref é resolvida: DIALOG_PENDING, e a ação abandonada não clica depois da resposta', async () => {
    const { page, ops } = await makeOps()
    await ops.snapshot()
    let answer!: (n: number) => void
    const real = page.locator.bind(page)
    page.locator = ((sel: string) => Object.assign(real(sel), { count: () => new Promise<number>((r) => { answer = r }) })) as never
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    page.emit('dialog', fakeDialog('confirm', 'de outro script'))
    await expect(p).rejects.toBeInstanceOf(DialogPendingError)
    await ops.act({ action: 'dialog', accept: true })
    answer(1)
    await flush()
    expect(page.calls).toHaveLength(0)
  })

  it('diálogo enquanto a caixa é medida: DIALOG_PENDING (não "clicked"), e o clique não sai depois', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    let box!: (b: null) => void
    const real = page.locator.bind(page)
    page.locator = ((sel: string) => Object.assign(real(sel), { boundingBox: () => new Promise<null>((r) => { box = r }) })) as never
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    page.emit('dialog', fakeDialog('confirm', 'de outro script'))
    await expect(p).rejects.toBeInstanceOf(DialogPendingError)
    await ops.act({ action: 'dialog', accept: true })
    box(null)
    await flush()
    expect(page.calls).toHaveLength(0)
    expect(tab.state().lastAction?.text).toBe('answered dialog: accept')
  })

  it('wait com argumento faltando, duplo ou vazio → BadArgsError', async () => {
    const { ops } = await makeOps()
    await expect(ops.wait({} as never)).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.wait({ text: 'a', seconds: 1 } as never)).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.wait({ text: '' })).rejects.toBeInstanceOf(BadArgsError)
    await expect(ops.wait({ seconds: Number.NaN })).rejects.toBeInstanceOf(BadArgsError)
  })
})

describe('agentOps: wait, screenshot, console, navigate, open e close', () => {
  it('wait seconds 45 espera 30 s (teto)', async () => {
    vi.useFakeTimers()
    const { ops } = await makeOps()
    let done = false
    const p = ops.wait({ seconds: 45 }).then((t) => { done = true; return t })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(await p).toBe('waited 30 s')
  })

  it('wait text usa getByText(text).first().waitFor({ state: \'visible\', timeout })', async () => {
    const { page, ops } = await makeOps()
    expect(await ops.wait({ text: 'Pronto' })).toBe("text 'Pronto' appeared")
    expect(page.calls).toContainEqual({ target: 'text=Pronto >> nth=0', method: 'waitFor', args: [{ state: 'visible', timeout: 30_000 }] })
    expect(await ops.wait({ textGone: 'Carregando' })).toBe("text 'Carregando' is gone")
    expect(page.calls).toContainEqual({ target: 'text=Carregando >> nth=0', method: 'waitFor', args: [{ state: 'hidden', timeout: 30_000 }] })
    expect(await ops.wait({ url: 'http://127.0.0.1/ok' })).toBe("url matched 'http://127.0.0.1/ok'")
    expect(page.calls).toContainEqual({ target: 'page', method: 'waitForURL', args: ['http://127.0.0.1/ok', { timeout: 30_000 }] })
  })

  it('wait que estoura o prazo volta com erro legível', async () => {
    const { page, ops } = await makeOps()
    const stuck = { waitFor: () => Promise.reject(Object.assign(new Error('Timeout 30000ms exceeded.\nCall log: …'), { name: 'TimeoutError' })) }
    page.getByText = (() => ({ first: () => stuck })) as never
    await expect(ops.wait({ text: 'Nunca' })).rejects.toThrow("timed out after 30 s waiting for text 'Nunca'")
  })

  it('screenshot devolve o PNG (fullPage repassado)', async () => {
    const { page, ops } = await makeOps()
    const buf = await ops.screenshot(true)
    expect(buf).toBeInstanceOf(Buffer)
    expect(page.screenshots.at(-1)).toMatchObject({ type: 'png', fullPage: true })
  })

  it('console devolve as últimas 50 mensagens, com os erros da página', async () => {
    const { page, ops } = await makeOps()
    for (let i = 0; i < 60; i++) page.emit('console', { type: () => 'log', text: () => `m${i}` })
    page.emit('pageerror', new Error('boom'))
    const out = ops.console()
    expect(out).toHaveLength(50)
    expect(out[0]).toEqual({ type: 'log', text: 'm11' })
    expect(out.at(-1)).toEqual({ type: 'pageerror', text: 'boom' })
  })

  it('navigate com url e com ação de histórico; open com url navega', async () => {
    const { page, ops } = await makeOps()
    expect(await ops.navigate({ url: 'localhost:5173' })).toBe('navigated to http://localhost:5173/')
    expect(await ops.navigate({ action: 'reload' })).toBe('reloaded http://localhost:5173/')
    expect(page.navigations.at(-1)).toMatchObject({ kind: 'reload' })
    expect(await ops.open('http://127.0.0.1:3000/')).toBe('opened http://127.0.0.1:3000/')
    expect(await ops.open()).toBe('browser open at http://127.0.0.1:3000/')
    await expect(ops.navigate({ url: 'file:///etc/passwd' })).rejects.toThrow(TEXTS.SCHEME_REFUSED)
  })

  it("close fecha a aba pelo closeTab com o motivo 'closed_by_agent'", async () => {
    const { tab, ops, closeTab, closeReasons } = await makeOps()
    const reasons: string[] = []
    tab.onClosed((r) => reasons.push(r))
    await ops.close()
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeReasons).toEqual(['closed_by_agent'])
    expect(reasons).toEqual(['closed_by_agent'])
  })

  it('cada operação toca lastAgentAt', async () => {
    const { tab, ops, tick } = await makeOps()
    const ran: Array<[string, () => Promise<unknown> | unknown]> = [
      ['open', () => ops.open()],
      ['snapshot', () => ops.snapshot()],
      ['act', () => ops.act({ action: 'click', ref: 'e6' })],
      ['navigate', () => ops.navigate({ url: 'http://127.0.0.1/' })],
      ['wait', () => ops.wait({ seconds: 0 })],
      ['screenshot', () => ops.screenshot()],
      ['console', () => ops.console()],
      ['close', () => ops.close()],
    ]
    for (const [name, run] of ran) {
      const t = tick(1_000)
      await run()
      expect(tab.lastAgentAt, name).toBe(t)
    }
  })
})

describe('agentOps: aba que some', () => {
  it("aba fechada (onClosed 'idle') durante um act em curso → rejeita TabGoneError", async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    page.actHang = true
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    await tab.close('idle')
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TabGoneError)
    expect((err as TabGoneError).code).toBe('tab_gone')
    expect((err as Error).message).toBe('the browser tab closed (idle); call browser_open again')
  })

  it('aba já fechada: toda operação rejeita TabGoneError na hora', async () => {
    const { tab, ops } = await makeOps()
    await tab.close('browser_closed')
    await expect(ops.snapshot()).rejects.toBeInstanceOf(TabGoneError)
    await expect(ops.screenshot()).rejects.toBeInstanceOf(TabGoneError)
    await expect(ops.wait({ seconds: 5 })).rejects.toThrow('the browser tab closed (browser_closed); call browser_open again')
    await expect(ops.open()).rejects.toBeInstanceOf(TabGoneError)
    expect(() => ops.console()).toThrow(TabGoneError)
    expect(tab.closedReason()).toBe('browser_closed')
  })

  it('wait pendurado e a aba some: rejeita TabGoneError sem esperar o prazo', async () => {
    const { page, tab, ops } = await makeOps()
    page.actHang = true
    const p = ops.wait({ text: 'Nunca' })
    await flush()
    await tab.close('evicted')
    await expect(p).rejects.toThrow('the browser tab closed (evicted); call browser_open again')
  })
})

describe('statusLine', () => {
  it('statusLine inclui os avisos uma vez só', async () => {
    const { tab, ops } = await makeOps()
    await ops.navigate({ url: 'http://127.0.0.1:5173/' })
    tab.pushNotice('download blocked: a.pdf, from http://x/a.pdf', true)
    tab.pushNotice('só para a coluna', false)
    const first = statusLine(tab)
    expect(first.split('\n')).toEqual([
      'Browser: http://127.0.0.1:5173/ |  | control: free',
      'Notice: download blocked: a.pdf, from http://x/a.pdf',
    ])
    expect(statusLine(tab)).toBe('Browser: http://127.0.0.1:5173/ |  | control: free')
  })

  it('o comando aparece como free, agent ou operator (<nome>)', async () => {
    const { page, tab, ops } = await makeOps()
    await ops.snapshot()
    page.actHang = true
    const p = ops.act({ action: 'click', ref: 'e6' })
    await flush()
    expect(statusLine(tab)).toContain('| control: agent')
    page.releaseActs()
    await p
    tab.baton.operatorAct({ userId: 2, name: 'Bia' })
    expect(statusLine(tab).split('\n')[0]).toMatch(/\| control: operator \(Bia\)$/)
  })
})
