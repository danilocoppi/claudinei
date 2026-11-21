import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { useRef } from 'react'

// Só a fila é falsa: o resto da API segue a real.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  addToQueue: vi.fn(),
}))

import { ChatInput } from '../components/ChatInput'
import { MicButton, type MicDeps } from '../components/MicButton'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { addToQueue } from '../api'
import { readStash, stashKey } from '../stash'
import { simulateMac } from './mac'
import type { EngineMeta, OperatorQueue, SessionInfo } from '../types'

/**
 * O campo de mensagem e o microfone perguntam ao registro qual é a combinação:
 * trocar enviar, fila, guardar ou microfone muda a tecla que age, e a antiga
 * para de agir. O Enter puro no campo continua enviando.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [], midTurnInput: true,
}
const sess = (localId: string, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })
const fila = (engine: string, o: Partial<OperatorQueue> = {}): OperatorQueue =>
  ({ projectId: 1, engine, items: [], paused: false, pauseReason: null, ...o })

let enviadas: Array<{ type: string; text?: string }>
const ws = { send: (m: { type: string; text?: string }) => enviadas.push(m) } as never
const enfileirar = vi.mocked(addToQueue)

beforeEach(() => {
  enviadas = []
  localStorage.clear()
  enfileirar.mockReset()
  enfileirar.mockImplementation(async (_projectId, engine, text, via) =>
    fila(engine, { items: [{ id: 7, text, createdAt: '2026-11-20 12:00:00', via }] }))
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { idle: sess('idle', 'idle'), working: sess('working', 'working') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, queues: {},
    view: 'chat', activeLocalId: 'idle', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStore.getState().setKeybindings({})
})

const abrir = (localId = 'idle') =>
  render(
    <WsContext.Provider value={ws}>
      <input aria-label="busca da lateral" />
      <ChatInput key={localId} localId={localId} disabled={false} />
    </WsContext.Provider>,
  )
const campo = () => document.querySelector('.chat-foot textarea') as HTMLTextAreaElement
const digitar = (texto: string) => fireEvent.change(campo(), { target: { value: texto } })
const tecla = (alvo: Element, key: string, code: string, mods: object = {}) =>
  fireEvent.keyDown(alvo, { key, code, ...mods })
const enviados = () => enviadas.filter((m) => m.type === 'send_message')

describe('enviar, fila e guardar pelo registro', () => {
  it('enviar em Alt+S envia de fora do campo e no campo; Ctrl+Enter não envia mais de fora', () => {
    useStore.getState().setKeybindings({ 'chat.send': 'Alt+S' })
    abrir()
    digitar('um')
    expect(tecla(document.body, 'Enter', 'Enter', { ctrlKey: true }), 'a combinação antiga não é mais do chat').toBe(true)
    expect(enviados()).toEqual([])
    expect(tecla(document.body, 's', 'KeyS', { altKey: true })).toBe(false) // false = preventDefault
    expect(enviados().map((m) => m.text)).toEqual(['um'])
    digitar('dois')
    // No campo, quem trata é o onKeyDown dele; o ouvinte global pula o campo (envia uma vez só).
    expect(tecla(campo(), 's', 'KeyS', { altKey: true })).toBe(false)
    expect(enviados().map((m) => m.text)).toEqual(['um', 'dois'])
  })

  it('com a fila em Alt+Q, Alt+Enter no Claude trabalhando não envia nem enfileira; Alt+Q enfileira', async () => {
    useStore.getState().setKeybindings({ 'chat.queue': 'Alt+Q' })
    abrir('working')
    digitar('depois disso')
    tecla(campo(), 'Enter', 'Enter', { altKey: true })
    expect(enfileirar).not.toHaveBeenCalled()
    expect(enviadas).toEqual([])
    expect(campo().value).toBe('depois disso')
    expect(tecla(campo(), 'q', 'KeyQ', { altKey: true })).toBe(false)
    expect(enfileirar).toHaveBeenCalledWith(1, 'claude', 'depois disso', 'alt-enter')
    expect(campo().value).toBe('')
    expect(enviadas).toEqual([])
    await waitFor(() => expect(useStore.getState().queues['1:claude']?.items.map((i) => i.id)).toEqual([7]))
  })

  it('Enter puro continua enviando; com enviar sem atalho, Ctrl+Enter no campo não envia', () => {
    useStore.getState().setKeybindings({ 'chat.send': null })
    abrir()
    digitar('oi')
    tecla(campo(), 'Enter', 'Enter', { ctrlKey: true })
    tecla(document.body, 'Enter', 'Enter', { ctrlKey: true })
    expect(enviados()).toEqual([])
    expect(campo().value).toBe('oi')
    expect(tecla(campo(), 'Enter', 'Enter')).toBe(false)
    expect(enviados().map((m) => m.text)).toEqual(['oi'])
  })

  it('guardar em Alt+G guarda; Ctrl+S não guarda', () => {
    useStore.getState().setKeybindings({ 'chat.stash': 'Alt+G' })
    abrir()
    digitar('para depois')
    tecla(campo(), 's', 'KeyS', { ctrlKey: true })
    expect(campo().value).toBe('para depois')
    expect(readStash(stashKey(1, 'claude'))).toEqual([])
    expect(tecla(campo(), 'g', 'KeyG', { altKey: true })).toBe(false)
    expect(campo().value).toBe('')
    expect(readStash(stashKey(1, 'claude')).map((e) => e.text)).toEqual(['para depois'])
    expect(enviadas).toEqual([])
  })

  it('o enviar de escopo page não age com o foco num diálogo; fora dele, envia', () => {
    render(
      <WsContext.Provider value={ws}>
        <ChatInput localId="idle" disabled={false} />
        <div role="dialog" aria-modal="true"><button type="button">no diálogo</button></div>
      </WsContext.Provider>,
    )
    digitar('fica')
    const noDialogo = screen.getByRole('button', { name: 'no diálogo' })
    expect(tecla(noDialogo, 'Enter', 'Enter', { ctrlKey: true }), 'o atalho é do diálogo: não previne').toBe(true)
    expect(enviados()).toEqual([])
    expect(campo().value).toBe('fica')
    expect(tecla(document.body, 'Enter', 'Enter', { ctrlKey: true })).toBe(false)
    expect(enviados().map((m) => m.text)).toEqual(['fica'])
  })

  it('no Mac, ⌘Enter envia de fora do campo e Control+Enter não', () => {
    simulateMac()
    abrir()
    digitar('do mac')
    expect(tecla(document.body, 'Enter', 'Enter', { ctrlKey: true })).toBe(true)
    expect(enviados()).toEqual([])
    expect(tecla(document.body, 'Enter', 'Enter', { metaKey: true })).toBe(false)
    expect(enviados().map((m) => m.text)).toEqual(['do mac'])
  })
})

/* Microfone: o harness do mic-shortcut.test.tsx (relógio falso, HOLD_MS). */
const SPEECH = new Float32Array(1000).fill(0.1)
let agora = 1_000

