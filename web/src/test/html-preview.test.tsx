import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileViewerModal } from '../components/FileViewerModal'
import { useStore } from '../store'
import { htmlFormTools } from '../../../shared/html-form'

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
function mockFetch(opts?: { preview?: () => Promise<Response>; fonte?: string; hash?: string; channel?: string }) {
  const chamadas: { url: string; body?: unknown }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    chamadas.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/files/preview') {
      return opts?.preview
        ? opts.preview()
        : new Response(JSON.stringify({ url: PREVIEW_URL, channel:opts?.channel }), { status: 200 })
    }
    if (url === '/api/files/write') return new Response(JSON.stringify({ hash:'hash-novo' }), { status:200 })
    return new Response(opts?.fonte ?? '<!doctype html><h1>Oi</h1>', {
      status: 200, headers: opts?.hash ? { 'X-Content-Hash': opts.hash } : {},
    })
  })
  return chamadas
}

const iframe = () => document.querySelector('iframe') as HTMLIFrameElement | null
const botao = (nome: RegExp) => screen.getByRole('button', { name: nome })

beforeEach(() => useStore.setState({ fileViewer: null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('arquivo HTML no visualizador', () => {
  it('preencher mostra Salvar sem Editar; só aceita eventos do iframe/canal atual e exige clique para gravar', async () => {
    const source = '<input id="check" type="checkbox">'
    const calls = mockFetch({ fonte:source, hash:'hash-lido', channel:'canal-atual' })
    abrirHtml()
    render(<FileViewerModal />)
    await screen.findByRole('button', {name:/Editar/})
    const doc = new DOMParser().parseFromString(source,'text/html')
    const fields = htmlFormTools(doc).read()
    const message = (kind: string, sender: MessageEventSource | null, channel = 'canal-atual') => fireEvent(window, new MessageEvent('message', {
      source:sender, origin:'null', data:{type:'claudinei:html-form',kind,channel,hash:'hash-lido',fields},
    }))
    message('ready',window)
    message('change',window)
    expect(screen.queryByRole('button',{name:'Salvar'})).toBeNull()
    message('ready',iframe()!.contentWindow)
    fields[0].checked = true
    message('change',iframe()!.contentWindow,'outro-canal')
    expect(screen.queryByRole('button',{name:'Salvar'})).toBeNull()
    message('change',iframe()!.contentWindow)
    expect(screen.getByRole('button',{name:'Salvar'})).toBeTruthy()
    expect(document.querySelector('.html-editor')).toBeNull()
    expect(calls.some(call => call.url === '/api/files/write')).toBe(false)
    fireEvent.click(screen.getByRole('button',{name:'Salvar'}))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    const body = calls.find(call => call.url === '/api/files/write')!.body as Record<string, unknown>
    expect(body).toMatchObject({path:'/tmp/p/review/index.html',projectId:7,baseHash:'hash-lido'})
    expect(new DOMParser().parseFromString(String(body.content),'text/html').querySelector('input')!.hasAttribute('checked')).toBe(true)
  })

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

  it('o lápis na Página abre edição visual isolada, sem executar scripts', async () => {
    mockFetch({ hash: 'hash-lido' })
    abrirHtml()
    render(<FileViewerModal />)
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    const visual = screen.getByTitle('Edição visual de index.html') as HTMLIFrameElement
    // jsdom does not implement focusing a nested window; the browser check does.
    visual.contentWindow!.focus = vi.fn()
    expect(visual.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(visual.getAttribute('srcdoc')).toContain("script-src 'none'")
    expect(screen.getByRole('button', { name: 'Negrito' })).toBeTruthy()
    expect(document.querySelector('.code-editor')).toBeNull()
  })

  it('sem hash mantém a Página legível e não oferece gravação insegura', async () => {
    mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(PREVIEW_URL))
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull()
  })

  it('a página vem da URL emitida para o arquivo aberto', async () => {
    const chamadas = mockFetch()
    abrirHtml()
    render(<FileViewerModal />)
    await waitFor(() => expect(iframe()?.getAttribute('src')).toBe(PREVIEW_URL))
    expect(chamadas.find((c) => c.url === '/api/files/preview')).toMatchObject({
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
