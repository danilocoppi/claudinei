import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// Só a fila é falsa: o resto da API (o savePrefs inclusive) segue a real, sobre o fetch falso.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  addToQueue: vi.fn(),
}))

import App from '../App'
import { AppearancePanel } from '../components/AppearancePanel'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useZenShortcut } from '../useZenShortcut'
import { DEFAULT_APPEARANCE } from '../appearance'
import { addToQueue } from '../api'
import { readStash, stashKey } from '../stash'
import { simulateMac } from './mac'
import type { Overrides } from '../shortcuts/resolve'
import type { EngineMeta, SessionInfo } from '../types'

/**
 * A aba Atalhos do painel de aparência: grava uma combinação nova apertando-a,
 * avisa recusas e conflitos na própria linha, volta ao padrão e só guarda (e só
 * passa a valer) no Salvar — com um PUT só do que mudou.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [], midTurnInput: true,
}
const sess = (localId: string, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** O que o servidor guardou dos atalhos (o PUT troca, o GET devolve). */
let servidor: Overrides

/** Servidor de mentira: o PUT devolve o que recebeu, com os atalhos guardados quando não vieram. */
const stubFetch = (opts: { failPut?: boolean } = {}) => vi.spyOn(globalThis, 'fetch').mockImplementation(
  async (url, init) => {
    const u = String(url)
    if (u.endsWith('/api/local-apps/terminals')) return json({ options: [], chosen: null })
    if (u.includes('/api/prefs')) {
      if (init?.method === 'PUT') {
        if (opts.failPut) throw new Error('rede fora')
        const body = JSON.parse(String(init.body)) as { appearance?: unknown; keybindings?: Overrides }
        if (body.keybindings) servidor = body.keybindings
        return json({ appearance: body.appearance ?? DEFAULT_APPEARANCE, keybindings: servidor })
      }
      return json({ appearance: DEFAULT_APPEARANCE, keybindings: servidor })
    }
    if (u.includes('/history')) return json({ events: [], before: 0, atStart: true })
    return json([])
  })

const puts = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')

beforeEach(() => {
  servidor = {}
  localStorage.clear()
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  useStore.setState({
    authStatus: 'ready',
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess('s1', 'idle'), working: sess('working', 'working') },
    chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {}, queues: {},
    view: 'dashboard', activeLocalId: undefined, engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    zen: false,
  })
  useStore.getState().applyAppearance(DEFAULT_APPEARANCE)
  // Resolve de novo com o `me` acima (o setState não resolve).
  useStore.getState().setKeybindings({})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  useStore.getState().setKeybindings({})
})

/** O ouvinte do Zen, como o App monta. */
function Zen() {
  useZenShortcut()
  return null
}

/** O painel aberto na aba Atalhos (com o ouvinte do Zen montado ao lado). */
function abrirAtalhos(onClose: () => void = vi.fn()) {
  render(<><Zen /><AppearancePanel onClose={onClose} /></>)
  fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
  return onClose
}

const combo = (id: string) => screen.getByTestId(`sc-combo-${id}`)
const msg = (id: string) => screen.queryByTestId(`sc-msg-${id}`)
const tecla = (key: string, code: string, mods: object = {}, alvo: Element = document.body) =>
  fireEvent.keyDown(alvo, { key, code, ...mods })
/** Clica na combinação da linha e aperta uma tecla; devolve false quando a tecla foi barrada. */
const gravar = (id: string, key: string, code: string, mods: object = {}, alvo: Element = document.body) => {
  fireEvent.click(combo(id))
  return tecla(key, code, mods, alvo)
}
const GRAVANDO = 'Aperte a nova combinação… (Esc cancela)'
const salvar = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
const cancelarPainel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

