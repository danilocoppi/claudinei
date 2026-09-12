import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileViewerModal } from '../components/FileViewerModal'
import { useStore } from '../store'

/**
 * HTML tem duas leituras legítimas: o fonte e a PÁGINA. Até aqui o visualizador
 * só dava o fonte — abrir o `index.html` de uma galeria mostrava uma linha de
 * markup minificado, e não o que a página virou.
 *
 * A página renderizada entra num iframe isolado. O `sandbox` sem
 * `allow-same-origin` não é detalhe de implementação: sem ele, um HTML com
 * script (e HTML escrito por agente costuma ter) rodaria na origem do Claudinei,
 * com a sessão de quem abriu, contra uma API que executa comandos.
 */
const PREVIEW_URL = '/api/files/preview/tok123/tmp/p/review/index.html'

const abrirHtml = (path = '/tmp/p/review/index.html') =>
  useStore.setState({ fileViewer: { path, kind: 'code', projectId: 7 } })

/** fetch dublê: separa a emissão do preview (POST) da leitura do fonte (GET). */
function mockFetch(opts?: { preview?: () => Promise<Response>; fonte?: string }) {
  const chamadas: { url: string; body?: unknown }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    chamadas.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/files/preview') {
      return opts?.preview
        ? opts.preview()
        : new Response(JSON.stringify({ url: PREVIEW_URL }), { status: 200 })
    }
    return new Response(opts?.fonte ?? '<!doctype html><h1>Oi</h1>', { status: 200 })
  })
  return chamadas
}

const iframe = () => document.querySelector('iframe') as HTMLIFrameElement | null
const botao = (nome: RegExp) => screen.getByRole('button', { name: nome })

beforeEach(() => useStore.setState({ fileViewer: null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('arquivo HTML no visualizador', () => {
  it('oferece as duas leituras: página e fonte', async () => {
    mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    expect(botao(/página/i)).toBeTruthy()
    expect(botao(/fonte/i)).toBeTruthy()
  })

  /** Quem abre um HTML quer ver como ficou; o fonte fica a um clique. */
  it('abre na página, não no fonte', async () => {
    mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()).toBeTruthy())
    expect(botao(/página/i).getAttribute('aria-pressed')).toBe('true')
  })

  it('a página vem da URL emitida para o arquivo aberto', async () => {
    const chamadas = mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(PREVIEW_URL))
    expect(chamadas[0]).toMatchObject({
      url: '/api/files/preview',
      body: { path: '/tmp/p/review/index.html', projectId: 7 },
    })
  })

  it('o iframe é sandbox e NÃO recebe same-origin', async () => {
    mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()).toBeTruthy())
    const sandbox = iframe()!.getAttribute('sandbox')
    expect(sandbox, 'iframe sem sandbox = HTML do disco na origem do app').not.toBeNull()
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox, 'allow-same-origin daria a sessão do operador ao HTML').not.toContain('allow-same-origin')
  })

  it('botão Fonte mostra o código, colorido como qualquer outro arquivo', async () => {
    mockFetch({ fonte: '<!doctype html><h1>Oi</h1>' })
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()).toBeTruthy())
    fireEvent.click(botao(/fonte/i))
    await waitFor(() => expect(document.querySelector('.code-preview')?.textContent).toContain('<h1>Oi</h1>'))
    expect(botao(/fonte/i).getAttribute('aria-pressed')).toBe('true')
  })

  /** Voltar para a página não pode recarregá-la: recarregar perde o que o
   *  operador já tinha feito ali (rolagem, filtro, aba interna da própria página). */
  it('ir ao fonte e voltar não reemite nem recarrega a página', async () => {
    const chamadas = mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()).toBeTruthy())
    const antes = iframe()
    fireEvent.click(botao(/fonte/i))
    fireEvent.click(botao(/página/i))
    expect(iframe()).toBe(antes)
    expect(chamadas.filter((c) => c.url === '/api/files/preview')).toHaveLength(1)
  })

  it('se a emissão falhar, avisa e o fonte continua acessível', async () => {
    mockFetch({ preview: async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) })
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(screen.getByText(/não foi possível/i)).toBeTruthy())
    fireEvent.click(botao(/fonte/i))
    await waitFor(() => expect(document.querySelector('.code-preview')).toBeTruthy())
  })

  it('trocar de arquivo troca a página (não fica a do anterior)', async () => {
    const chamadas = mockFetch()
    abrirHtml()
    const { rerender } = render(<FileViewerModal />)
    await waitFor(() => expect(iframe()).toBeTruthy())
    abrirHtml('/tmp/p/outro/pagina.html')
    rerender(<FileViewerModal />)
    await waitFor(() =>
      expect(chamadas.filter((c) => c.url === '/api/files/preview')).toHaveLength(2))
    expect(chamadas.at(-1)).toMatchObject({ body: { path: '/tmp/p/outro/pagina.html' } })
  })
})

describe('os outros tipos seguem como eram', () => {
  it('arquivo de código comum não ganha alternância nem emite preview', async () => {
    const chamadas = mockFetch({ fonte: 'const x = 1' })
    useStore.setState({ fileViewer: { path: '/tmp/p/app.ts', kind: 'code', projectId: 7 } })
    render(<FileViewerModal />)
    await waitFor(() => expect(document.querySelector('.code-preview')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /página/i })).toBeNull()
    expect(chamadas.some((c) => c.url === '/api/files/preview')).toBe(false)
  })
})
