import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BrowserClientMsg, BrowserStateMsg, FrameHeader } from '../../../shared/browser'

/**
 * A vista Navegador: o socket da tela (dublê), o selo do bastão, a barra de
 * endereço, a visibilidade, o resize, os servidores locais, o aviso de senha,
 * o indisponível, o navegador que fechou e o diálogo pendente.
 */

const sock = vi.hoisted(() => {
  type Conn = {
    projectId: number; engine: string; sent: unknown[]; closed: boolean
    h: { onState(s: unknown): void; onFrame(f: unknown): void; onClose(code: number, retrying?: boolean): void }
  }
  return { conns: [] as Conn[] }
})
vi.mock('../browser/browserSocket', () => ({
  connectBrowser: (projectId: number, engine: string, h: (typeof sock.conns)[number]['h']) => {
    const c = { projectId, engine, h, sent: [] as unknown[], closed: false }
    sock.conns.push(c)
    return { send: (m: unknown) => { if (!c.closed) c.sent.push(m) }, close: () => { c.closed = true } }
  },
}))
vi.mock('../components/ProgressColumn', () => ({ ProgressColumn: () => <aside className="progress" /> }))

import { RightColumn } from '../browser/RightColumn'
import { useColumnStore } from '../browser/columnStore'
import { applyBrowserMessage, useBrowserStore } from '../browser/browserStore'
import { useSideStore } from '../branch/sideStore'
import { useStore } from '../store'

const SERVERS = '/api/projects/1/terminals/claude/servers'
const BROWSER = '/api/projects/1/terminals/claude/browser'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let servers: unknown[] = []
let stopReply: () => Response | Promise<Response> = () => json({ ok: true, target: 'pid' })
const api = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
  const u = String(url)
  if (u === SERVERS) return json({ servers })
  if (u.startsWith(`${SERVERS}/`) && u.endsWith('/stop')) return stopReply()
  if (u === BROWSER) return json({ ok: true })
  return json({})
})
let fetchSpy: ReturnType<typeof api>

const estado = (o: Partial<BrowserStateMsg> = {}): BrowserStateMsg => ({
  type: 'state', url: 'http://127.0.0.1:5173/', title: 'App', loading: false, crashed: false,
  baton: { kind: 'free' }, viewport: { width: 1280, height: 800 }, dialog: null, notices: [],
  lastAction: null, sandbox: true, ...o,
})
const conn = () => sock.conns[sock.conns.length - 1]
const sent = (type?: string) => conn().sent.filter((m) => !type || (m as BrowserClientMsg).type === type) as BrowserClientMsg[]
const emitir = (s: BrowserStateMsg) => act(() => { conn().h.onState(s) })
const coluna = () => document.querySelector<HTMLElement>('aside.right-column')

/** O `document.hidden` do jsdom é um getter; aqui vira ajustável. */
let oculto = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => oculto })

