import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

// O upload é falso: o teste olha o File que chegaria ao servidor.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  uploadFile: vi.fn(),
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { uploadFile } from '../api'
import { isLargePaste, pasteFileName, PASTE_MAX_BYTES, PASTE_MAX_LINES } from '../paste'

const subir = vi.mocked(uploadFile)

beforeEach(() => {
  localStorage.clear()
  subir.mockReset()
  subir.mockImplementation(async (file: File, name?: string) => {
    const n = `001-${name ?? file.name}`
    return { path: `/ups/${n}`, name: n }
  })
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, textarea: screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement }
}

/** Cola como o navegador: sem arquivos, só o texto em text/plain. Devolve `false` com preventDefault. */
const colarTexto = (el: HTMLElement, texto: string) =>
  fireEvent.paste(el, { clipboardData: { files: [], getData: (tipo: string) => (tipo === 'text/plain' ? texto : '') } })

const ctrlShiftV = (el: HTMLElement) =>
  fireEvent.keyDown(el, { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })

/** O File do jsdom não tem .text(): lê pelo FileReader. */
const lerTexto = (f: Blob) => new Promise<string>((ok, falha) => {
  const r = new FileReader()
  r.onload = () => ok(r.result as string)
  r.onerror = () => falha(r.error)
  r.readAsText(f)
})

const linhas = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n')

describe('isLargePaste e pasteFileName', () => {
  it('limites exatos: 10 240 bytes e 100 linhas ainda são texto', () => {
    expect(PASTE_MAX_BYTES).toBe(10_240)
    expect(PASTE_MAX_LINES).toBe(100)
    expect(isLargePaste('a'.repeat(10_240))).toBe(false)
    expect(isLargePaste('a'.repeat(10_241))).toBe(true)
    expect(isLargePaste(linhas(100))).toBe(false)
    expect(isLargePaste(linhas(101))).toBe(true)
    expect(isLargePaste('')).toBe(false)
  })

  it('conta bytes em UTF-8, não caracteres', () => {
    // "é" ocupa 2 bytes: 5 121 deles passam de 10 240 bytes com só 5 121 caracteres
    expect(isLargePaste('é'.repeat(5_120))).toBe(false)
    expect(isLargePaste('é'.repeat(5_121))).toBe(true)
  })

  it('a quebra no fim da última linha não conta como linha a mais', () => {
    expect(isLargePaste(`${linhas(100)}\n`)).toBe(false)
    expect(isLargePaste(linhas(100).replace(/\n/g, '\r\n') + '\r\n')).toBe(false)
  })

  it('pasteFileName usa a hora local HHMMSS', () => {
    expect(pasteFileName(new Date(2026, 10, 20, 9, 5, 7))).toBe('colado-090507.txt')
    expect(pasteFileName()).toMatch(/^colado-\d{6}\.txt$/)
  })
})

describe('colar no ChatInput', () => {
  it('colar 101 linhas vira anexo .txt e token no cursor', async () => {
    const { textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: 'veja  agora' } })
    textarea.setSelectionRange(5, 5) // depois de "veja "
    const texto = linhas(101)
    expect(colarTexto(textarea, texto), 'o texto não pode entrar no campo').toBe(false)
    await vi.waitFor(() => expect(textarea.value).toMatch(/^veja \[📎 001-colado-\d{6}\.txt\] agora$/))
    expect(subir).toHaveBeenCalledTimes(1)
    const [file] = subir.mock.calls[0]
    expect(file.type).toBe('text/plain')
    expect(file.name).toMatch(/^colado-\d{6}\.txt$/)
    expect(await lerTexto(file)).toBe(texto)
  })

  it('colar 10 241 bytes numa linha vira anexo', async () => {
    const { textarea } = renderInput()
    expect(colarTexto(textarea, 'x'.repeat(10_241))).toBe(false)
    await vi.waitFor(() => expect(textarea.value).toMatch(/^\[📎 001-colado-\d{6}\.txt\]$/))
    expect(subir).toHaveBeenCalledTimes(1)
  })

  it('o anexo colado vai com o caminho no envio', async () => {
    const { send, textarea } = renderInput()
    colarTexto(textarea, linhas(200))
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 001-colado-'))
    const nome = textarea.value.match(/001-colado-\d{6}\.txt/)![0]
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: `/ups/${nome}` })
  })

  it('colar texto pequeno entra no campo como hoje', () => {
    const { textarea } = renderInput()
    // sem preventDefault: o navegador insere o texto sozinho
    expect(colarTexto(textarea, linhas(100))).toBe(true)
    expect(colarTexto(textarea, 'a'.repeat(10_240))).toBe(true)
    expect(subir).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+V cola grande como texto', () => {
    const { textarea } = renderInput()
    // o keydown não pode ser barrado: é ele que faz o navegador colar
    expect(ctrlShiftV(textarea)).toBe(true)
    expect(colarTexto(textarea, linhas(500))).toBe(true)
    expect(subir).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+V vale para um paste só', async () => {
    const { textarea } = renderInput()
    ctrlShiftV(textarea)
    expect(colarTexto(textarea, linhas(500))).toBe(true)
    // o paste seguinte, sem a tecla, volta à regra do anexo
    expect(colarTexto(textarea, linhas(500))).toBe(false)
    await vi.waitFor(() => expect(subir).toHaveBeenCalledTimes(1))
  })

  it('Ctrl+Shift+V vence em 1 s', async () => {
    const agora = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { textarea } = renderInput()
    ctrlShiftV(textarea)
    agora.mockReturnValue(1_001_001)
    expect(colarTexto(textarea, linhas(500))).toBe(false)
    await vi.waitFor(() => expect(subir).toHaveBeenCalledTimes(1))
  })

  it('Ctrl+S continua guardando (o Ctrl+Shift+V não o atrapalha)', () => {
    const { textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: 'oi' } })
    // sem sessão não há terminal para guardar, mas o Ctrl+S ainda barra o "salvar página"
    expect(fireEvent.keyDown(textarea, { key: 's', code: 'KeyS', ctrlKey: true })).toBe(false)
  })

  it('colar arquivo continua como hoje', async () => {
    const { textarea } = renderInput()
    const file = new File(['x'], 'print.png', { type: 'image/png' })
    // mesmo com texto grande junto (o navegador às vezes manda os dois), o arquivo manda
    fireEvent.paste(textarea, { clipboardData: { files: [file], getData: () => linhas(500) } })
    await vi.waitFor(() => expect(textarea.value).toBe('[📎 001-print.png]'))
    expect(subir).toHaveBeenCalledTimes(1)
    expect(subir.mock.calls[0][0]).toBe(file)
  })
})
