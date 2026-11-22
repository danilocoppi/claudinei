import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BrowserClientMsg, BrowserStateMsg, FrameHeader } from '../../../shared/browser'

/**
 * Anotar a tela do navegador: o congelado (`freeze`) vira a base de um canvas
 * de anotação; as marcas (retângulo, seta, texto), o recorte e o desfazer; e o
 * "Mandar ao campo", que sobe o PNG e acrescenta o texto com o token do anexo
 * ao campo da sessão principal. Todo caminho de saída descongela.
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

import {
  addMark, annotationFileName, annotationText, sendAnnotation, undoMark, type AnnotationState, type Mark,
} from '../browser/annotate'
import { RightColumn } from '../browser/RightColumn'
import { useColumnStore } from '../browser/columnStore'
import { useBrowserStore } from '../browser/browserStore'
import { useSideStore } from '../branch/sideStore'
import { useStore } from '../store'
import i18n from '../i18n'

const vazio: AnnotationState = { marks: [], crop: null }
const ret: Mark = { kind: 'rect', x1: 1, y1: 2, x2: 30, y2: 40 }
const seta: Mark = { kind: 'arrow', x1: 5, y1: 5, x2: 50, y2: 60 }
const texto: Mark = { kind: 'text', x: 10, y: 20, text: 'aqui' }

/** O contexto 2D dublê: anota as chamadas de desenho. */
function ctxFalso() {
  const calls: Array<[string, unknown[]]> = []
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, args]) }
  const ctx = new Proxy({ calls } as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k]
      return (t[k] = rec(k))
    },
    set(t, k: string, v) { t[k] = v; calls.push([`set:${k}`, [v]]); return true },
  })
  return ctx as unknown as CanvasRenderingContext2D & { calls: Array<[string, unknown[]]> }
}

/**
 * Todo canvas ganha o contexto dublê e o `toBlob` que devolve um PNG falso.
 * `canvases` guarda o tamanho de cada canvas no `getContext` (o da imagem
 * mandada é zerado depois, para soltar a memória).
 */
function canvasFalso() {
  const ctxs: Array<ReturnType<typeof ctxFalso>> = []
  const canvases: Array<{ width: number; height: number }> = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const c = ctxFalso()
    ctxs.push(c)
    canvases.push({ width: this.width, height: this.height })
    return c as never
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    cb(new Blob(['png'], { type: type ?? 'image/png' }))
  })
  return { ctxs, canvases }
}