describe('abas e lista', () => {
  it('abas: Restaurar só na aparência e Voltar todos só nos atalhos', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    expect(screen.getByText('Restaurar padrões')).toBeTruthy()
    expect(screen.queryByTestId('sc-reset-all')).toBeNull()
    expect(screen.queryByTestId('sc-row-chat.send')).toBeNull()
    fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
    expect(screen.queryByText('Restaurar padrões')).toBeNull()
    expect(screen.getByTestId('sc-reset-all').textContent).toBe('Voltar todos ao padrão')
    expect(screen.queryByTestId('theme-light-fun')).toBeNull()
    fireEvent.click(screen.getByTestId('ap-tab-appearance'))
    expect(screen.getByTestId('theme-light-fun')).toBeTruthy()
    expect(screen.queryByTestId('sc-reset-all')).toBeNull()
  })

  it('lista os editáveis e os fixos com o selo; uso só para administrador', () => {
    stubFetch()
    abrirAtalhos()
    for (const id of ['chat.send', 'chat.queue', 'chat.voice', 'chat.stash', 'chat.find', 'view.zen', 'view.usage', 'triage.undo']) {
      expect(screen.getByTestId(`sc-row-${id}`)).toBeTruthy()
    }
    expect(screen.getByTestId('sc-row-chat.send').textContent).toContain('Enviar')
    expect(combo('chat.send').textContent).toBe('Ctrl+Enter')
    expect(combo('chat.voice').textContent).toBe('Ctrl+Espaço')
    expect(combo('view.usage').textContent).toBe('Ctrl+U')
    const copiar = screen.getByTestId('sc-fixed-fixed.clipboard')
    expect(copiar.textContent).toContain('Copiar, colar, recortar e selecionar tudo')
    expect(copiar.textContent).toContain('Ctrl+C')
    expect(copiar.textContent).toContain('fixo')
    expect(screen.getByTestId('sc-fixed-fixed.escape').textContent).toContain('Esc')
    // A edição de texto do macOS só no Mac.
    expect(screen.queryByTestId('sc-fixed-fixed.macEdit')).toBeNull()
    // Fixo não tem botão de gravar.
    expect(screen.queryByTestId('sc-combo-fixed.clipboard')).toBeNull()
    cleanup()

    useStore.setState({ me: { setupRequired: false, id: 2, username: 'v', isAdmin: false } })
    useStore.getState().setKeybindings({})
    abrirAtalhos()
    expect(screen.queryByTestId('sc-row-view.usage')).toBeNull()
    expect(screen.getByTestId('sc-row-view.zen')).toBeTruthy()
  })

  it('no Mac a lista mostra os símbolos e a edição de texto do macOS', () => {
    simulateMac()
    stubFetch()
    abrirAtalhos()
    expect(combo('chat.send').textContent).toBe('⌘↩')
    expect(screen.getByTestId('sc-fixed-fixed.macEdit').textContent).toContain('fixo')
  })
})