beforeEach(() => {
  localStorage.clear()
  sock.conns.length = 0
  servers = []
  stopReply = () => json({ ok: true, target: 'pid' })
  oculto = false
  fetchSpy = api()
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null, readAt: {} })
  useBrowserStore.setState({ tabs: { '1:claude': true }, failed: {} })
  useColumnStore.setState({ view: 'browser', previous: null, fullscreen: false, marks: {}, widths: {} })
  useStore.setState({
    authStatus: 'ready', progressEpoch: 0, progressOpen: true, view: 'chat', activeLocalId: 'a',
    sessions: { a: { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const montar = () => render(<div className="chat-layout"><RightColumn projectId={1} engine="claude" localId="a" /></div>)

describe('vista Navegador', () => {
  it('conecta ao terminal e manda visible:true', () => {
    montar()
    expect(sock.conns).toHaveLength(1)
    expect(conn().projectId).toBe(1)
    expect(conn().engine).toBe('claude')
    expect(sent('visible')).toEqual([{ type: 'visible', visible: true }])
  })

  it('selo nos quatro estados', () => {
    montar()
    emitir(estado({ baton: { kind: 'agent' } }))
    expect(screen.getByTestId('browser-baton').textContent).toBe('Agente no comando')
    emitir(estado({ baton: { kind: 'operator', name: 'ana', you: true } }))
    expect(screen.getByTestId('browser-baton').textContent).toContain('Você no comando')
    expect(screen.getByRole('button', { name: 'Devolver ao agente' })).toBeTruthy()
    emitir(estado({ baton: { kind: 'operator', name: 'bia', you: false } }))
    expect(screen.getByTestId('browser-baton').textContent).toBe('bia no comando')
    expect(screen.queryByRole('button', { name: 'Devolver ao agente' })).toBeNull()
    emitir(estado({ baton: { kind: 'free' } }))
    expect(screen.getByTestId('browser-baton').textContent).toBe('Livre')
  })

  it('Devolver ao agente manda release', () => {
    localStorage.setItem('claudinei:browserPasswordWarned', '1')
    montar()
    emitir(estado({ baton: { kind: 'operator', name: 'ana', you: true } }))
    fireEvent.click(screen.getByRole('button', { name: 'Devolver ao agente' }))
    expect(sent('release')).toEqual([{ type: 'release' }])
  })

  it('Enter na barra manda navigate; a barra mostra a URL da aba', () => {
    montar()
    emitir(estado())
    const barra = screen.getByRole('textbox', { name: 'Endereço' }) as HTMLInputElement
    expect(barra.value).toBe('http://127.0.0.1:5173/')
    fireEvent.change(barra, { target: { value: 'localhost:3000' } })
    fireEvent.keyDown(barra, { key: 'Enter', code: 'Enter' })
    expect(sent('navigate')).toEqual([{ type: 'navigate', url: 'localhost:3000' }])
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Avançar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }))
    expect(sent('history').map((m) => (m as { action: string }).action)).toEqual(['back', 'forward', 'reload'])
  })

  it('visible:false ao trocar de aba da coluna e ao document.hidden', () => {
    montar()
    emitir(estado())
    oculto = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(sent('visible').at(-1)).toEqual({ type: 'visible', visible: false })
    oculto = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(sent('visible').at(-1)).toEqual({ type: 'visible', visible: true })
    const c = conn()
    fireEvent.click(within(coluna()!).getByRole('tab', { name: 'Acompanhamento' }))
    expect(c.sent.at(-1)).toEqual({ type: 'visible', visible: false })
    expect(c.closed).toBe(true)
  })

  it('tela fora da vista (IntersectionObserver) manda visible:false', () => {
    const obs: Array<(e: Array<{ isIntersecting: boolean }>) => void> = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { obs.push(cb) }
      observe() {} unobserve() {} disconnect() {}
    })
    try {
      montar()
      expect(obs.length).toBeGreaterThan(0)
      act(() => { for (const cb of obs) cb([{ isIntersecting: false }]) })
      expect(sent('visible').at(-1)).toEqual({ type: 'visible', visible: false })
      act(() => { for (const cb of obs) cb([{ isIntersecting: true }]) })
      expect(sent('visible').at(-1)).toEqual({ type: 'visible', visible: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resize sai uma vez depois de 250 ms', () => {
    vi.useFakeTimers()
    const obs: Array<(e: Array<{ contentRect: { width: number; height: number } }>) => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (e: Array<{ contentRect: { width: number; height: number } }>) => void) { obs.push(cb) }
      observe() {} unobserve() {} disconnect() {}
    })
    try {
      montar()
      const mede = (width: number, height: number) => act(() => { for (const cb of obs) cb([{ contentRect: { width, height } }]) })
      mede(500, 300)
      act(() => { vi.advanceTimersByTime(100) })
      mede(600.4, 400.6)
      act(() => { vi.advanceTimersByTime(249) })
      expect(sent('resize')).toEqual([])
      act(() => { vi.advanceTimersByTime(1) })
      expect(sent('resize')).toEqual([{ type: 'resize', width: 600, height: 401 }])
      act(() => { vi.advanceTimersByTime(1000) })
      expect(sent('resize')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /** Um `ResizeObserver` dublê que guarda o alvo: o teste mede cada caixa à parte. */
  const observarCaixas = () => {
    type Cb = (e: Array<{ contentRect: { width: number; height: number } }>) => void
    const obs = new Map<Element, Cb>()
    vi.stubGlobal('ResizeObserver', class {
      cb: Cb
      constructor(cb: Cb) { this.cb = cb }
      observe(el: Element) { obs.set(el, this.cb) }
      unobserve() {} disconnect() {}
    })
    const mede = (el: Element, width: number, height: number) => act(() => { obs.get(el)?.([{ contentRect: { width, height } }]) })
    /** As caixas medidas dentro da vista (a tela, e nada mais). */
    const medidas = () => [...obs.keys()].filter((el) => el.closest('.browser-col'))
    return { mede, medidas }
  }
  const palco = () => {
    const st = document.querySelector<HTMLElement>('.browser-screen__stage')!.style
    return { width: st.width, height: st.height }
  }

  it('sem faixa nenhuma: o resize é o tamanho da tela e a escala fica 1', () => {
    vi.useFakeTimers()
    const { mede, medidas } = observarCaixas()
    try {
      montar()
      emitir(estado())
      const tela = document.querySelector('.browser-screen')!
      // Uma caixa só, a tela: a escala e o resize leem o mesmo content-box (sem a borda de cima
      // da tela), e nenhuma conta soma a borda numa e não na outra.
      expect(medidas()).toEqual([tela])
      // Content-box 600×400 (o border-box teria 401 de altura, com a borda de 1 px).
      mede(tela, 600, 400)
      // Antes do viewport mudar, a tela de 1280×800 cabe pela escala.
      expect(palco()).toEqual({ width: '600px', height: '375px' })
      act(() => { vi.advanceTimersByTime(250) })
      expect(sent('resize')).toEqual([{ type: 'resize', width: 600, height: 400 }])
      // O servidor ajusta o viewport ao pedido: o palco tem o tamanho do canvas (escala 1).
      emitir(estado({ viewport: { width: 600, height: 400 } }))
      expect(palco()).toEqual({ width: '600px', height: '400px' })
      const canvas = document.querySelector('canvas')!
      expect([canvas.width, canvas.height]).toEqual([600, 400])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('o aviso de senha aparecer e sumir não manda resize: é uma camada sobre a tela', () => {
    vi.useFakeTimers()
    const { mede, medidas } = observarCaixas()
    try {
      montar()
      emitir(estado({ viewport: { width: 600, height: 400 } }))
      const tela = document.querySelector('.browser-screen')!
      mede(tela, 600, 400)
      act(() => { vi.advanceTimersByTime(250) })
      expect(sent('resize')).toHaveLength(1)
      // A primeira tomada do bastão mostra o aviso, por cima da tela (na vista, fora da área medida).
      emitir(estado({ viewport: { width: 600, height: 400 }, baton: { kind: 'operator', name: 'ana', you: true } }))
      const aviso = screen.getByRole('note')
      expect(aviso.parentElement?.classList.contains('browser-view')).toBe(true)
      expect(tela.contains(aviso)).toBe(false)
      expect(medidas()).toEqual([tela])
      act(() => { vi.advanceTimersByTime(1000) })
      fireEvent.click(screen.getByRole('button', { name: 'Entendi' }))
      act(() => { vi.advanceTimersByTime(1000) })
      expect(sent('resize')).toHaveLength(1)
      expect(palco()).toEqual({ width: '600px', height: '400px' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a camada do aviso de senha fica fora do fluxo (CSS)', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')
    const regra = css.match(/^\.browser-warning \{([^}]*)\}/m)?.[1] ?? ''
    expect(regra).toMatch(/position:\s*absolute/)
    expect(css).toMatch(/^\.browser-view \{[^}]*position:\s*relative/m)
  })

  it('a faixa de servidores aparecer manda um resize com a altura menor, e a escala volta a 1', async () => {
    vi.useFakeTimers()
    const { mede, medidas } = observarCaixas()
    try {
      montar()
      emitir(estado({ viewport: { width: 600, height: 400 } }))
      const tela = document.querySelector('.browser-screen')!
      mede(tela, 600, 400)
      act(() => { vi.advanceTimersByTime(250) })
      expect(sent('resize')).toEqual([{ type: 'resize', width: 600, height: 400 }])
      // Um servidor sobe: a próxima leitura (5 s) mostra a faixa, acima da tela.
      servers = [{ pid: 230, port: 5173, host: '0.0.0.0', label: 'vite', startTime: '5555', marker: 'exact' }]
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      const faixa = screen.getByTestId('server-5173').closest('.browser-servers')!
      expect(faixa.closest('.browser-view')).toBeNull()
      expect(medidas()).toEqual([tela])
      // A tela perde a altura da faixa: até o viewport mudar, o palco cabe pela escala.
      mede(tela, 600, 372)
      expect(palco()).toEqual({ width: '558px', height: '372px' })
      act(() => { vi.advanceTimersByTime(250) })
      expect(sent('resize')).toEqual([
        { type: 'resize', width: 600, height: 400 },
        { type: 'resize', width: 600, height: 372 },
      ])
      emitir(estado({ viewport: { width: 600, height: 372 } }))
      expect(palco()).toEqual({ width: '600px', height: '372px' })
      // A faixa fica: as leituras seguintes não mudam nada.
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(sent('resize')).toHaveLength(2)
      // A última ação e os avisos também ficam acima da tela, fora da área medida.
      emitir(estado({ viewport: { width: 600, height: 372 }, lastAction: { text: 'clicou', at: Date.now() }, notices: ['x'] }))
      expect(screen.getByTestId('browser-last-action').closest('.browser-view')).toBeNull()
      expect(screen.getByRole('list', { name: /avisos/i }).closest('.browser-view')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('servidores: Abrir manda navigate para http://127.0.0.1:5173; Parar com 409 mostra \'o processo já não é o mesmo\'; \'cwd\' sem Parar', async () => {
    servers = [
      { pid: 230, port: 5173, host: '0.0.0.0', label: 'vite', startTime: '5555', marker: 'exact' },
      { pid: 240, port: 3000, host: '127.0.0.1', label: 'node', startTime: '6666', marker: 'cwd' },
    ]
    let solta: (r: Response) => void = () => {}
    stopReply = () => new Promise<Response>((r) => { solta = r })
    montar()
    const vite = await screen.findByTestId('server-5173')
    expect(vite.textContent).toContain(':5173')
    expect(vite.textContent).toContain('vite')
    expect(vite.textContent).toMatch(/:5173 vite\s*—\s*Abrir · Parar/)
    fireEvent.click(within(vite).getByRole('button', { name: 'Abrir' }))
    expect(sent('navigate')).toEqual([{ type: 'navigate', url: 'http://127.0.0.1:5173' }])

    const node = screen.getByTestId('server-3000')
    expect(node.textContent).toContain('sem marcador')
    expect(within(node).queryByRole('button', { name: 'Parar' })).toBeNull()
    expect(within(node).getByRole('button', { name: 'Abrir' })).toBeTruthy()

    fireEvent.click(within(vite).getByRole('button', { name: 'Parar' }))
    // Enquanto o servidor não responde: "parando…", e o botão não repete.
    expect(vite.textContent).toContain('parando…')
    expect(within(vite).queryByRole('button', { name: 'Parar' })).toBeNull()
    const stops = () => fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/stop'))
    expect(stops()).toHaveLength(1)
    expect(String(stops()[0][0])).toBe(`${SERVERS}/230/stop`)
    expect(JSON.parse(String(stops()[0][1]?.body))).toEqual({ startTime: '5555' })
    await act(async () => {
      solta(json({ error: 'o processo já não é o mesmo', code: 'not_same_process', params: {} }, 409))
    })
    await waitFor(() => expect(screen.getByTestId('server-5173').textContent).toContain('o processo já não é o mesmo'))
  })

  it('servidores só são lidos com a vista visível, a cada 5 s', async () => {
    vi.useFakeTimers()
    const lidas = () => fetchSpy.mock.calls.filter(([u]) => String(u) === SERVERS).length
    montar()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(lidas()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(lidas()).toBe(2)
    oculto = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(lidas()).toBe(2)
    oculto = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(lidas()).toBe(3)
  })

  it('aviso de senha aparece na primeira tomada e some com Entendi (lembrado)', () => {
    const { unmount } = montar()
    emitir(estado({ baton: { kind: 'agent' } }))
    expect(screen.queryByText(/inclusive senhas/)).toBeNull()
    emitir(estado({ baton: { kind: 'operator', name: 'ana', you: true } }))
    expect(screen.getByText('O agente deste terminal lê o que você digitar aqui, inclusive senhas. Prefira um login de teste.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }))
    expect(screen.queryByText(/inclusive senhas/)).toBeNull()
    expect(localStorage.getItem('claudinei:browserPasswordWarned')).toBeTruthy()
    unmount()
    montar()
    emitir(estado({ baton: { kind: 'operator', name: 'ana', you: true } }))
    expect(screen.queryByText(/inclusive senhas/)).toBeNull()
  })

  it('indisponível mostra o comando', () => {
    montar()
    const hint = 'npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell'
    emitir(estado({ unavailable: { code: 'browser_not_installed', hint, message: 'Browser not installed' } }))
    const alerta = screen.getByRole('alert')
    expect(alerta.textContent).toContain('Navegador não instalado. No servidor, rode')
    expect(alerta.querySelector('code')?.textContent).toBe(hint)
    // Tentar de novo: o POST de abertura e outra conexão.
    fireEvent.click(within(alerta).getByRole('button', { name: 'Tentar de novo' }))
    return waitFor(() => {
      expect(fetchSpy.mock.calls.some(([u, i]) => String(u) === BROWSER && i?.method === 'POST')).toBe(true)
      expect(sock.conns).toHaveLength(2)
    })
  })

  it('browser_closed mostra Reabrir, mesmo depois do browser_tab fechado', async () => {
    montar()
    emitir(estado({ closed: 'browser_closed' }))
    act(() => { conn().h.onClose(1000, false) })
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: false, by: 'system' }) })
    expect(coluna()?.dataset.view).toBe('browser')
    expect(screen.getByText('O navegador fechou')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir' }))
    await waitFor(() => expect(sock.conns).toHaveLength(2))
    expect(fetchSpy.mock.calls.some(([u, i]) => String(u) === BROWSER && i?.method === 'POST')).toBe(true)
    expect(useBrowserStore.getState().tabs['1:claude']).toBe(true)
    expect(screen.queryByText('O navegador fechou')).toBeNull()
  })

  it('o browser_tab do sistema chegando antes do último state: a vista espera o motivo', () => {
    montar()
    emitir(estado())
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: false, by: 'system' }) })
    expect(coluna()?.dataset.view).toBe('browser')
    // Fechada por ociosidade (ou outro motivo que não a queda do navegador): a vista sai.
    emitir(estado({ closed: 'idle' }))
    expect(coluna()?.dataset.view).toBe('progress')
  })

  it('aba fechada pelo operador ou pelo agente: a vista sai', () => {
    montar()
    emitir(estado())
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: false, by: 'agent' }) })
    expect(coluna()?.dataset.view).toBe('progress')
  })

  it('página travada mostra Recarregar, que manda history reload', () => {
    montar()
    emitir(estado({ crashed: true }))
    expect(screen.getByText('A página travou')).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('browser-crashed')).getByRole('button', { name: 'Recarregar' }))
    expect(sent('history')).toEqual([{ type: 'history', action: 'reload' }])
  })

  it('diálogo confirm: OK manda dialog accept true; prompt manda o texto', () => {
    montar()
    emitir(estado({ dialog: { id: 1, type: 'confirm', message: 'Apagar tudo?' } }))
    expect(screen.getByText('Apagar tudo?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(sent('dialog')).toEqual([{ type: 'dialog', accept: true }])
    emitir(estado({ dialog: { id: 2, type: 'prompt', message: 'Nome?', defaultValue: 'x' } }))
    const campo = screen.getByRole('textbox', { name: 'Nome?' }) as HTMLInputElement
    expect(campo.value).toBe('x')
    fireEvent.change(campo, { target: { value: 'ana' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    emitir(estado({ dialog: { id: 3, type: 'confirm', message: 'De novo?' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(sent('dialog')).toEqual([
      { type: 'dialog', accept: true },
      { type: 'dialog', accept: true, text: 'ana' },
      { type: 'dialog', accept: false },
    ])
  })

  it('diálogo da página com o foco na tela: o foco vai ao OK (ou ao campo do prompt) e volta à tela depois', () => {
    montar()
    emitir(estado())
    act(() => { screen.getByTestId('browser-keys').focus() })
    emitir(estado({ dialog: { id: 1, type: 'confirm', message: 'Apagar?' } }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(document.activeElement).toBe(screen.getByTestId('browser-keys'))
    emitir(estado({ dialog: { id: 2, type: 'prompt', message: 'Nome?' } }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Nome?' }))
  })

  it('diálogo da página com o foco fora da vista: o foco fica onde estava', () => {
    montar()
    emitir(estado())
    const fora = document.createElement('input')
    document.body.append(fora)
    try {
      act(() => { fora.focus() })
      emitir(estado({ dialog: { id: 1, type: 'prompt', message: 'Nome?' } }))
      expect(document.activeElement).toBe(fora)
    } finally {
      fora.remove()
    }
  })

  it('avisos, sem sandbox e a última ação do agente', () => {
    montar()
    emitir(estado({
      sandbox: false,
      notices: ['only http:, https: and about:blank URLs are allowed', 'download blocked: a.zip'],
      lastAction: { text: 'clicou em "Entrar"', at: Date.now(), point: { x: 640, y: 400 } },
    }))
    expect(screen.getByText('sem sandbox')).toBeTruthy()
    expect(screen.getByText('Só endereços http:, https: e about:blank são aceitos.')).toBeTruthy()
    expect(screen.getByText('download blocked: a.zip')).toBeTruthy()
    expect(screen.getByTestId('browser-last-action').textContent).toContain('clicou em "Entrar"')
    const marca = screen.getByTestId('browser-action-mark')
    expect(marca.style.left).toBe('50%')
    expect(marca.style.top).toBe('50%')
  })

  it('fechar a aba chama o DELETE', async () => {
    montar()
    emitir(estado())
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o navegador' }))
    await waitFor(() => expect(fetchSpy.mock.calls.some(([u, i]) => String(u) === BROWSER && i?.method === 'DELETE')).toBe(true))
  })
})

describe('tela', () => {
  const header = (seq: number): FrameHeader => ({ kind: 'frame', seq, width: 1280, height: 800 })
  let decode: ReturnType<typeof vi.fn>
  let ctx: { drawImage: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    decode = vi.fn(async () => ({ close: vi.fn() }))
    vi.stubGlobal('createImageBitmap', decode)
    ctx = { drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('quadro com a vista oculta não é decodificado; ao voltar, o último guardado é desenhado', async () => {
    montar()
    emitir(estado())
    await act(async () => { conn().h.onFrame({ header: header(1), image: new Blob(['a']) }) })
    expect(decode).toHaveBeenCalledTimes(1)
    oculto = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {
      conn().h.onFrame({ header: header(2), image: new Blob(['b']) })
      conn().h.onFrame({ header: header(3), image: new Blob(['c']) })
    })
    expect(decode).toHaveBeenCalledTimes(1)
    oculto = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(decode).toHaveBeenCalledTimes(2)
    expect(new TextDecoder().decode(await (decode.mock.calls[1][0] as Blob).arrayBuffer())).toBe('c')
  })

  it('a marca da ação some no primeiro quadro depois de 1,5 s', async () => {
    montar()
    const at = Date.now()
    emitir(estado({ lastAction: { text: 'clique', at, point: { x: 10, y: 10 } } }))
    const agora = vi.spyOn(Date, 'now').mockReturnValue(at + 1000)
    await act(async () => { conn().h.onFrame({ header: header(1), image: new Blob(['a']) }) })
    expect(screen.queryByTestId('browser-action-mark')).toBeTruthy()
    agora.mockReturnValue(at + 1500)
    await act(async () => { conn().h.onFrame({ header: header(2), image: new Blob(['b']) }) })
    expect(screen.queryByTestId('browser-action-mark')).toBeNull()
  })

  it('clique vira pointer em px do viewport; move só com o bastão, no máximo 20 por segundo', () => {
    vi.useFakeTimers()
    montar()
    emitir(estado())
    const canvas = document.querySelector('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON() {} })
    const ev = (tipo: string, x: number, y: number) => act(() => {
      canvas.dispatchEvent(new MouseEvent(tipo, { clientX: x, clientY: y, button: 0, bubbles: true }))
    })
    ev('pointerdown', 320, 200)
    ev('pointerup', 320, 200)
    expect(sent('pointer')).toEqual([
      { type: 'pointer', phase: 'down', x: 640, y: 400, button: 'left', clickCount: 1 },
      { type: 'pointer', phase: 'up', x: 640, y: 400, button: 'left', clickCount: 1 },
    ])
    expect(document.activeElement).toBe(screen.getByTestId('browser-keys'))
    ev('pointermove', 10, 10)
    expect(sent('pointer')).toHaveLength(2)
    emitir(estado({ baton: { kind: 'operator', name: 'ana', you: true } }))
    for (let i = 0; i < 10; i++) {
      ev('pointermove', 10 + i, 10)
      act(() => { vi.advanceTimersByTime(10) })
    }
    act(() => { vi.advanceTimersByTime(100) })
    const moves = sent('pointer').filter((m) => (m as { phase: string }).phase === 'move')
    // 100 ms de movimento: o primeiro na hora e um a cada 50 ms, o último com a posição final.
    expect(moves.length).toBeGreaterThanOrEqual(2)
    expect(moves.length).toBeLessThanOrEqual(3)
    expect(moves.at(-1)).toMatchObject({ x: 38, y: 20 })
  })

  const clicar = (canvas: HTMLCanvasElement, tipo: string, button = 0) => {
    const e = new MouseEvent(tipo, { clientX: 100, clientY: 100, button, bubbles: true, cancelable: true })
    act(() => { canvas.dispatchEvent(e) })
    return e
  }

  it('cinco cliques rápidos: o clickCount volta a 1 depois do 3 (o servidor recusa acima de 4)', () => {
    montar()
    emitir(estado())
    const canvas = document.querySelector('canvas')!
    for (let i = 0; i < 5; i++) {
      clicar(canvas, 'pointerdown')
      clicar(canvas, 'pointerup')
    }
    const downs = sent('pointer').filter((m) => (m as { phase: string }).phase === 'down')
    expect(downs.map((m) => (m as { clickCount: number }).clickCount)).toEqual([1, 2, 3, 1, 2])
    const ups = sent('pointer').filter((m) => (m as { phase: string }).phase === 'up')
    expect(ups.map((m) => (m as { clickCount: number }).clickCount)).toEqual([1, 2, 3, 1, 2])
  })

  it('os botões laterais do mouse (3 e 4) não viram clique nem voltam o Claudinei', () => {
    montar()
    emitir(estado())
    const canvas = document.querySelector('canvas')!
    for (const b of [3, 4]) {
      expect(clicar(canvas, 'pointerdown', b).defaultPrevented).toBe(true)
      expect(clicar(canvas, 'pointerup', b).defaultPrevented).toBe(true)
      expect(clicar(canvas, 'mouseup', b).defaultPrevented).toBe(true)
    }
    expect(sent('pointer')).toEqual([])
  })
})