const bitmapFalso = () => ({ width: 1280, height: 800, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('annotate (puro)', () => {
  it('annotationText com a URL e o viewport', () => {
    expect(annotationText('http://127.0.0.1:5173/', { width: 1280, height: 800 }))
      .toBe('Anotação de http://127.0.0.1:5173/ (viewport 1280×800):')
  })

  it('annotationText não deixa marcadores na URL virarem números', () => {
    const url = 'http://h/?q={{width}}&r={{height}}&s=$&'
    expect(annotationText(url, { width: 1, height: 2 })).toBe(`Anotação de ${url} (viewport 1×2):`)
  })

  it('annotationText sai na língua da interface (en, es), sem escapar a URL', async () => {
    const url = 'http://127.0.0.1:5173/a?b=1&c=<2>'
    try {
      await i18n.changeLanguage('en')
      expect(annotationText(url, { width: 1280, height: 800 })).toBe(`Annotation of ${url} (viewport 1280×800):`)
      await i18n.changeLanguage('es')
      expect(annotationText(url, { width: 1280, height: 800 })).toBe(`Anotación de ${url} (viewport 1280×800):`)
    } finally {
      await i18n.changeLanguage('pt-BR')
    }
  })

  it('sendAnnotation em inglês: o texto acrescentado ao campo vai em inglês', async () => {
    canvasFalso()
    const upload = vi.fn(async (_f: File) => ({ path: '/up/anotacao-1.png', name: 'anotacao-1.png' }))
    const append = vi.fn()
    try {
      await i18n.changeLanguage('en')
      await sendAnnotation({
        localId: 'a', still: bitmapFalso(), url: 'http://127.0.0.1:5173/', viewport: { width: 1280, height: 800 },
        s: vazio, upload, append, color: '#f00',
      })
    } finally {
      await i18n.changeLanguage('pt-BR')
    }
    const tok = '[📎 anotacao-1.png]'
    expect(append).toHaveBeenCalledWith('a', `Annotation of http://127.0.0.1:5173/ (viewport 1280×800): ${tok}`, [[tok, '/up/anotacao-1.png']])
  })

  it('annotationFileName na hora local: anotacao-HHMMSS.png', () => {
    expect(annotationFileName(new Date(2026, 10, 21, 9, 5, 7))).toBe('anotacao-090507.png')
  })

  it('addMark acrescenta sem mexer no estado anterior', () => {
    const s1 = addMark(vazio, ret)
    const s2 = addMark(s1, seta)
    expect(vazio.marks).toEqual([])
    expect(s1.marks).toEqual([ret])
    expect(s2.marks).toEqual([ret, seta])
  })

  it('undoMark tira só a última', () => {
    const s = addMark(addMark(addMark({ marks: [], crop: { x: 0, y: 0, w: 10, h: 10 } }, ret), seta), texto)
    const u = undoMark(s)
    expect(u.marks).toEqual([ret, seta])
    expect(u.crop).toEqual({ x: 0, y: 0, w: 10, h: 10 })
    expect(undoMark(undoMark(u)).marks).toEqual([])
    expect(undoMark(vazio)).toEqual(vazio)
  })

  it('sendAnnotation chama upload com image/png e append com o texto, o token e o par [token, path]', async () => {
    const { ctxs, canvases } = canvasFalso()
    const upload = vi.fn(async (_f: File) => ({ path: '/up/anotacao-1.png', name: 'anotacao-1.png' }))
    const append = vi.fn()
    const still = bitmapFalso()
    await sendAnnotation({
      localId: 'a', still, url: 'http://127.0.0.1:5173/', viewport: { width: 1280, height: 800 },
      s: { marks: [ret, seta, texto], crop: { x: 100, y: 50, w: 300, h: 200 } }, upload, append, color: '#f00',
    })
    expect(upload).toHaveBeenCalledTimes(1)
    const file = upload.mock.calls[0][0]
    expect(file).toBeInstanceOf(File)
    expect(file.type).toBe('image/png')
    expect(file.name).toMatch(/^anotacao-\d{6}\.png$/)
    const tok = '[📎 anotacao-1.png]'
    expect(append).toHaveBeenCalledWith('a', `Anotação de http://127.0.0.1:5173/ (viewport 1280×800): ${tok}`, [[tok, '/up/anotacao-1.png']])
    // O recorte: o canvas tem o tamanho dele, e a base é desenhada deslocada.
    expect(canvases[0].width).toBe(300)
    expect(canvases[0].height).toBe(200)
    const c = ctxs[0].calls
    expect(c).toContainEqual(['translate', [-100, -50]])
    expect(c).toContainEqual(['drawImage', [still, 0, 0, 1280, 800]])
    expect(c).toContainEqual(['strokeRect', [1, 2, 29, 38]])
    expect(c.some(([n, a]) => n === 'fillText' && a[0] === 'aqui')).toBe(true)
    expect(c).toContainEqual(['set:strokeStyle', ['#f00']])
  })

  it('sem recorte, o viewport inteiro', async () => {
    const { canvases } = canvasFalso()
    await sendAnnotation({
      localId: 'a', still: bitmapFalso(), url: 'about:blank', viewport: { width: 640, height: 480 },
      s: vazio, upload: async () => ({ path: '/p', name: 'n.png' }), append: vi.fn(), color: '#f00',
    })
    expect([canvases[0].width, canvases[0].height]).toEqual([640, 480])
  })

  it('upload que falha não chama append (rejeita com o erro)', async () => {
    canvasFalso()
    const append = vi.fn()
    await expect(sendAnnotation({
      localId: 'a', still: bitmapFalso(), url: 'about:blank', viewport: { width: 640, height: 480 }, s: vazio,
      upload: async () => { throw new Error('disco cheio') }, append, color: '#f00',
    })).rejects.toThrow('disco cheio')
    expect(append).not.toHaveBeenCalled()
  })
})

// --- A vista: o botão Anotar na coluna do navegador ---

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let uploadReply: () => Response = () => json({ path: '/up/anotacao-120000.png', name: 'anotacao-120000.png' })
let uploads: FormData[] = []

const estado = (o: Partial<BrowserStateMsg> = {}): BrowserStateMsg => ({
  type: 'state', url: 'http://127.0.0.1:5173/', title: 'App', loading: false, crashed: false,
  baton: { kind: 'free' }, viewport: { width: 1280, height: 800 }, dialog: null, notices: [],
  lastAction: null, sandbox: true, ...o,
})
const conn = () => sock.conns[sock.conns.length - 1]
const freezes = () => conn().sent.filter((m) => (m as BrowserClientMsg).type === 'freeze')
const stillHeader = (seq = 7): FrameHeader => ({ kind: 'still', seq, width: 1280, height: 800 })
let bitmaps: Array<ReturnType<typeof bitmapFalso>> = []

beforeEach(() => {
  localStorage.clear()
  sock.conns.length = 0
  uploads = []
  bitmaps = []
  uploadReply = () => json({ path: '/up/anotacao-120000.png', name: 'anotacao-120000.png' })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u === '/api/uploads') { uploads.push(init?.body as FormData); return uploadReply() }
    if (u.endsWith('/servers')) return json({ servers: [] })
    return json({})
  })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { const b = bitmapFalso(); bitmaps.push(b); return b }))
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null, readAt: {} })
  useBrowserStore.setState({ tabs: { '1:claude': true }, failed: {} })
  useColumnStore.setState({ view: 'browser', previous: null, fullscreen: false, marks: {}, widths: {} })
  useStore.setState({
    authStatus: 'ready', progressEpoch: 0, progressOpen: true, view: 'chat', activeLocalId: 'a',
    sessions: { a: { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } },
  })
})