describe('gravar', () => {
  it('gravar Alt+M: mostra "Aperte a nova combinação…" e a linha passa a Alt+M', () => {
    stubFetch()
    abrirAtalhos()
    fireEvent.click(combo('view.zen'))
    expect(combo('view.zen').textContent).toBe(GRAVANDO)
    expect(tecla('m', 'KeyM', { altKey: true }), 'a tecla é barrada').toBe(false)
    expect(combo('view.zen').textContent).toBe('Alt+M')
    expect(screen.getByTestId('sc-reset-view.zen')).toBeTruthy()
    // Gravou, parou de ouvir: a próxima tecla não grava nada.
    tecla('n', 'KeyN', { altKey: true })
    expect(combo('view.zen').textContent).toBe('Alt+M')
  })

  it('Esc cancela sem mudar nada; modificador sozinho continua esperando', () => {
    stubFetch()
    abrirAtalhos()
    fireEvent.click(combo('view.zen'))
    expect(tecla('Escape', 'Escape')).toBe(false)
    expect(combo('view.zen').textContent).toBe('Alt+Z')
    expect(screen.queryByTestId('sc-reset-view.zen')).toBeNull()

    fireEvent.click(combo('view.zen'))
    expect(tecla('Alt', 'AltLeft', { altKey: true })).toBe(false)
    expect(tecla('Shift', 'ShiftLeft', { altKey: true, shiftKey: true })).toBe(false)
    expect(combo('view.zen').textContent).toBe(GRAVANDO)
    expect(msg('view.zen')).toBeNull()
    tecla('M', 'KeyM', { altKey: true, shiftKey: true })
    expect(combo('view.zen').textContent).toBe('Alt+Shift+M')
  })

  it('durante a gravação nenhum atalho dispara', async () => {
    stubFetch()
    const enfileirar = vi.mocked(addToQueue)
    enfileirar.mockReset()
    enfileirar.mockResolvedValue({ projectId: 1, engine: 'claude', items: [], paused: false, pauseReason: null })
    const startMicCapture = vi.fn(async () => ({ stop: vi.fn(() => new Float32Array(1000).fill(0.1)) }))
    const transcribeAudio = vi.fn(async () => ({ text: 'ditado' }))
    render(
      <WsContext.Provider value={{ send: () => {} } as never}>
        <Zen />
        <ChatInput localId="working" disabled={false} micDeps={{ startMicCapture, transcribeAudio }} />
        <AppearancePanel onClose={() => {}} />
      </WsContext.Provider>,
    )
    fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
    const campo = document.querySelector('.chat-foot textarea') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'pendente' } })
    campo.focus()

    // Cada uma grava no "Buscar" e dá conflito; nenhuma chega ao dono.
    expect(gravar('chat.find', 'z', 'KeyZ', { altKey: true }, campo)).toBe(false)
    expect(useStore.getState().zen).toBe(false)
    fireEvent.click(screen.getByTestId('sc-cancel'))

    expect(gravar('chat.find', 'Enter', 'Enter', { altKey: true }, campo)).toBe(false)
    expect(enfileirar).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('sc-cancel'))

    expect(gravar('chat.find', ' ', 'Space', { ctrlKey: true }, campo)).toBe(false)
    fireEvent.click(screen.getByTestId('sc-cancel'))

    expect(gravar('chat.find', 's', 'KeyS', { ctrlKey: true }, campo)).toBe(false)
    fireEvent.click(screen.getByTestId('sc-cancel'))

    expect(campo.value).toBe('pendente')
    expect(readStash(stashKey(1, 'claude'))).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(startMicCapture).not.toHaveBeenCalled()
    expect(combo('chat.find').textContent).toBe('Ctrl+F')

    // Fora da gravação, as mesmas teclas voltam a agir (os ouvintes estão montados).
    tecla('z', 'KeyZ', { altKey: true }, campo)
    expect(useStore.getState().zen).toBe(true)
    // O microfone é do escopo da página: com o painel (modal) aberto, nem do campo
    // ele liga — a regra que impede o envio por trás de um diálogo.
    tecla(' ', 'Space', { ctrlKey: true }, campo)
    await new Promise((r) => setTimeout(r, 0))
    expect(startMicCapture).not.toHaveBeenCalled()
  })

  it('tecla não aceita avisa e continua gravando', () => {
    stubFetch()
    abrirAtalhos()
    fireEvent.click(combo('chat.send'))
    expect(tecla(',', 'Comma', { ctrlKey: true })).toBe(false)
    expect(msg('chat.send')?.textContent).toContain('Tecla não aceita')
    expect(combo('chat.send').textContent).toBe(GRAVANDO)
    // Tab é barrado: não tira o foco do painel.
    expect(tecla('Tab', 'Tab')).toBe(false)
    expect(msg('chat.send')?.textContent).toContain('Tecla não aceita')
    expect(tecla('ArrowUp', 'ArrowUp', { ctrlKey: true })).toBe(false)
    // Super com letra fora do Mac.
    expect(tecla('k', 'KeyK', { metaKey: true })).toBe(false)
    expect(combo('chat.send').textContent).toBe(GRAVANDO)
    expect(msg('chat.send')?.textContent).toContain('Tecla não aceita')
    // Super sozinho só espera.
    expect(tecla('Meta', 'MetaLeft', { metaKey: true })).toBe(false)
    expect(combo('chat.send').textContent).toBe(GRAVANDO)
    // Uma combinação boa grava e tira o aviso.
    tecla('k', 'KeyK', { ctrlKey: true })
    expect(combo('chat.send').textContent).toBe('Ctrl+K')
    expect(msg('chat.send')).toBeNull()
  })

  /**
   * O keyup vem depois que a gravação já parou de ouvir. No Firefox o keyup do
   * Espaço "clica" o botão da combinação, ainda focado, e a gravação recomeçaria.
   * O teste faz o papel do navegador: keyup não barrado vira clique.
   */
  it('o keyup da tecla gravada é barrado e não recomeça a gravação', () => {
    stubFetch()
    abrirAtalhos()
    const botao = combo('view.zen')
    botao.focus()
    const soltar = (key: string, code: string, mods: object = {}) => {
      const passou = fireEvent.keyUp(botao, { key, code, ...mods })
      if (passou && key === ' ') fireEvent.click(botao)
      return passou
    }
    fireEvent.click(botao)
    tecla(' ', 'Space', { ctrlKey: true, shiftKey: true }, botao)
    expect(botao.textContent).toBe('Ctrl+Shift+Espaço')
    // Soltar o Ctrl antes: também barrado, e o Espaço ainda é esperado.
    expect(soltar('Control', 'ControlLeft', { shiftKey: true })).toBe(false)
    expect(soltar(' ', 'Space', { shiftKey: true })).toBe(false)
    expect(botao.textContent).toBe('Ctrl+Shift+Espaço')
    expect(botao.getAttribute('aria-pressed')).toBe('false')
    // A tecla gravada subiu: o próximo keyup já segue normal.
    expect(soltar('Shift', 'ShiftLeft')).toBe(true)

    // Soltura perdida (outra tecla desceu antes): nada fica barrado para sempre.
    fireEvent.click(botao)
    tecla('m', 'KeyM', { altKey: true }, botao)
    expect(botao.textContent).toBe('Alt+M')
    tecla('a', 'KeyA', {}, botao)
    expect(fireEvent.keyUp(botao, { key: 'm', code: 'KeyM' })).toBe(true)
  })
})