function makeDeps(): MicDeps {
  return {
    startMicCapture: vi.fn(async () => ({ stop: vi.fn(() => SPEECH) })),
    transcribeAudio: vi.fn(async () => ({ text: 'ditado' })),
    now: () => agora,
  }
}

function Chat({ deps, onText }: { deps: MicDeps; onText: (t: string) => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  return (
    <div>
      <textarea ref={field} aria-label="mensagem" />
      <MicButton field={field} onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />
    </div>
  )
}

const mic = () => screen.getByRole('button', { name: /Gravar áudio|Parar gravação|transcrevendo/ })
const gravando = () => mic().textContent?.includes('⏺')

describe('microfone pelo registro', () => {
  beforeEach(() => {
    agora = 1_000
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  it('microfone em Alt+M: Alt+M liga; segurar e soltar o M para; soltar o Control não para', async () => {
    useStore.getState().setKeybindings({ 'chat.voice': 'Alt+M' })
    const onText = vi.fn()
    const deps = makeDeps()
    render(<Chat deps={deps} onText={onText} />)
    // A combinação antiga não liga mais.
    expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space', ctrlKey: true })).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(document.body, { key: 'm', code: 'KeyM', altKey: true })).toBe(false)
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 900
    // O Control não faz parte de Alt+M: soltá-lo não encerra o "segurar para falar".
    fireEvent.keyUp(document.body, { key: 'Control', code: 'ControlLeft', altKey: true })
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space', altKey: true })
    expect(gravando()).toBe(true)
    expect(onText).not.toHaveBeenCalled()
    fireEvent.keyUp(document.body, { key: 'm', code: 'KeyM', altKey: true })
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
    expect(deps.startMicCapture).toHaveBeenCalledTimes(1)
  })

  it('microfone sem atalho: Ctrl+Espaço não faz nada', () => {
    useStore.getState().setKeybindings({ 'chat.voice': null })
    const deps = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(screen.getByLabelText('mensagem'), { key: ' ', code: 'Space', ctrlKey: true })).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })
})