const montar = () => render(<div className="chat-layout"><RightColumn projectId={1} engine="claude" localId="a" /></div>)

/** Abre a anotação e entrega o congelado. */
async function anotar() {
  act(() => { conn().h.onState(estado()) })
  fireEvent.click(screen.getByRole('button', { name: 'Anotar' }))
  await act(async () => { conn().h.onFrame({ header: stillHeader(), image: new Blob(['png'], { type: 'image/png' }) }) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Mandar ao campo' })).toBeTruthy())
}

/** Arrasta no canvas de anotação (o rect dublê tem o tamanho do viewport: 1 px = 1 px). */
function arrastar(x1: number, y1: number, x2: number, y2: number) {
  const canvas = screen.getByTestId('annotate-canvas') as HTMLCanvasElement
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON() {} })
  // O jsdom não tem PointerEvent: o MouseEvent com o tipo do ponteiro leva clientX e button.
  const ev = (tipo: string, x: number, y: number) => act(() => {
    canvas.dispatchEvent(new MouseEvent(tipo, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }))
  })
  ev('pointerdown', x1, y1)
  ev('pointermove', x2, y2)
  ev('pointerup', x2, y2)
}

describe('Anotar na vista Navegador', () => {
  it('Anotar manda freeze on; Cancelar manda freeze off', async () => {
    canvasFalso()
    montar()
    await anotar()
    expect(freezes()).toEqual([{ type: 'freeze', on: true }])
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(freezes()).toEqual([{ type: 'freeze', on: true }, { type: 'freeze', on: false }])
    expect(screen.queryByTestId('annotate-canvas')).toBeNull()
    // O bitmap do congelado é fechado.
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('Escape também sai e descongela', async () => {
    canvasFalso()
    montar()
    await anotar()
    fireEvent.keyDown(screen.getByTestId('annotate'), { key: 'Escape' })
    expect(freezes().at(-1)).toEqual({ type: 'freeze', on: false })
    expect(screen.queryByTestId('annotate')).toBeNull()
  })

  it('Mandar ao campo: upload do PNG, texto com o token no campo da principal, descongela e fecha', async () => {
    const { ctxs } = canvasFalso()
    montar()
    await anotar()
    arrastar(10, 20, 110, 220)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(useSideStore.getState().appendRequest).not.toBeNull())
    expect(uploads).toHaveLength(1)
    const file = uploads[0].get('file') as File
    expect(file.type).toBe('image/png')
    const tok = '[📎 anotacao-120000.png]'
    expect(useSideStore.getState().appendRequest).toMatchObject({
      localId: 'a',
      text: `Anotação de http://127.0.0.1:5173/ (viewport 1280×800): ${tok}`,
      attachments: [[tok, '/up/anotacao-120000.png']],
    })
    // O retângulo arrastado foi para a imagem mandada.
    expect(ctxs.at(-1)!.calls).toContainEqual(['strokeRect', [10, 20, 100, 200]])
    expect(freezes().at(-1)).toEqual({ type: 'freeze', on: false })
    expect(screen.queryByTestId('annotate')).toBeNull()
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('upload que falha não chama append e mostra o erro (continua anotando, congelado)', async () => {
    canvasFalso()
    uploadReply = () => json({ error: 'disco cheio' }, 500)
    montar()
    await anotar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disco cheio'))
    expect(useSideStore.getState().appendRequest).toBeNull()
    expect(freezes()).toEqual([{ type: 'freeze', on: true }])
    expect(screen.getByTestId('annotate')).toBeTruthy()
  })

  it('desfazer tira a última marca', async () => {
    const { ctxs } = canvasFalso()
    montar()
    await anotar()
    arrastar(10, 20, 110, 220)
    arrastar(300, 300, 400, 350)
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(useSideStore.getState().appendRequest).not.toBeNull())
    const c = ctxs.at(-1)!.calls
    expect(c).toContainEqual(['strokeRect', [10, 20, 100, 200]])
    expect(c).not.toContainEqual(['strokeRect', [300, 300, 100, 50]])
  })

  it('texto: clicar põe o campo no ponto; Enter vira a marca', async () => {
    const { ctxs } = canvasFalso()
    montar()
    await anotar()
    fireEvent.click(screen.getByRole('button', { name: 'Texto' }))
    const canvas = screen.getByTestId('annotate-canvas')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON() {} })
    act(() => { canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 64, clientY: 40, button: 0, bubbles: true })) })
    const campo = screen.getByRole('textbox', { name: 'Texto da anotação' })
    expect(document.activeElement).toBe(campo)
    fireEvent.change(campo, { target: { value: 'botão torto' } })
    fireEvent.keyDown(campo, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: 'Texto da anotação' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(useSideStore.getState().appendRequest).not.toBeNull())
    expect(ctxs.at(-1)!.calls).toContainEqual(['fillText', ['botão torto', 64, 40]])
  })

  it('texto: clicar em outro ponto com o campo aberto grava o texto no ponto antigo; o campo novo nasce vazio', async () => {
    const { ctxs } = canvasFalso()
    montar()
    await anotar()
    fireEvent.click(screen.getByRole('button', { name: 'Texto' }))
    const canvas = screen.getByTestId('annotate-canvas')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0, toJSON() {} })
    const clique = (x: number, y: number) => act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }))
    })
    clique(64, 40)
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto da anotação' }), { target: { value: 'primeiro' } })
    clique(300, 200)
    const campo = screen.getByRole('textbox', { name: 'Texto da anotação' }) as HTMLInputElement
    expect(campo.value).toBe('')
    expect(document.activeElement).toBe(campo)
    fireEvent.change(campo, { target: { value: 'segundo' } })
    fireEvent.keyDown(campo, { key: 'Enter' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(useSideStore.getState().appendRequest).not.toBeNull())
    const textos = ctxs.at(-1)!.calls.filter(([n]) => n === 'fillText').map(([, a]) => a)
    expect(textos).toEqual([['primeiro', 64, 40], ['segundo', 300, 200]])
  })

  it('o erro da anotação some no ×, e quando a URL muda', async () => {
    canvasFalso()
    vi.useFakeTimers()
    montar()
    const falhar = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Anotar' }))
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(screen.getByText('Não deu para congelar a tela.')).toBeTruthy()
    }
    act(() => { conn().h.onState(estado()) })
    falhar()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o aviso' }))
    expect(screen.queryByText('Não deu para congelar a tela.')).toBeNull()
    falhar()
    // O mesmo endereço não apaga; outro, sim.
    act(() => { conn().h.onState(estado({ title: 'Outra' })) })
    expect(screen.getByText('Não deu para congelar a tela.')).toBeTruthy()
    act(() => { conn().h.onState(estado({ url: 'http://127.0.0.1:5173/outra' })) })
    expect(screen.queryByText('Não deu para congelar a tela.')).toBeNull()
  })

  it('recorte: a imagem mandada tem o tamanho do recorte', async () => {
    const { canvases } = canvasFalso()
    montar()
    await anotar()
    fireEvent.click(screen.getByRole('button', { name: 'Recorte' }))
    arrastar(200, 100, 500, 400)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    await waitFor(() => expect(useSideStore.getState().appendRequest).not.toBeNull())
    const out = canvases.at(-1)!
    expect([out.width, out.height]).toEqual([300, 300])
  })

  it('Cancelar durante o upload: nada vai ao campo', async () => {
    canvasFalso()
    let soltar: (r: Response) => void = () => {}
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (String(url) === '/api/uploads') return new Promise<Response>((r) => { soltar = r })
      return json({})
    })
    montar()
    await anotar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mandar ao campo' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(freezes().at(-1)).toEqual({ type: 'freeze', on: false })
    await act(async () => { soltar(json({ path: '/up/x.png', name: 'x.png' })) })
    await new Promise((r) => setTimeout(r, 0))
    expect(useSideStore.getState().appendRequest).toBeNull()
  })

  it('fechar a vista no meio descongela antes de fechar o socket', async () => {
    canvasFalso()
    const { unmount } = montar()
    await anotar()
    const c = conn()
    unmount()
    expect(c.sent.filter((m) => (m as BrowserClientMsg).type === 'freeze').at(-1)).toEqual({ type: 'freeze', on: false })
    expect(c.closed).toBe(true)
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('sem o congelado em 10 s: descongela, sai e avisa', async () => {
    canvasFalso()
    vi.useFakeTimers()
    montar()
    act(() => { conn().h.onState(estado()) })
    fireEvent.click(screen.getByRole('button', { name: 'Anotar' }))
    expect(freezes()).toEqual([{ type: 'freeze', on: true }])
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(freezes().at(-1)).toEqual({ type: 'freeze', on: false })
    expect(screen.queryByTestId('annotate')).toBeNull()
    expect(screen.getByText('Não deu para congelar a tela.')).toBeTruthy()
  })

  it('o congelado não vai à tela ao vivo, e um que chega fora da anotação é descartado', async () => {
    canvasFalso()
    const create = globalThis.createImageBitmap as unknown as ReturnType<typeof vi.fn>
    montar()
    act(() => { conn().h.onState(estado({ baton: { kind: 'free' } })) })
    await act(async () => { conn().h.onFrame({ header: stillHeader(3), image: new Blob(['x']) }) })
    expect(create).not.toHaveBeenCalled()
  })

  it('os textos nas três línguas', async () => {
    const i18n = (await import('../i18n')).default
    for (const lng of ['en', 'es', 'pt-BR'] as const) {
      await i18n.changeLanguage(lng)
      for (const k of ['browser.annotate.open', 'browser.annotate.send', 'browser.annotate.cancel', 'browser.annotate.undo',
        'browser.annotate.rect', 'browser.annotate.arrow', 'browser.annotate.text', 'browser.annotate.crop',
        'browser.annotate.waiting', 'browser.annotate.freezeFailed', 'browser.annotate.sendFailed', 'browser.annotate.label',
        'browser.annotate.textField', 'browser.annotate.dismissError'] as const) {
        expect(i18n.t(k), `${k} em ${lng}`).not.toBe(k)
      }
    }
    await i18n.changeLanguage('pt-BR')
  })
})
