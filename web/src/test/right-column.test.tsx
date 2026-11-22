import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// A conversa é uma lista virtual: sem medidas fixas, o jsdom não montaria nada.
import { renderComJanela as render } from './viewport'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { applySideMessage, useSideStore } from '../branch/sideStore'
import type { SideInfo } from '../branch/api'
import { applyBrowserMessage, useBrowserStore } from '../browser/browserStore'
import { useColumnStore } from '../browser/columnStore'
import type { EngineMeta, SessionInfo } from '../types'

/**
 * A coluna da direita do chat: um lugar só, com as abas das vistas que existem
 * (Acompanhamento sempre; Lateral enquanto existir; Navegador enquanto o
 * terminal tiver aba), largura lembrada por vista, tela cheia, o Zen e quem a
 * toma (a lateral ao nascer, o agente ao abrir o navegador).
 */

const meta = (id: string, label: string): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [], midTurnInput: true,
})
const sess = (localId: string, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const lateral = (o: Partial<SideInfo> = {}): SideInfo => ({
  id: 'side-1', projectId: 1, engine: 'claude', status: 'idle', mode: 'native', cutAt: null,
  files: 'no_edit_tools', question: null, openedAt: '2026-11-21T12:00:00Z', ...o,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function api() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u === '/api/browser/tabs') return json({ tabs: [] })
    if (u.includes('/browser')) return method === 'DELETE' ? new Response(null, { status: 204 }) : json({ ok: true })
    if (u.includes('/side')) return method === 'GET' ? json({ side: null, events: [] }) : new Response(null, { status: 204 })
    if (u.includes('/history')) return json({ events: [], before: 0, atStart: true })
    if (u.includes('/progress')) return json({ progress: null, path: '' })
    return json([])
  })
}

/** As regras de verdade do styles.css (Zen e tela cheia), postas na página: "escondido" é o display computado. */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
const regras = [
  css.match(/\.app\.zen \.sidebar,[^{]*\{[^}]*\}/)?.[0] ?? '',
  css.match(/\.chat-layout--column-full > \.chat-main[^{]*\{[^}]*\}/)?.[0] ?? '',
]
let estilo: HTMLStyleElement
beforeAll(() => {
  estilo = document.createElement('style')
  estilo.textContent = regras.join('\n')
  document.head.appendChild(estilo)
})
afterAll(() => estilo.remove())

beforeEach(() => {
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null })
  useBrowserStore.setState({ tabs: {}, failed: {} })
  useColumnStore.setState({ view: 'progress', previous: null, fullscreen: false, marked: [], widths: {} })
  useStore.setState({
    authStatus: 'ready',
    progressEpoch: 0,
    progress: {},
    progressOpen: true,
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁', engines: ['claude', 'codex'] }],
    terminalStates: {},
    sessions: { a: sess('a'), b: sess('b', { engine: 'codex' }) },
    chat: { a: [], b: [] },
    unread: {},
    streaming: {},
    historyLoadedFor: {},
    view: 'chat',
    activeLocalId: 'a',
    engines: [meta('claude', 'Claude Code'), meta('codex', 'Codex')],
    zen: false,
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const montar = (zen = false) => render(
  <WsContext.Provider value={{ send: vi.fn() }}>
    <div className={`app${zen ? ' zen' : ''}`}><ChatView /></div>
  </WsContext.Provider>,
)
const coluna = () => document.querySelector<HTMLElement>('aside.right-column')
/** As abas da coluna (o cabeçalho do chat tem as abas dos motores, também `tab`). Com o Zen ela está escondida. */
const aba = (name: string) => within(coluna()!).getByRole('tab', { name, hidden: true })
const abas = () => (coluna() ? within(coluna()!).queryAllByRole('tab', { hidden: true }).map((b) => b.textContent) : [])
const comAba = (engine = 'claude') =>
  act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine, open: true, by: 'operator' }) })
/** O React escuta `pointerdown`/`pointermove` pelo nome; o jsdom não tem PointerEvent, então vai um MouseEvent com esse nome. */
const ponteiro = (alvo: EventTarget, tipo: string, clientX: number) =>
  act(() => { alvo.dispatchEvent(new MouseEvent(tipo, { clientX, bubbles: true })) })