describe('acessibilidade', () => {
  it('o botão da combinação diz a ação, e o aviso da linha é anunciado', () => {
    stubFetch()
    abrirAtalhos()
    expect(screen.getByRole('button', { name: 'Modo Zen: Alt+Z' })).toBe(combo('view.zen'))
    expect(screen.getByRole('button', { name: 'Enviar: Ctrl+Enter' })).toBe(combo('chat.send'))
    fireEvent.click(combo('view.zen'))
    expect(screen.getByRole('button', { name: `Modo Zen: ${GRAVANDO}` })).toBe(combo('view.zen'))
    tecla(',', 'Comma', { ctrlKey: true })
    expect(msg('view.zen')?.getAttribute('role')).toBe('status')
    expect(screen.getByRole('status').textContent).toContain('Tecla não aceita')
    tecla('Escape', 'Escape')
    fireEvent.click(screen.getByTestId('sc-clear-view.zen'))
    expect(screen.getByRole('button', { name: 'Modo Zen: sem atalho' })).toBe(combo('view.zen'))
  })
})

describe('conflitos e recusas', () => {
  it('conflito com editável: Trocar deixa o outro sem atalho; Cancelar não muda', () => {
    stubFetch()
    abrirAtalhos()
    gravar('chat.send', 'z', 'KeyZ', { altKey: true })
    expect(msg('chat.send')?.textContent).toContain('Já é o atalho de Modo Zen')
    fireEvent.click(screen.getByTestId('sc-cancel'))
    expect(combo('chat.send').textContent).toBe('Ctrl+Enter')
    expect(combo('view.zen').textContent).toBe('Alt+Z')
    expect(msg('chat.send')).toBeNull()
    expect(screen.queryByTestId('sc-swap')).toBeNull()

    gravar('chat.send', 'z', 'KeyZ', { altKey: true })
    fireEvent.click(screen.getByTestId('sc-swap'))
    expect(combo('chat.send').textContent).toBe('Alt+Z')
    expect(combo('view.zen').textContent).toBe('sem atalho')
    expect(screen.getByTestId('sc-reset-chat.send')).toBeTruthy()
    expect(screen.getByTestId('sc-reset-view.zen')).toBeTruthy()
  })

  it('fixos recusados', () => {
    stubFetch()
    abrirAtalhos()
    gravar('chat.send', 'c', 'KeyC', { ctrlKey: true })
    expect(msg('chat.send')?.textContent).toBe('Não dá para usar Ctrl+C: é o atalho fixo de Copiar, colar, recortar e selecionar tudo')
    expect(combo('chat.send').textContent).toBe('Ctrl+Enter')
    gravar('view.zen', 's', 'KeyS', { ctrlKey: true })
    expect(msg('view.zen')?.textContent).toBe('Não dá para usar Ctrl+S: é o atalho fixo de Salvar nos editores de arquivo')
    expect(combo('view.zen').textContent).toBe('Alt+Z')
    expect(screen.queryByTestId('sc-reset-view.zen')).toBeNull()
  })

  it('Mod+S no desfazer não é recusa de fixo, e sim conflito com Guardar rascunho', () => {
    stubFetch()
    abrirAtalhos()
    gravar('triage.undo', 's', 'KeyS', { ctrlKey: true })
    expect(msg('triage.undo')?.textContent).toContain('Já é o atalho de Guardar rascunho')
    expect(screen.getByTestId('sc-swap')).toBeTruthy()
  })

  it('reservadas e sem modificador recusadas; F2 aceita', () => {
    stubFetch()
    abrirAtalhos()
    gravar('chat.send', 'w', 'KeyW', { ctrlKey: true })
    expect(msg('chat.send')?.textContent).toBe('Não dá para usar Ctrl+W: o sistema ou o navegador não deixa a página receber')
    gravar('chat.send', 'F5', 'F5')
    expect(msg('chat.send')?.textContent).toBe('Não dá para usar F5: o sistema ou o navegador não deixa a página receber')
    gravar('chat.send', 'm', 'KeyM')
    expect(msg('chat.send')?.textContent).toBe('Não dá para usar M: precisa de Ctrl, ⌘ ou Alt')
    expect(combo('chat.send').textContent).toBe('Ctrl+Enter')
    gravar('chat.send', 'F2', 'F2')
    expect(combo('chat.send').textContent).toBe('F2')
    expect(msg('chat.send')).toBeNull()
  })

  it('Ctrl+Alt+M recusado fora do Mac', () => {
    stubFetch()
    abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { ctrlKey: true, altKey: true })
    expect(msg('view.zen')?.textContent).toBe('Não dá para usar Ctrl+Alt+M: Ctrl+Alt é o AltGr de alguns teclados')
    expect(combo('view.zen').textContent).toBe('Alt+Z')
  })

  it('Ctrl+R grava com aviso amarelo', () => {
    stubFetch()
    abrirAtalhos()
    gravar('chat.find', 'r', 'KeyR', { ctrlKey: true })
    expect(combo('chat.find').textContent).toBe('Ctrl+R')
    const aviso = msg('chat.find')!
    expect(aviso.textContent).toBe('O navegador também usa esta combinação; aqui vale a do Claudinei')
    expect(aviso.className).toContain('sc-msg--warn')
  })
})

