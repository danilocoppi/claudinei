import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import App from '../App'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo, TerminalState } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const interrompido: TerminalState = {
  projectId: 1, engine: 'claude', autostart: false, autoResume: false,
  interruption: { at: '2026-11-20T10:00:00.000Z', reason: 'off' }, autoResumeLimit: false, usageLimit: null,
}

/**
 * A regra do Zen, tirada do styles.css de verdade e posta na página: a moldura sai
 * por CSS (continua montada), então "escondida" aqui é o display computado.
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
const regraZen = css.match(/\.app\.zen \.sidebar,[^{]*\{[^}]*\}/)?.[0] ?? ''
let estilo: HTMLStyleElement
beforeAll(() => {
  estilo = document.createElement('style')
  estilo.textContent = regraZen
  document.head.appendChild(estilo)
})
afterAll(() => estilo.remove())

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/api/me')) return json({ setupRequired: false, id: 1, username: 'u', isAdmin: true })
    return json([])
  })
  useStore.setState({
    authStatus: 'ready',
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    sessions: { a: sess() },
    chat: { a: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    engines: [CLAUDE],
    terminalStates: { '1:claude': interrompido },
    view: 'chat', activeLocalId: 'a',
    progressOpen: true,
    zen: false,
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const altZ = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', altKey: true })

/** Cada peça da moldura: montada e visível (true), montada e escondida (false). */
const visivel = (sel: string) => {
  const el = document.querySelector(sel)
  expect(el, `${sel} continua montado`).toBeTruthy()
  return getComputedStyle(el!).display !== 'none'
}
const moldura = () => ({
  sidebar: visivel('.sidebar'),
  resizer: visivel('.sidebar-resizer'),
  topbar: visivel('.mobile-topbar'),
  header: visivel('.chat-header'),
  coluna: visivel('aside.progress'),
})

/**
 * Zen esconde só a moldura: lateral, cabeçalho do chat e coluna do acompanhamento.
 * A conversa, o campo e os avisos continuam — é para ler e escrever com menos ruído,
 * não para perder o que pede a atenção do operador.
 */
