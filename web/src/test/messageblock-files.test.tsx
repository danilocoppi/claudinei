import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MessageBlock } from '../components/MessageBlock'
import { FileOpenMenu } from '../components/FileOpenMenu'
import { useStore } from '../store'

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStore.setState({ projects: [], sessions: {}, chat: {}, fileResolved: {}, fileMenu: null, inlineFile: null })
})

// clique no link agora abre o menu de contexto; escolher "Abrir em popup" chama openFile
const clickAndChoosePopup = (link: Element) => {
  fireEvent.click(link)
  fireEvent.click(screen.getByText('Abrir em popup'))
}

describe('MessageBlock — paths de arquivo clicáveis', () => {
  it('path confirmado (exists+inScope) vira .file-link clicável e abre o FileViewerModal', async () => {
    useStore.setState({
      sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    const openFile = vi.fn()
    useStore.setState({ openFile })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: 'src/components/App.tsx', exists: true, inScope: true, kind: 'code', size: 10 }]),
    )

    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'veja src/components/App.tsx por favor' }} currentLocalId="s1" /><FileOpenMenu /></>)

    const link = await waitFor(() => {
      const el = document.querySelector('.file-link')
      expect(el).toBeTruthy()
      return el as HTMLAnchorElement
    })
    expect(link.textContent).toBe('src/components/App.tsx')

    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('src/components/App.tsx', 'code', 7)
  })

  it('path NÃO confirmado (inScope:false) fica texto puro, sem .file-link', async () => {
    useStore.setState({
      sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: 'src/components/App.tsx', exists: false, inScope: false }]),
    )

    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'veja src/components/App.tsx por favor' }} currentLocalId="s1" /><FileOpenMenu /></>)

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(await screen.findByText(/src\/components\/App\.tsx/)).toBeTruthy()
    expect(document.querySelector('.file-link')).toBeNull()
  })

  it('sem confirmação ainda (resolve pendente) o path aparece como texto puro', () => {
    useStore.setState({
      sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {})) // nunca resolve

    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'veja src/components/App.tsx por favor' }} currentLocalId="s1" /><FileOpenMenu /></>)

    expect(screen.getByText(/src\/components\/App\.tsx/)).toBeTruthy()
    expect(document.querySelector('.file-link')).toBeNull()
  })

  // Bug real: o agente escreve o path como LINK markdown ([/x/plano.md](/x/plano.md)).
  // O rehypeFilePaths pula texto dentro de <a>, e o ramo genérico renderizava
  // <a href target=_blank> → clicar NAVEGAVA pra uma página nova em vez do modal.
  it('link markdown cujo href é um path confirmado abre o modal (não navega)', async () => {
    useStore.setState({
      sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    const openFile = vi.fn()
    useStore.setState({ openFile })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: '/tmp/proj/plano.md', exists: true, inScope: true, kind: 'markdown', size: 10 }]),
    )

    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'Plano: [/tmp/proj/plano.md](/tmp/proj/plano.md)' }} currentLocalId="s1" /><FileOpenMenu /></>)

    // o resolve re-renderiza e o react-markdown RECRIA o anchor — clicar no nó atual
    await waitFor(() => expect(Object.keys(useStore.getState().fileResolved)).toContain('/tmp/proj/plano.md'))
    const link = await waitFor(() => {
      const el = document.querySelector('.file-link') as HTMLAnchorElement
      expect(el?.isConnected).toBe(true)
      return el
    })
    expect(link.textContent).toBe('/tmp/proj/plano.md')
    expect(link.getAttribute('href')).toBe('#') // não aponta pro path — nada de navegar
    expect(link.getAttribute('target')).toBeNull()
    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('/tmp/proj/plano.md', 'markdown', 7)
  })

  it('link markdown com href de arquivo SEM barra ([notas.md](notas.md)) também resolve e abre o modal', async () => {
    useStore.setState({
      sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    const openFile = vi.fn()
    useStore.setState({ openFile })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: 'notas.md', exists: true, inScope: true, kind: 'markdown', size: 5 }]),
    )

    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'veja [notas.md](notas.md)' }} currentLocalId="s1" /><FileOpenMenu /></>)

    await waitFor(() => expect(Object.keys(useStore.getState().fileResolved)).toContain('notas.md'))
    const link = await waitFor(() => {
      const el = document.querySelector('.file-link') as HTMLAnchorElement
      expect(el?.isConnected).toBe(true)
      return el
    })
    // o href do link markdown entrou no lote do resolve
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body.paths).toContain('notas.md')
    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('notas.md', 'markdown', 7)
  })

  it('link markdown web ([site](https://example.com)) mantém o href mas quem abre é a CONFIRMAÇÃO', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'veja [site](https://example.com)' }} />)
    const link = screen.getByText('site') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com')
    expect(link.getAttribute('target')).toBeNull() // sem _blank: o popup de confirmação decide
    expect(link.className).not.toContain('file-link')
    fireEvent.click(link)
    expect(useStore.getState().externalLink).toBe('https://example.com')
    useStore.setState({ externalLink: null })
  })

  it('regressão: link http normal continua renderizando como <a> externo clicável', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'veja https://example.com/doc' }} />)
    const link = screen.getByText('https://example.com/doc') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://example.com/doc')
    expect(link.className).not.toContain('file-link')
  })

  it('regressão: bloco de código continua renderizando sem virar link', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: '```\nsrc/components/App.tsx\n```' }} />)
    // o path aparece dentro do <code>, não vira .file-link
    expect(document.querySelector('.file-link')).toBeNull()
    expect(document.querySelector('pre code')?.textContent).toContain('src/components/App.tsx')
  })
})