describe('coluna da direita', () => {
  it('abas só das vistas existentes', async () => {
    api()
    montar()
    await waitFor(() => expect(coluna()).toBeTruthy())
    expect(abas()).toEqual(['Acompanhamento'])
    comAba()
    expect(abas()).toEqual(['Acompanhamento', 'Navegador'])
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: lateral() }) })
    expect(abas()).toEqual(['Acompanhamento', 'Lateral', 'Navegador'])
    // A aba de outro terminal não aparece aqui.
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: false, by: 'agent' }) })
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'codex', open: true, by: 'agent' }) })
    expect(abas()).toEqual(['Acompanhamento', 'Lateral'])
  })

  it('clicar na aba troca a vista', async () => {
    api()
    montar()
    await waitFor(() => expect(coluna()).toBeTruthy())
    comAba()
    expect(coluna()!.dataset.view).toBe('progress')
    expect(document.querySelector('aside.progress')).toBeTruthy()
    fireEvent.click(aba('Navegador'))
    expect(coluna()!.dataset.view).toBe('browser')
    expect(aba('Navegador').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('aside.progress')).toBeNull()
    expect(screen.getByTestId('browser-placeholder')).toBeTruthy()
    fireEvent.click(aba('Acompanhamento'))
    expect(coluna()!.dataset.view).toBe('progress')
    expect(document.querySelector('aside.progress')).toBeTruthy()
  })

  it('largura lembrada por vista no localStorage', async () => {
    api()
    const largura = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-layout') ? 1200 : 0
    })
    try {
      montar()
      await waitFor(() => expect(coluna()).toBeTruthy())
      comAba()
      expect(coluna()!.style.width).toBe('340px')
      const puxador = screen.getByRole('separator')
      ponteiro(puxador, 'pointerdown', 800)
      ponteiro(window, 'pointermove', 700)
      // Durante o arrasto a largura acompanha, sem gravar.
      expect(coluna()!.style.width).toBe('440px')
      expect(localStorage.getItem('claudinei:columnWidths')).toBeNull()
      ponteiro(window, 'pointerup', 700)
      expect(JSON.parse(localStorage.getItem('claudinei:columnWidths')!)).toEqual({ progress: 440 })
      // Depois de soltar, mexer o ponteiro não mexe mais na coluna.
      ponteiro(window, 'pointermove', 100)
      expect(coluna()!.style.width).toBe('440px')

      fireEvent.click(aba('Navegador'))
      expect(coluna()!.style.width).toBe('600px') // metade da área
      fireEvent.click(aba('Acompanhamento'))
      expect(coluna()!.style.width).toBe('440px')
    } finally {
      largura.mockRestore()
    }
  })

  it('tela cheia esconde o chat e o mesmo botão volta', async () => {
    api()
    montar()
    await waitFor(() => expect(coluna()).toBeTruthy())
    const main = document.querySelector('.chat-main')!
    expect(getComputedStyle(main).display).not.toBe('none')
    fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }))
    expect(document.querySelector('.chat-layout')!.classList.contains('chat-layout--column-full')).toBe(true)
    expect(getComputedStyle(main).display).toBe('none')
    expect(JSON.parse(localStorage.getItem('claudinei:column')!).fullscreen).toBe(true)
    const voltar = screen.getByRole('button', { name: 'Sair da tela cheia' })
    expect(voltar.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(voltar)
    expect(getComputedStyle(main).display).not.toBe('none')
    expect(screen.getByRole('button', { name: 'Tela cheia' })).toBeTruthy()
  })

  it('Zen esconde só data-view=progress', async () => {
    api()
    montar(true)
    await waitFor(() => expect(coluna()).toBeTruthy())
    expect(getComputedStyle(coluna()!).display).toBe('none')
    comAba()
    fireEvent.click(aba('Navegador'))
    expect(getComputedStyle(coluna()!).display).not.toBe('none')
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: lateral() }) })
    expect(coluna()!.dataset.view).toBe('side')
    expect(getComputedStyle(coluna()!).display).not.toBe('none')
  })

  it('nascer a lateral toma a coluna e fechá-la volta à anterior', async () => {
    api()
    montar()
    await waitFor(() => expect(coluna()).toBeTruthy())
    comAba()
    fireEvent.click(aba('Navegador'))
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: lateral() }) })
    expect(coluna()!.dataset.view).toBe('side')
    expect(document.querySelector('.side-col')).toBeTruthy()
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: null }) })
    expect(coluna()!.dataset.view).toBe('browser')

    // Com a coluna fechada, a lateral a abre; ao sumir, ela fecha de novo.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a coluna' }))
    expect(coluna()).toBeNull()
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: lateral({ id: 'side-2' }) }) })
    expect(coluna()!.dataset.view).toBe('side')
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: null }) })
    expect(coluna()).toBeNull()
  })

  it('browser_tab do agente no terminal ativo abre em Navegador', async () => {
    api()
    useStore.setState({ progressOpen: false })
    montar()
    await waitFor(() => expect(document.querySelector('.chat-layout')).toBeTruthy())
    expect(coluna()).toBeNull()
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: true, by: 'agent' }) })
    expect(coluna()!.dataset.view).toBe('browser')

    // Com a Lateral à vista, só a aba aparece, com a marca.
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: false, by: 'agent' }) })
    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: lateral() }) })
    expect(coluna()!.dataset.view).toBe('side')
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: true, by: 'agent' }) })
    expect(coluna()!.dataset.view).toBe('side')
    const navegador = aba('Navegador')
    expect(navegador.querySelector('.right-column__mark')).toBeTruthy()
    fireEvent.click(navegador)
    expect(aba('Navegador').querySelector('.right-column__mark')).toBeNull()
  })

  it('browser_tab de outro terminal não mexe na coluna', async () => {
    api()
    useStore.setState({ progressOpen: false })
    montar()
    await waitFor(() => expect(document.querySelector('.chat-layout')).toBeTruthy())
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'codex', open: true, by: 'agent' }) })
    expect(coluna()).toBeNull()
    expect(useBrowserStore.getState().tabs['1:codex']).toBe(true)
    // O operador abriu (noutra janela): a aba existe, a coluna fica como está.
    act(() => { applyBrowserMessage({ type: 'browser_tab', projectId: 1, engine: 'claude', open: true, by: 'operator' }) })
    expect(coluna()).toBeNull()
    expect(useStore.getState().progressOpen).toBe(false)
  })
})
