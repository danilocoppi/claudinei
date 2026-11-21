import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { ChatView } from '../components/ChatView'
import { UndoToast } from '../components/UndoToast'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useZenShortcut } from '../useZenShortcut'
import { useUsageShortcut } from '../useUsageShortcut'
import { DEFAULT_APPEARANCE } from '../appearance'
import { simulateMac } from './mac'
import type { EngineMeta, SessionInfo, TriageItem } from '../types'

/**
 * Os quatro atalhos da janela — Zen, uso, busca e desfazer — perguntam ao
 * registro qual é a combinação: trocar a tecla muda quem age, e a antiga para de
 * agir. Fora do Mac a tecla Super não vale como Ctrl; no Mac, Mod é ⌘ e o
 * Control não vale no lugar dele.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const blank = (projectId: number): TriageItem => ({ projectId, pinned: false, settled: false, snoozedUntil: null })

/** O que a rota de triagem recebeu (o desfazer grava o estado de antes). */
let patches: Array<{ url: string; body: unknown }>

beforeEach(() => {
  localStorage.clear()
  patches = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u.includes('/triage') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Partial<TriageItem>
      patches.push({ url: u, body })
      return json({ ...blank(1), ...body })
    }
    if (u.includes('/history')) return json({ events: [], before: 0, atStart: true })
    return json([])
  })
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    historyCursor: { s1: { before: 0, atStart: true, conv: 'c' } }, folds: {}, orphanResults: {}, find: null,
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    zen: false, triage: { 1: { ...blank(1), settled: true } }, undo: null, triageError: null,
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStore.getState().setKeybindings({})
})

const tecla = (alvo: Element, key: string, code: string, mods: object = {}) =>
  fireEvent.keyDown(alvo, { key, code, ...mods })

function Atalhos() {
  useZenShortcut()
  useUsageShortcut(true)
  return null
}

/** A conversa (com o ouvinte da busca), o aviso do desfazer e os ouvintes do Zen e do uso. */
async function montar() {
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 60 }}>
      <WsContext.Provider value={{ send: () => {} } as never}>
        <ChatView />
        <UndoToast />
        <Atalhos />
      </WsContext.Provider>
    </VirtuosoMockContext.Provider>,
  )
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
}

/** Uma triagem recém-feita (Alpha assentado), ainda desfazível. */
const comDesfazer = () => act(() => {
  useStore.setState({
    undo: { label: 'Alpha assentado', projectId: 1, before: blank(1), after: { ...blank(1), settled: true }, expiresAt: Date.now() + 5_000 },
  })
})
const barraAberta = () => useStore.getState().find !== null

describe('Zen pelo registro', () => {
  it('Zen em Alt+M liga e Alt+Z não liga', async () => {
    useStore.getState().setKeybindings({ 'view.zen': 'Alt+M' })
    await montar()
    expect(tecla(document.body, 'z', 'KeyZ', { altKey: true }), 'a combinação antiga não é mais do Zen').toBe(true)
    expect(useStore.getState().zen).toBe(false)
    expect(tecla(document.body, 'm', 'KeyM', { altKey: true })).toBe(false) // false = preventDefault
    expect(useStore.getState().zen).toBe(true)
  })

  it('Zen ignora tecla que alguém já tratou', async () => {
    await montar()
    // Alguém antes da janela (aqui, na captura do document) já tratou o Alt+Z.
    const tratar = (e: KeyboardEvent) => { if (e.code === 'KeyZ' && e.altKey) e.preventDefault() }
    document.addEventListener('keydown', tratar, true)
    try {
      tecla(document.body, 'z', 'KeyZ', { altKey: true })
      expect(useStore.getState().zen).toBe(false)
    } finally {
      document.removeEventListener('keydown', tratar, true)
    }
    tecla(document.body, 'z', 'KeyZ', { altKey: true })
    expect(useStore.getState().zen).toBe(true)
  })
})

describe('uso pelo registro', () => {
  it('uso em Mod+Shift+U abre a página; Ctrl+U não', async () => {
    useStore.getState().setKeybindings({ 'view.usage': 'Mod+Shift+U' })
    await montar()
    expect(tecla(document.body, 'u', 'KeyU', { ctrlKey: true })).toBe(true)
    expect(useStore.getState().view).toBe('chat')
    expect(tecla(document.body, 'U', 'KeyU', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(useStore.getState().view).toBe('usage')
  })
})

describe('busca pelo registro', () => {
  it('busca em Alt+F abre a barra; Ctrl+F fica com o navegador (não previne)', async () => {
    useStore.getState().setKeybindings({ 'chat.find': 'Alt+F' })
    await montar()
    expect(tecla(document.body, 'f', 'KeyF', { ctrlKey: true }), 'Ctrl+F não é mais da página').toBe(true)
    expect(barraAberta()).toBe(false)
    expect(tecla(document.body, 'f', 'KeyF', { altKey: true })).toBe(false)
    expect(barraAberta()).toBe(true)
    expect(screen.getByPlaceholderText('Buscar na conversa')).toBeTruthy()
  })
})

describe('desfazer pelo registro', () => {
  it('desfazer em Alt+U desfaz a triagem; Ctrl+Z não', async () => {
    useStore.getState().setKeybindings({ 'triage.undo': 'Alt+U' })
    await montar()
    comDesfazer()
    expect(tecla(document.body, 'z', 'KeyZ', { ctrlKey: true })).toBe(true)
    expect(useStore.getState().undo).not.toBeNull()
    expect(patches).toEqual([])
    expect(tecla(document.body, 'u', 'KeyU', { altKey: true })).toBe(false)
    expect(useStore.getState().undo).toBeNull()
    expect(patches.map((p) => p.body)).toEqual([{ pinned: false, settled: false, snoozedUntil: null }])
  })
})

describe('Super e ⌘', () => {
  it('fora do Mac, Super+F não abre a busca e Super+Z não desfaz', async () => {
    await montar()
    comDesfazer()
    expect(tecla(document.body, 'f', 'KeyF', { metaKey: true })).toBe(true)
    expect(barraAberta()).toBe(false)
    expect(tecla(document.body, 'z', 'KeyZ', { metaKey: true })).toBe(true)
    expect(useStore.getState().undo).not.toBeNull()
    expect(patches).toEqual([])
    // Ctrl continua valendo nos dois.
    expect(tecla(document.body, 'z', 'KeyZ', { ctrlKey: true })).toBe(false)
    expect(useStore.getState().undo).toBeNull()
    expect(tecla(document.body, 'f', 'KeyF', { ctrlKey: true })).toBe(false)
    expect(barraAberta()).toBe(true)
  })

  it('no Mac, ⌘F abre a busca e Control+F não', async () => {
    simulateMac()
    await montar()
    expect(tecla(document.body, 'f', 'KeyF', { ctrlKey: true })).toBe(true)
    expect(barraAberta()).toBe(false)
    expect(tecla(document.body, 'f', 'KeyF', { metaKey: true })).toBe(false)
    expect(barraAberta()).toBe(true)
  })
})