describe('link local SEMPRE abre o popup (nunca navega)', () => {
  const sess1 = () => useStore.setState({
    sessions: { s1: { localId: 's1', projectId: 7, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
  })

  it('href com sufixo de linha (arquivo.md:12) resolve o path LIMPO e abre o modal', async () => {
    sess1()
    const openFile = vi.fn()
    useStore.setState({ openFile })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: '/tmp/proj/plano.md', exists: true, inScope: true, kind: 'markdown', size: 10 }]),
    )
    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'Atualizei o [plano.md:12](/tmp/proj/plano.md:12)' }} currentLocalId="s1" /><FileOpenMenu /></>)
    await waitFor(() => expect(Object.keys(useStore.getState().fileResolved)).toContain('/tmp/proj/plano.md'))
    const link = await waitFor(() => {
      const el = document.querySelector('.file-link') as HTMLAnchorElement
      expect(el?.isConnected).toBe(true)
      return el
    })
    // o lote do resolve recebeu o path SEM o :12
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))
    expect(body.paths).toContain('/tmp/proj/plano.md')
    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('/tmp/proj/plano.md', 'markdown', 7)
  })

  it('href file:// abre o modal (não navega)', async () => {
    sess1()
    const openFile = vi.fn()
    useStore.setState({ openFile })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: '/tmp/proj/nota.md', exists: true, inScope: true, kind: 'markdown', size: 5 }]),
    )
    render(<><MessageBlock item={{ kind: 'assistant_text', text: 'veja [nota](file:///tmp/proj/nota.md)' }} currentLocalId="s1" /><FileOpenMenu /></>)
    await waitFor(() => expect(Object.keys(useStore.getState().fileResolved)).toContain('/tmp/proj/nota.md'))
    const link = await waitFor(() => {
      const el = document.querySelector('.file-link') as HTMLAnchorElement
      expect(el?.isConnected).toBe(true)
      return el
    })
    expect(link.getAttribute('target')).toBeNull()
    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('/tmp/proj/nota.md', 'markdown', 7)
  })

  it('href local NÃO confirmado ainda vira popup (tipo por extensão; o modal mostra o erro)', async () => {
    sess1()
    const openFile = vi.fn()
    useStore.setState({ openFile })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson([{ path: '/fora/do/escopo.md', exists: false, inScope: false }]),
    )
    render(<><MessageBlock item={{ kind: 'assistant_text', text: '[escopo.md](/fora/do/escopo.md)' }} currentLocalId="s1" /><FileOpenMenu /></>)
    await waitFor(() => expect(Object.keys(useStore.getState().fileResolved)).toContain('/fora/do/escopo.md'))
    const link = await waitFor(() => {
      const el = document.querySelector('.file-link') as HTMLAnchorElement
      expect(el?.isConnected).toBe(true)
      return el
    })
    expect(link).toBeTruthy() // continua sendo popup, NÃO um <a target=_blank> quebrado
    expect(link.getAttribute('href')).toBe('#')
    clickAndChoosePopup(link)
    expect(openFile).toHaveBeenCalledWith('/fora/do/escopo.md', 'markdown', 7)
  })
})

describe('link externo pede confirmação (segurança)', () => {
  it('clicar num link web NÃO navega: seta externalLink no store (popup de confirmação)', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'veja [site](https://example.com/x)' }} />)
    const link = screen.getByText('site') as HTMLAnchorElement
    expect(link.getAttribute('target')).toBeNull() // sem target: quem abre é a confirmação
    fireEvent.click(link)
    expect(useStore.getState().externalLink).toBe('https://example.com/x')
    useStore.setState({ externalLink: null })
  })
})

describe('bloco de código com botão de copiar', () => {
  it('fenced code (sugestão de comando) copia o conteúdo cru com 1 clique', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'rode:\n```bash\ncd ~/x && npm run package\n```' }} />)
    const btn = document.querySelector('.copy-wrap .copy-btn')!
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('cd ~/x && npm run package'))
  })
})
