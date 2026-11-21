import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import App from '../App'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { pushStash, stashKey } from '../stash'
import i18n from '../i18n'
import { simulateMac } from './mac'
import type { EngineMeta, SessionInfo } from '../types'

/**
 * As dicas da tela (título do Enviar, do 🎤, dos guardados e do botão de sair do
 * Zen) mostram a combinação que está valendo, e não mais uma tecla fixa. Ação sem
 * atalho: a dica não cita tecla nenhuma.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  // o 🎤 só aparece com microfone no navegador
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/api/me')) return json({ setupRequired: false, id: 1, username: 'u', isAdmin: true })
    if (url.includes('/history')) return json({ events: [], before: 0, atStart: true })
    return json([])
  })
  useStore.setState({
    authStatus: 'ready',
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    zen: false,
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  useStore.getState().setKeybindings({})
})

/** O campo de mensagem com um prompt guardado, para o botão dos guardados aparecer. */
function abrirCampo() {
  pushStash(stashKey(1, 'claude'), { text: 'guardado', attachments: [], savedAt: 1 })
  render(<WsContext.Provider value={{ send: () => {} } as never}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
}
const tituloEnviar = () => screen.getByRole('button', { name: i18n.t('common.send') }).getAttribute('title')
const tituloMic = () => screen.getByRole('button', { name: i18n.t('mic.start') }).getAttribute('title')
const tituloGuardados = () => screen.getByTestId('stash-btn').getAttribute('title')

/** O app no modo Zen: o botão de sair carrega a dica do atalho. */
function abrirZen() {
  useStore.setState({ zen: true })
  render(<App />)
}
const tituloZen = () => document.querySelector('.zen-exit')?.getAttribute('title')

describe('as dicas mostram a combinação valendo', () => {
  it('com os padrões, o texto é o de hoje', () => {
    abrirCampo()
    expect(tituloEnviar()).toBe('Enter no campo · Ctrl+Enter de qualquer ponto da tela · Alt+Enter põe na fila')
    expect(tituloMic()).toContain('Ctrl+Espaço: toque liga e desliga, segure para falar')
    expect(tituloGuardados()).toContain('Ctrl+S guarda o que está no campo')
    cleanup()
    abrirZen()
    expect(tituloZen()).toBe('Modo Zen: só a conversa e o campo. Alt+Z liga e desliga.')
  })

  it('trocar o Zen para Alt+M muda a dica para "Alt+M liga e desliga"', () => {
    useStore.getState().setKeybindings({ 'view.zen': 'Alt+M' })
    abrirZen()
    expect(tituloZen()).toBe('Modo Zen: só a conversa e o campo. Alt+M liga e desliga.')
  })

  it('a dica acompanha a troca com a tela já aberta', () => {
    abrirCampo()
    act(() => useStore.getState().setKeybindings({ 'chat.stash': 'Alt+G' }))
    expect(tituloGuardados()).toContain('Alt+G guarda o que está no campo')
  })

  it('sem atalho de fila, a dica do Enviar não cita fila', () => {
    useStore.getState().setKeybindings({ 'chat.queue': null })
    abrirCampo()
    expect(tituloEnviar()).toBe('Enter no campo · Ctrl+Enter de qualquer ponto da tela')
  })

  it('sem atalho de Zen, a dica não cita tecla', () => {
    useStore.getState().setKeybindings({ 'view.zen': null })
    abrirZen()
    expect(tituloZen()).toBe(i18n.t('zen.hintNoKey'))
    expect(tituloZen()).toBe('Modo Zen: só a conversa e o campo.')
  })

  it('sem atalho do microfone e dos guardados, os títulos não citam tecla', () => {
    useStore.getState().setKeybindings({ 'chat.voice': null, 'chat.stash': null })
    abrirCampo()
    expect(tituloMic()).toBe(i18n.t('mic.start'))
    expect(tituloGuardados()).toBe('1 prompt guardado.')
  })

  it('no Mac, a dica do Zen mostra ⌥Z e a do Enviar ⌘↩', () => {
    simulateMac()
    abrirCampo()
    expect(tituloEnviar()).toContain('⌘↩ de qualquer ponto da tela')
    cleanup()
    abrirZen()
    expect(tituloZen()).toBe('Modo Zen: só a conversa e o campo. ⌥Z liga e desliga.')
  })
})