describe('voltar ao padrão', () => {
  it('voltar ao padrão: o botão da linha só aparece quando difere; Voltar todos limpa tudo', () => {
    stubFetch()
    abrirAtalhos()
    expect(document.querySelectorAll('[data-testid^="sc-reset-"]:not([data-testid="sc-reset-all"])').length).toBe(0)
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    fireEvent.click(screen.getByTestId('sc-reset-view.zen'))
    expect(combo('view.zen').textContent).toBe('Alt+Z')
    expect(screen.queryByTestId('sc-reset-view.zen')).toBeNull()

    fireEvent.click(screen.getByTestId('sc-clear-chat.find'))
    expect(combo('chat.find').textContent).toBe('sem atalho')
    expect(screen.getByTestId('sc-reset-chat.find')).toBeTruthy()
    expect(screen.queryByTestId('sc-clear-chat.find')).toBeNull()
    gravar('chat.send', 'F2', 'F2')
    gravar('view.zen', 'm', 'KeyM', { altKey: true })

    fireEvent.click(screen.getByTestId('sc-reset-all'))
    expect(document.querySelectorAll('[data-testid^="sc-reset-"]:not([data-testid="sc-reset-all"])').length).toBe(0)
    expect(combo('chat.find').textContent).toBe('Ctrl+F')
    expect(combo('chat.send').textContent).toBe('Ctrl+Enter')
    expect(combo('view.zen').textContent).toBe('Alt+Z')
  })

  it('gravar o próprio padrão não cria diferença e Salvar fecha sem PUT', async () => {
    const spy = stubFetch()
    const onClose = abrirAtalhos()
    // Fora do Mac, Ctrl+Espaço grava como Mod+Space: é o padrão do microfone.
    gravar('chat.voice', ' ', 'Space', { ctrlKey: true })
    expect(combo('chat.voice').textContent).toBe('Ctrl+Espaço')
    expect(screen.queryByTestId('sc-reset-chat.voice')).toBeNull()
    // A combinação que já vale também não muda nada.
    gravar('view.zen', 'z', 'KeyZ', { altKey: true })
    expect(screen.queryByTestId('sc-reset-view.zen')).toBeNull()
    // Mudar e voltar ao padrão gravando: sem diferença (o Mod+Space gravado não
    // fica como escolha, embora no Mac ele fosse outra tecla).
    gravar('chat.voice', 'F2', 'F2')
    expect(screen.getByTestId('sc-reset-chat.voice')).toBeTruthy()
    gravar('chat.voice', ' ', 'Space', { ctrlKey: true })
    expect(combo('chat.voice').textContent).toBe('Ctrl+Espaço')
    expect(screen.queryByTestId('sc-reset-chat.voice')).toBeNull()
    gravar('chat.send', 'F3', 'F3')
    gravar('chat.send', 'Enter', 'Enter', { ctrlKey: true })
    expect(screen.queryByTestId('sc-reset-chat.send')).toBeNull()
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(puts(spy)).toEqual([])
  })

  it('no Mac, gravar ⌃Espaço no microfone também não cria diferença', async () => {
    simulateMac()
    const spy = stubFetch()
    const onClose = abrirAtalhos()
    gravar('chat.voice', ' ', 'Space', { ctrlKey: true })
    expect(screen.queryByTestId('sc-reset-chat.voice')).toBeNull()
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(puts(spy)).toEqual([])
  })
})

