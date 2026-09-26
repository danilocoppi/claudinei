import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { FileOpenMenu } from '../components/FileOpenMenu'
import { InlineFileView } from '../components/InlineFileView'
import { useStore } from '../store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStore.setState({ fileMenu: null, inlineFile: null, fileViewer: null })
})

describe('FileOpenMenu — escolha popup × inline', () => {
  const menu = { x: 10, y: 10, path: '/tmp/proj/nota.md', kind: 'markdown' as const, projectId: 7, localId: 's1' }

  it('mostra as duas opções e o nome do arquivo', () => {
    useStore.setState({ fileMenu: menu })
    render(<FileOpenMenu />)
    expect(screen.getByText('nota.md')).toBeTruthy()
    expect(screen.getByText('Abrir em popup')).toBeTruthy()
    expect(screen.getByText('Ver inline no chat')).toBeTruthy()
  })

  it('"Ver inline no chat" seta inlineFile da sessão e fecha o menu', () => {
    useStore.setState({ fileMenu: menu })
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Ver inline no chat'))
    expect(useStore.getState().inlineFile).toEqual({ localId: 's1', path: '/tmp/proj/nota.md', kind: 'markdown', projectId: 7 })
    expect(useStore.getState().fileMenu).toBeNull()
    expect(useStore.getState().fileViewer).toBeNull() // popup NÃO abriu
  })

  it('"Abrir em popup" mantém o comportamento clássico (fileViewer)', () => {
    useStore.setState({ fileMenu: menu })
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Abrir em popup'))
    expect(useStore.getState().fileViewer).toEqual({ path: '/tmp/proj/nota.md', kind: 'markdown', projectId: 7 })
    expect(useStore.getState().inlineFile).toBeNull()
  })

  it('sem localId (fora de sessão) não oferece o inline', () => {
    useStore.setState({ fileMenu: { ...menu, localId: undefined } })
    render(<FileOpenMenu />)
    expect(screen.getByText('Abrir em popup')).toBeTruthy()
    expect(screen.queryByText('Ver inline no chat')).toBeNull()
  })
})

describe('InlineFileView — painel dockado', () => {
  it('mostra o conteúdo do arquivo e fecha no ✕', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('conteúdo do arquivo', { status: 200 }))
    useStore.setState({ inlineFile: { localId: 's1', path: '/tmp/proj/nota.txt', kind: 'text', projectId: 7 } })
    render(<InlineFileView localId="s1" />)
    expect(screen.getByTestId('inline-file-view')).toBeTruthy()
    expect(screen.getByText('nota.txt')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('conteúdo do arquivo')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Fechar'))
    expect(useStore.getState().inlineFile).toBeNull()
  })

  it('só aparece na sessão dona (escopo por localId)', () => {
    useStore.setState({ inlineFile: { localId: 's1', path: '/tmp/a.txt', kind: 'text' } })
    render(<InlineFileView localId="OUTRA" />)
    expect(screen.queryByTestId('inline-file-view')).toBeNull()
  })
})

describe('InlineFileView — redimensionar (arrastar a alça)', () => {
  const open = () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 200 }))
    useStore.setState({ inlineFile: { localId: 's1', path: '/tmp/a.txt', kind: 'text' } })
    return render(<InlineFileView localId="s1" />)
  }
  afterEach(() => localStorage.clear())

  // O jsdom não tem PointerEvent nem captura de ponteiro. O polyfill é o mínimo
  // para os eventos carregarem clientY/pointerId; a captura vira um espião.
  beforeAll(() => {
    if (!('PointerEvent' in window)) {
      class PointerEventPolyfill extends MouseEvent {
        pointerId: number
        constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
      }
      ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill
    }
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
  })

  /**
   * Os eventos vão para a ALÇA, não para a window: é o que a captura de ponteiro
   * garante no navegador. Sem ela, arrastar por cima do iframe de um HTML ou PDF
   * entregava o movimento e o "soltar" ao documento do iframe — o painel parava
   * de acompanhar e a página ficava presa com cursor de resize e sem seleção.
   */
  const arrastar = (handle: Element, de: number, para: number) => {
    fireEvent.pointerDown(handle, { clientY: de, pointerId: 7 })
    fireEvent.pointerMove(handle, { clientY: para, pointerId: 7 })
    fireEvent.pointerUp(handle, { clientY: para, pointerId: 7 })
  }

  it('arrastar pra CIMA expande, solta persiste a proporção no localStorage', () => {
    open()
    const panel = screen.getByTestId('inline-file-view')
    expect(parseFloat(panel.style.maxHeight)).toBeCloseTo(42, 0) // default 42vh
    arrastar(document.querySelector('.inline-file__resizer')!, 500, 400) // 100px pra cima
    const esperado = 42 + (100 / window.innerHeight) * 100
    expect(parseFloat(panel.style.maxHeight)).toBeCloseTo(esperado, 0)
    expect(parseFloat(localStorage.getItem('claudinei:inlineFileFrac')!)).toBeCloseTo(esperado / 100, 1)
  })

  it('o arrasto captura o ponteiro na alça (senão um iframe no caminho engole o movimento)', () => {
    open()
    const handle = document.querySelector('.inline-file__resizer') as HTMLElement
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 7 })
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7)
    fireEvent.pointerUp(handle, { clientY: 500, pointerId: 7 })
  })

  it('soltar libera a página: cursor e seleção de texto voltam ao normal', () => {
    open()
    const handle = document.querySelector('.inline-file__resizer')!
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 7 })
    expect(document.body.style.cursor).toBe('row-resize')
    fireEvent.pointerUp(handle, { clientY: 500, pointerId: 7 })
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('perder a captura (alt-tab, janela some) também encerra o arrasto', () => {
    open()
    const handle = document.querySelector('.inline-file__resizer')!
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 7 })
    fireEvent.lostPointerCapture(handle, { pointerId: 7 }) // borbulha, como no navegador
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('novo inline reabre com a proporção deixada pelo usuário', () => {
    localStorage.setItem('claudinei:inlineFileFrac', '0.6')
    open()
    expect(parseFloat(screen.getByTestId('inline-file-view').style.maxHeight)).toBeCloseTo(60, 0)
  })

  it('duplo clique na alça restaura o padrão', () => {
    localStorage.setItem('claudinei:inlineFileFrac', '0.7')
    open()
    fireEvent.doubleClick(document.querySelector('.inline-file__resizer')!)
    expect(parseFloat(screen.getByTestId('inline-file-view').style.maxHeight)).toBeCloseTo(42, 0)
    expect(parseFloat(localStorage.getItem('claudinei:inlineFileFrac')!)).toBeCloseTo(0.42, 2)
  })
})

