import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'

// Só a checagem dos anexos é falsa: o upload segue pelo fetch (espionado abaixo).
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  checkUploads: vi.fn(),
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { checkUploads } from '../api'
import { pushStash, readStash, stashKey } from '../stash'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number, engine = 'claude'): SessionInfo =>
  ({ localId, projectId, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine })

const okUpload = (name: string) =>
  new Response(JSON.stringify({ path: `/ups/${name}`, name }), { status: 201, headers: { 'Content-Type': 'application/json' } })

let enviadas: any[]
const ws = { send: (m: any) => enviadas.push(m) } as never
const checar = vi.mocked(checkUploads)

beforeEach(() => {
  enviadas = []
  localStorage.clear()
  checar.mockReset()
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' },
               { id: 2, name: 'Beta', path: '/b', color: '#fff', icon: '📦' }],
    groups: [], sectors: [], schedules: [],
    sessions: {
      s1: sess('s1', 1),
      // outra sessão do MESMO terminal (projeto 1 + claude): a de depois de um /clear, por exemplo
      s3: sess('s3', 1),
      s2: sess('s2', 2),
      s4: sess('s4', 1, 'codex'),
    },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrir = (localId: string) =>
  render(<WsContext.Provider value={ws}><ChatInput key={localId} localId={localId} disabled={false} /></WsContext.Provider>)

const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement
const digitar = (texto: string) => fireEvent.change(campo(), { target: { value: texto } })
/** Devolve `false` quando o handler chamou preventDefault (padrão do fireEvent). */
const ctrlS = () => fireEvent.keyDown(campo(), { key: 's', code: 'KeyS', ctrlKey: true })
const K1 = stashKey(1, 'claude')
const botao = () => screen.queryByTestId('stash-btn')

describe('Ctrl+S guarda o prompt para depois', () => {
  it('Ctrl+S com texto guarda e limpa o campo (preventDefault)', () => {
    abrir('s1')
    digitar('um prompt para mais tarde')
    expect(ctrlS(), 'o Ctrl+S do navegador (salvar página) precisa ser barrado').toBe(false)
    expect(campo().value).toBe('')
    expect(readStash(K1).map((e) => e.text)).toEqual(['um prompt para mais tarde'])
    // nada foi enviado
    expect(enviadas).toEqual([])
  })

  it('Ctrl+S que não consegue gravar mantém o campo e avisa', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('001-a.png'))
    abrir('s1')
    fireEvent.paste(campo(), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await vi.waitFor(() => expect(campo().value).toContain('[📎 001-a.png]'))
    digitar(`não perca ${campo().value}`)
    // armazenamento cheio/bloqueado só para os guardados
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'claudinei:stash') throw new DOMException('quota', 'QuotaExceededError')
      real.call(this, k, v)
    })
    expect(ctrlS()).toBe(false)
    expect(campo().value).toBe('não perca [📎 001-a.png]')
    expect(readStash(K1)).toEqual([])
    expect(screen.getByText(/Não deu para guardar/)).toBeTruthy()
    // o anexo continua valendo no envio
    fireEvent.keyDown(campo(), { key: 'Enter' })
    expect(enviadas).toEqual([{ type: 'send_message', localId: 's1', text: 'não perca /ups/001-a.png' }])
  })

  it('Ctrl+S com o campo vazio e nada guardado não faz nada (mas segura o navegador)', () => {
    abrir('s1')
    expect(ctrlS()).toBe(false)
    expect(campo().value).toBe('')
    expect(checar).not.toHaveBeenCalled()
  })

  it('Ctrl+S com o campo vazio traz o último, com o anexo funcionando no envio', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('001-a.png'))
    checar.mockResolvedValue({ missing: [] })
    abrir('s1')
    fireEvent.paste(campo(), { clipboardData: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await vi.waitFor(() => expect(campo().value).toContain('[📎 001-a.png]'))
    digitar(`veja ${campo().value} aqui`)
    ctrlS()
    expect(campo().value).toBe('')
    expect(readStash(K1)[0].attachments).toEqual([['[📎 001-a.png]', '/ups/001-a.png']])
    cleanup()

    // Remontado: o mapa de anexos em memória morreu; quem traz o caminho é o guardado.
    abrir('s1')
    expect(ctrlS()).toBe(false)
    await vi.waitFor(() => expect(campo().value).toBe('veja [📎 001-a.png] aqui'))
    expect(checar).toHaveBeenCalledWith(['/ups/001-a.png'])
    expect(readStash(K1)).toEqual([])

    fireEvent.keyDown(campo(), { key: 'Enter' })
    expect(enviadas).toEqual([{ type: 'send_message', localId: 's1', text: 'veja /ups/001-a.png aqui' }])
  })

  it('anexo apagado volta marcado como não disponível e o envio não quebra', async () => {
    checar.mockResolvedValue({ missing: ['/ups/001-a.png'] })
    pushStash(K1, {
      text: 'compare [📎 001-a.png] com [📎 002-b.png]',
      attachments: [['[📎 001-a.png]', '/ups/001-a.png'], ['[📎 002-b.png]', '/ups/002-b.png']],
      savedAt: 1,
    })
    abrir('s1')
    ctrlS()
    await vi.waitFor(() =>
      expect(campo().value).toBe('compare [📎 001-a.png — não disponível] com [📎 002-b.png]'))

    fireEvent.keyDown(campo(), { key: 'Enter' })
    // o ausente vai como texto (marcado); o que existe vira caminho
    expect(enviadas).toEqual([{
      type: 'send_message', localId: 's1',
      text: 'compare [📎 001-a.png — não disponível] com /ups/002-b.png',
    }])
  })

  it('Ctrl+S com upload em andamento não faz nada', async () => {
    // upload que nunca termina
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    pushStash(K1, { text: 'guardado antes', attachments: [], savedAt: 1 })
    abrir('s1')
    digitar('texto com anexo a caminho ')
    fireEvent.paste(campo(), { clipboardData: { files: [new File(['x'], 'a.png')] } })
    await vi.waitFor(() => expect(campo().placeholder).toMatch(/enviando anexo/))

    expect(ctrlS(), 'mesmo ignorado, o salvar do navegador não abre').toBe(false)
    expect(campo().value).toBe('texto com anexo a caminho ')
    expect(readStash(K1).map((e) => e.text)).toEqual(['guardado antes'])

    // e com o campo vazio também não traz nada
    digitar('')
    ctrlS()
    expect(campo().value).toBe('')
    expect(readStash(K1).map((e) => e.text)).toEqual(['guardado antes'])
  })

  it('o menu dos guardados mostra a contagem e restaura um item escolhido', () => {
    abrir('s1')
    // sem guardados, sem ícone
    expect(botao()).toBeNull()
    digitar('primeiro guardado'); ctrlS()
    digitar('segundo guardado'); ctrlS()
    expect(botao()!.textContent).toContain('2')

    fireEvent.click(botao()!)
    const menu = screen.getByTestId('stash-menu')
    const itens = within(menu).getAllByTestId('stash-item')
    // o mais novo primeiro
    expect(itens.map((i) => i.textContent)).toEqual([
      expect.stringContaining('segundo guardado'),
      expect.stringContaining('primeiro guardado'),
    ])

    fireEvent.click(itens[1])
    expect(campo().value).toBe('primeiro guardado')
    expect(screen.queryByTestId('stash-menu')).toBeNull()
    expect(botao()!.textContent).toContain('1')
    expect(readStash(K1).map((e) => e.text)).toEqual(['segundo guardado'])
  })

  it('o ícone some quando o último guardado volta', () => {
    abrir('s1')
    digitar('só um'); ctrlS()
    expect(botao()).not.toBeNull()
    ctrlS()
    expect(campo().value).toBe('só um')
    expect(botao()).toBeNull()
  })

  it('guardados são do terminal (projeto+motor), não da sessão', () => {
    abrir('s1')
    digitar('guardado no terminal Alpha/claude'); ctrlS()
    cleanup()

    // outro projeto, ou o mesmo projeto em outro motor: não veem
    abrir('s2'); expect(botao()).toBeNull(); cleanup()
    abrir('s4'); expect(botao()).toBeNull(); cleanup()

    // outra sessão do mesmo terminal: vê e traz
    abrir('s3')
    expect(botao()!.textContent).toContain('1')
    ctrlS()
    expect(campo().value).toBe('guardado no terminal Alpha/claude')
  })
})