describe('salvar', () => {
  it('Salvar só com atalhos manda PUT sem appearance; depois Alt+M liga o Zen', async () => {
    const spy = stubFetch()
    const onClose = abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const enviados = puts(spy)
    expect(enviados).toHaveLength(1)
    expect(JSON.parse(String((enviados[0][1] as RequestInit).body))).toEqual({ keybindings: { 'view.zen': 'Alt+M' } })
    expect(useStore.getState().keybindings.overrides).toEqual({ 'view.zen': 'Alt+M' })
    tecla('z', 'KeyZ', { altKey: true })
    expect(useStore.getState().zen).toBe(false)
    tecla('m', 'KeyM', { altKey: true })
    expect(useStore.getState().zen).toBe(true)
  })

  it('aparência e atalhos mudados vão no mesmo PUT', async () => {
    const spy = stubFetch()
    const onClose = abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    fireEvent.click(screen.getByTestId('ap-tab-appearance'))
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    // O rascunho dos atalhos sobrevive à troca de aba.
    fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
    expect(combo('view.zen').textContent).toBe('Alt+M')
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const body = JSON.parse(String((puts(spy)[0][1] as RequestInit).body))
    expect(body.appearance.theme).toBe('light-fun')
    expect(body.keybindings).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('sem prévia ao vivo: antes de Salvar, Alt+Z ainda liga o Zen; Cancelar descarta', () => {
    const spy = stubFetch()
    const onClose = abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    tecla('m', 'KeyM', { altKey: true })
    expect(useStore.getState().zen).toBe(false)
    tecla('z', 'KeyZ', { altKey: true })
    expect(useStore.getState().zen).toBe(true)
    cancelarPainel()
    expect(onClose).toHaveBeenCalled()
    expect(useStore.getState().keybindings.overrides).toEqual({})
    expect(puts(spy)).toEqual([])
  })

  it('falha de rede: erro no painel e os atalhos não mudam', async () => {
    stubFetch({ failPut: true })
    const onClose = abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    salvar()
    expect((await screen.findByRole('alert')).textContent).toContain('rede fora')
    expect(onClose).not.toHaveBeenCalled()
    expect(useStore.getState().keybindings.overrides).toEqual({})
    expect(localStorage.getItem('claudinei:keybindings')).toBe('{}')
    tecla('m', 'KeyM', { altKey: true })
    expect(useStore.getState().zen).toBe(false)
    // O rascunho continua na aba, para tentar de novo.
    expect(combo('view.zen').textContent).toBe('Alt+M')
  })

  /**
   * Os dois no mesmo PUT e ele falha: a aparência continua aplicada (prévia ao
   * vivo), os atalhos não. A frase precisa dizer as duas coisas.
   */
  it('falha com aparência e atalhos: o aviso diz que a aparência ficou e os atalhos não', async () => {
    stubFetch({ failPut: true })
    const onClose = abrirAtalhos()
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    fireEvent.click(screen.getByTestId('ap-tab-appearance'))
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    salvar()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Não foi possível guardar: rede fora. A aparência escolhida continua aplicada aqui, mas os atalhos continuam como estavam.')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.theme).toBe('light-fun')
    expect(useStore.getState().keybindings.overrides).toEqual({})
  })

  it('não administrador: Mod+U no Zen grava sem conflito', async () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'v', isAdmin: false } })
    useStore.getState().setKeybindings({})
    stubFetch()
    const onClose = abrirAtalhos()
    gravar('view.zen', 'u', 'KeyU', { ctrlKey: true })
    expect(msg('view.zen')).toBeNull()
    expect(combo('view.zen').textContent).toBe('Ctrl+U')
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    tecla('u', 'KeyU', { ctrlKey: true })
    expect(useStore.getState().zen).toBe(true)
  })
})