describe('modo Zen', () => {
  it('Alt+Z esconde lateral, cabeçalho e coluna e mostra o botão de sair', () => {
    render(<App />)
    const antes = moldura()
    expect(antes.sidebar).toBe(true)
    expect(antes.resizer).toBe(true)
    expect(antes.topbar).toBe(true)
    expect(antes.header).toBe(true)
    expect(antes.coluna).toBe(true)
    expect(document.querySelector('.zen-exit')).toBeNull()

    const naoCancelado = altZ()
    expect(naoCancelado).toBe(false) // preventDefault: a tecla não segue para a página
    const depois = moldura()
    expect(depois.sidebar).toBe(false)
    expect(depois.resizer).toBe(false)
    expect(depois.topbar).toBe(false)
    expect(depois.header).toBe(false)
    expect(depois.coluna).toBe(false)
    expect(screen.getByRole('button', { name: /sair do zen/i })).toBeTruthy()
  })

  it('Alt+Z de novo traz tudo de volta', () => {
    render(<App />)
    altZ()
    altZ()
    const m = moldura()
    expect(m.sidebar).toBe(true)
    expect(m.resizer).toBe(true)
    expect(m.topbar).toBe(true)
    expect(m.header).toBe(true)
    expect(m.coluna).toBe(true)
    expect(document.querySelector('.zen-exit')).toBeNull()
  })

  it('o botão sair do Zen desliga o modo', () => {
    render(<App />)
    altZ()
    fireEvent.click(screen.getByRole('button', { name: /sair do zen/i }))
    expect(useStore.getState().zen).toBe(false)
    expect(visivel('.sidebar')).toBe(true)
    expect(visivel('.chat-header')).toBe(true)
    expect(document.querySelector('.zen-exit')).toBeNull()
  })

  it('persiste em localStorage claudinei:zen', async () => {
    render(<App />)
    altZ()
    expect(localStorage.getItem('claudinei:zen')).toBe('1')
    altZ()
    expect(localStorage.getItem('claudinei:zen')).toBe('0')

    // E o estado salvo é o que vale ao recarregar a página.
    // O store importa o i18n, que é reavaliado junto e lê a língua do localStorage:
    // sem ela o resto do arquivo passaria a rodar em outra língua.
    localStorage.setItem('claudinei:zen', '1')
    localStorage.setItem('claudinei.locale', 'pt-BR')
    vi.resetModules()
    const recarregado = await import('../store')
    expect(recarregado.useStore.getState().zen).toBe(true)
  })

  it('Alt+Z dentro do terminal interativo não faz nada', () => {
    render(<App />)
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const textarea = document.createElement('textarea')
    xterm.appendChild(textarea)
    document.body.appendChild(xterm)
    try {
      // Lá o Alt+Z é do shell ou do programa no terminal, não da página.
      const naoCancelado = altZ(textarea)
      expect(naoCancelado).toBe(true)
      expect(useStore.getState().zen).toBe(false)
      expect(visivel('.sidebar')).toBe(true)
    } finally {
      xterm.remove()
    }
  })

  it('Alt+Z segurado (auto-repetição) não fica ligando e desligando', () => {
    render(<App />)
    altZ()
    expect(useStore.getState().zen).toBe(true)
    // As repetições da tecla segurada não contam, mas também não escrevem nada.
    expect(fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, repeat: true })).toBe(false)
    expect(useStore.getState().zen).toBe(true)
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, repeat: true })
    expect(useStore.getState().zen).toBe(true)
  })

  it('Alt+Z com Ctrl, Meta ou Shift juntos não é o atalho', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, metaKey: true })
    fireEvent.keyDown(window, { key: 'Z', code: 'KeyZ', altKey: true, shiftKey: true })
    expect(useStore.getState().zen).toBe(false)
  })

  it('Alt+Z no campo do chat liga o Zen (o campo não é terminal)', () => {
    render(<App />)
    const campo = document.querySelector('.chat-compose textarea, .chat-compose [contenteditable]')
    expect(campo).toBeTruthy()
    altZ(campo!)
    expect(useStore.getState().zen).toBe(true)
  })

  /**
   * A moldura hospeda modais (Aparência, Novo terminal, editor de grupo…). Desmontá-la
   * no Alt+Z pulava o "cancelar" deles: a prévia de aparência ficava aplicada e
   * gravada no cache, e o que se digitou no modal sumia.
   */
  it('Alt+Z com o painel de Aparência aberto não o desmonta (o cancelar dele segue possível)', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /aparência/i }))
    expect(screen.getByTestId('appearance-panel')).toBeTruthy()
    altZ()
    expect(useStore.getState().zen).toBe(true)
    expect(screen.getByTestId('appearance-panel')).toBeTruthy()
    altZ()
    expect(useStore.getState().zen).toBe(false)
    expect(screen.getByTestId('appearance-panel')).toBeTruthy()
  })

  it('Alt+Z com o Novo terminal aberto mantém o que foi digitado', () => {
    render(<App />)
    fireEvent.click(screen.getByTitle('+ Terminal'))
    const nome = screen.getByPlaceholderText('Nome do projeto') as HTMLInputElement
    fireEvent.change(nome, { target: { value: 'meio digitado' } })
    altZ(nome)
    expect(useStore.getState().zen).toBe(true)
    altZ()
    expect((screen.getByPlaceholderText('Nome do projeto') as HTMLInputElement).value).toBe('meio digitado')
  })

  it('avisos e campo continuam visíveis no Zen', () => {
    render(<App />)
    altZ()
    expect(visivel('.chat-compose')).toBe(true)
    expect(visivel('.restart-notice')).toBe(true)
  })
})