describe('InlineFileView — fechar com edição pendente', () => {
  const abrir = () => useStore.setState({
    inlineFile: { localId: 's1', path: '/tmp/proj/nota.md', kind: 'markdown', projectId: 7 },
    fileEditDirty: true,
  })

  it('o ✕ com alteração não salva pede confirmação e não fecha', async () => {
    abrir()
    render(<InlineFileView localId="s1" />)
    fireEvent.click(screen.getByLabelText('Fechar'))
    expect(await screen.findByText(/Descartar alterações/i)).toBeTruthy()
    expect(useStore.getState().inlineFile).not.toBeNull()
  })

  it('confirmando o descarte, fecha', async () => {
    abrir()
    render(<InlineFileView localId="s1" />)
    fireEvent.click(screen.getByLabelText('Fechar'))
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar' }))
    await waitFor(() => expect(useStore.getState().inlineFile).toBeNull())
  })

  it('sem alteração pendente, o ✕ fecha direto', () => {
    abrir()
    useStore.setState({ fileEditDirty: false })
    render(<InlineFileView localId="s1" />)
    fireEvent.click(screen.getByLabelText('Fechar'))
    expect(useStore.getState().inlineFile).toBeNull()
  })
})

/**
 * HTML renderizado e PDF são iframes: não têm altura própria para o painel
 * acompanhar. Com só max-height, arrastar a alça mudava o teto e nada na tela —
 * medido: teto de 46vh para 74vh, painel parado em 325px. Esses conteúdos
 * precisam de altura EXPLÍCITA; texto e markdown continuam só com teto, para
 * um arquivo de três linhas não abrir num painel alto e vazio.
 */
describe('InlineFileView — altura de conteúdo embutido (iframe)', () => {
  afterEach(() => localStorage.clear())
  const abrir = (path: string, kind: 'code' | 'pdf' | 'text' | 'markdown') => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 200 }))
    useStore.setState({ inlineFile: { localId: 's1', path, kind, projectId: 1 } })
    render(<InlineFileView localId="s1" />)
    return screen.getByTestId('inline-file-view')
  }

  it('HTML ocupa a altura escolhida (height), não só um teto', () => {
    const panel = abrir('/tmp/p/pagina.html', 'code')
    expect(parseFloat(panel.style.height)).toBeCloseTo(42, 0)
    expect(panel.style.maxHeight).toBe('')
  })

  it('PDF também', () => {
    const panel = abrir('/tmp/p/doc.pdf', 'pdf')
    expect(parseFloat(panel.style.height)).toBeCloseTo(42, 0)
  })

  it('código que não é HTML continua só com teto (tem altura própria)', () => {
    const panel = abrir('/tmp/p/app.ts', 'code')
    expect(panel.style.height).toBe('')
    expect(parseFloat(panel.style.maxHeight)).toBeCloseTo(42, 0)
  })

  it('markdown continua só com teto', () => {
    const panel = abrir('/tmp/p/nota.md', 'markdown')
    expect(panel.style.height).toBe('')
  })
})
