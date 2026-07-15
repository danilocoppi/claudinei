import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileViewerModal } from '../components/FileViewerModal'
import { useStore } from '../store'
import { fileContentUrl } from '../files'

function open(kind: 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'binary', path = '/p/a.txt', projectId = 1) {
  useStore.setState({ fileViewer: { path, kind, projectId } })
}

beforeEach(() => {
  useStore.setState({ fileViewer: null })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FileViewerModal', () => {
  it('fileViewer null → não renderiza nada', () => {
    const { container } = render(<FileViewerModal />)
    expect(container.firstChild).toBeNull()
  })

  it('kind image → <img> apontando pro content URL (sem fetch)', () => {
    vi.spyOn(globalThis, 'fetch')
    open('image', '/p/logo.png', 1)
    render(<FileViewerModal />)
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toContain(encodeURIComponent('/p/logo.png'))
    expect(img.src).toContain(fileContentUrl('/p/logo.png', 1))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('kind pdf → <iframe> apontando pro content URL', () => {
    open('pdf', '/p/doc.pdf', 1)
    render(<FileViewerModal />)
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    expect(iframe.src).toContain(fileContentUrl('/p/doc.pdf', 1))
  })

  it('kind binary → "sem preview" + link de download (sem fetch)', () => {
    vi.spyOn(globalThis, 'fetch')
    open('binary', '/p/bin.dat', 1)
    render(<FileViewerModal />)
    expect(screen.getByText('Sem prévia disponível.')).toBeTruthy()
    const links = screen.getAllByText('Baixar') as HTMLAnchorElement[]
    expect(links.length).toBeGreaterThan(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('kind markdown → busca o texto e renderiza no container .markdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('# Título\n\ntexto', { status: 200 }),
    )
    open('markdown', '/p/readme.md', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(document.querySelector('.markdown')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Título')).toBeTruthy())
  })

  it('kind text → busca o texto e renderiza em <pre>', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('linha 1\nlinha 2', { status: 200 }),
    )
    open('text', '/p/notas.txt', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy())
    expect(document.querySelector('pre')?.textContent).toContain('linha 1')
  })

  it('kind code → busca o texto e renderiza em <pre>', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('const x = 1', { status: 200 }),
    )
    open('code', '/p/index.ts', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('const x = 1'))
  })

  it('loading → mostra o estado de carregamento antes do fetch resolver', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    )
    open('text', '/p/notas.txt', 1)
    render(<FileViewerModal />)
    expect(screen.getByText('Carregando…')).toBeTruthy()
    resolveFetch(new Response('ok', { status: 200 }))
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy())
  })

  it('erro 404 → "arquivo não encontrado"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }))
    open('text', '/p/sumiu.txt', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(screen.getByText('Arquivo não encontrado.')).toBeTruthy())
  })

  it('erro 403 → "sem permissão"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 403 }))
    open('code', '/p/segredo.ts', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(screen.getByText('Sem permissão para acessar este arquivo.')).toBeTruthy())
  })

  it('erro 413 → "grande demais, baixe" + link de download', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 413 }))
    open('text', '/p/gigante.txt', 1)
    render(<FileViewerModal />)
    await waitFor(() => expect(screen.getByText(/grande demais/i)).toBeTruthy())
    expect(screen.getAllByText('Baixar').length).toBeGreaterThan(0)
  })

  it('Esc fecha (chama closeFile)', () => {
    open('image', '/p/logo.png', 1)
    render(<FileViewerModal />)
    expect(useStore.getState().fileViewer).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().fileViewer).toBeNull()
  })

  it('clicar no backdrop fecha', () => {
    open('image', '/p/logo.png', 1)
    render(<FileViewerModal />)
    fireEvent.click(document.querySelector('.modal-overlay') as HTMLElement)
    expect(useStore.getState().fileViewer).toBeNull()
  })

  it('header mostra nome do arquivo e o caminho completo', () => {
    open('image', '/p/sub/logo.png', 1)
    render(<FileViewerModal />)
    expect(screen.getByText('logo.png')).toBeTruthy()
    expect(screen.getByText('/p/sub/logo.png')).toBeTruthy()
  })
})
