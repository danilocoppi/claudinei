import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('arrastar pra CIMA expande, solta persiste a proporção no localStorage', () => {
    open()
    const panel = screen.getByTestId('inline-file-view')
    expect(parseFloat(panel.style.maxHeight)).toBeCloseTo(42, 0) // default 42vh
    const handle = document.querySelector('.inline-file__resizer')!
    fireEvent.mouseDown(handle, { clientY: 500 })
    fireEvent.mouseMove(window, { clientY: 400 }) // 100px pra cima
    fireEvent.mouseUp(window)
    const esperado = 42 + (100 / window.innerHeight) * 100
    expect(parseFloat(panel.style.maxHeight)).toBeCloseTo(esperado, 0)
    expect(parseFloat(localStorage.getItem('claudinei:inlineFileFrac')!)).toBeCloseTo(esperado / 100, 1)
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