describe('avisos e dicas', () => {
  it('escolha salva que virou reservada mostra "Voltou ao padrão porque…"', () => {
    useStore.getState().setKeybindings({ 'view.zen': 'Mod+W' })
    stubFetch()
    abrirAtalhos()
    expect(combo('view.zen').textContent).toBe('Alt+Z')
    expect(msg('view.zen')?.textContent).toBe('Voltou ao padrão porque o sistema ou o navegador não deixa a página receber')
    expect(screen.getByTestId('sc-reset-view.zen')).toBeTruthy()
  })

  it('padrão ocupado por uma escolha deixa a ação sem atalho, dizendo de quem é', () => {
    useStore.getState().setKeybindings({ 'chat.send': 'Alt+Z' })
    stubFetch()
    abrirAtalhos()
    expect(combo('view.zen').textContent).toBe('sem atalho')
    expect(msg('view.zen')?.textContent).toBe('Sem atalho: o padrão já é de Enviar')
  })

  /**
   * Resposta 200 mal formada do GET /api/prefs: o syncPrefs deixa o erro subir
   * (é defeito, não rede fora) e o App registra no console em vez de deixar uma
   * rejeição solta.
   */
  it('preferências mal formadas do servidor vão para o console, sem rejeição solta', async () => {
    const spy = stubFetch()
    const real = spy.getMockImplementation()!
    spy.mockImplementation(async (url, init) =>
      String(url).includes('/api/prefs') && !init?.method ? json(null) : real(url, init))
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<App />)
    await waitFor(() => expect(erro).toHaveBeenCalledWith(
      '[prefs] falha ao aplicar as preferências do servidor', expect.any(TypeError)))
  })

  it('a dica do Zen muda depois de Salvar', async () => {
    stubFetch()
    useStore.setState({ zen: true })
    const onClose = vi.fn()
    render(<><App /><AppearancePanel onClose={onClose} /></>)
    const titulo = () => document.querySelector('.zen-exit')?.getAttribute('title')
    expect(titulo()).toBe('Modo Zen: só a conversa e o campo. Alt+Z liga e desliga.')
    fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
    gravar('view.zen', 'm', 'KeyM', { altKey: true })
    // Sem prévia: antes de salvar a dica não muda.
    expect(titulo()).toBe('Modo Zen: só a conversa e o campo. Alt+Z liga e desliga.')
    salvar()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await waitFor(() => expect(titulo()).toBe('Modo Zen: só a conversa e o campo. Alt+M liga e desliga.'))
  })
})
