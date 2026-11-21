import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { ChatItem, ClaudeEvent, EngineMeta, HistoryPage, SessionInfo } from '../types'

/**
 * A conversa numa lista virtual (react-virtuoso). O jsdom não tem layout: o
 * `VirtuosoMockContext` fixa a altura da janela e de cada item, e a rolagem do
 * operador é simulada plantando `scrollTop`/`scrollHeight` na caixa e
 * disparando `scroll`, como faz o navegador.
 */
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }
const ws = { send: () => {} } as never

const ALTURA_JANELA = 600
const ALTURA_ITEM = 60
/** Posição (byte) do primeiro item na tela: as páginas antigas vêm antes dela. */
const TOPO = 100_000

const fala = (pos: number): ChatItem => ({ kind: 'assistant_text', text: `fala ${pos}`, key: `p${pos}` })
const acao = (pos: number): ChatItem => ({ kind: 'tool_call', id: `t${pos}`, name: 'Bash', input: {}, result: 'ok', key: `p${pos}` })
const conversa = (n: number, primeiro = TOPO) => Array.from({ length: n }, (_, i) => fala(primeiro + i * 10))

const evFala = (pos: number): ClaudeEvent =>
  ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'text', text: `antiga ${pos}` }] }, raw: {} })
const evPedido = (pos: number): ClaudeEvent =>
  ({ kind: 'user', pos, message: { role: 'user', content: [{ type: 'text', text: `pedido ${pos}` }] }, raw: {} })
const evAcao = (pos: number): ClaudeEvent =>
  ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${pos}`, name: 'Bash', input: {} }] }, raw: {} })

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const historyCalls = () =>
  (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(([url]) => String(url)).filter((u) => u.includes('/history'))

const esperar = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

function preparar(items: ChatItem[], cursor = { before: TOPO, atStart: false, conv: 'c' }, status: SessionInfo['status'] = 'idle') {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [], sessions: { s1: { ...sess, status } },
    chat: { s1: items }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    historyCursor: { s1: cursor }, folds: {}, orphanResults: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
}

async function montar() {
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: ALTURA_JANELA, itemHeight: ALTURA_ITEM }}>
      <WsContext.Provider value={ws}><ChatView /></WsContext.Provider>
    </VirtuosoMockContext.Provider>,
  )
  await esperar()
}

const caixa = () => screen.getByTestId('chat-scroll')
const chaves = () => [...document.querySelectorAll<HTMLElement>('.chat-entry')].map((e) => e.dataset.key!)

/** O operador rola até `top` (px a partir do começo da lista). */
async function rolar(top: number) {
  const el = caixa()
  const total = useStore.getState().chat.s1.length * ALTURA_ITEM
  for (const [k, v] of Object.entries({ scrollTop: top, scrollHeight: total, clientHeight: ALTURA_JANELA })) {
    Object.defineProperty(el, k, { value: v, configurable: true, writable: true })
  }
  fireEvent.scroll(el)
  await esperar()
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json([]))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('a conversa numa lista virtual', () => {
  it('com 3000 itens monta só os perto da tela', async () => {
    preparar(conversa(3000))
    await montar()
    const n = document.querySelectorAll('.chat-entry').length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(60)
    // Abre no fim da conversa.
    expect(chaves().at(-1)).toBe(`p${TOPO + 2999 * 10}`)
  })

  it('o histórico que chega depois de abrir também abre no fim', async () => {
    preparar([])
    await montar()
    act(() => { useStore.setState({ chat: { s1: conversa(300) } }) })
    await esperar()
    expect(chaves().at(-1)).toBe(`p${TOPO + 299 * 10}`)
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
  })

  it('chegar ao topo pede a página anterior com before do cursor e limit 200', async () => {
    preparar(conversa(100))
    // O pedido fica pendente: enquanto isso, nenhum outro sai.
    let responder = (_r: Response) => {}
    vi.mocked(globalThis.fetch).mockImplementation(() => new Promise((r) => { responder = r }))
    await montar()
    await rolar(0)
    expect(historyCalls()).toEqual([`/api/sessions/s1/history?before=${TOPO}&limit=200`])
    expect(screen.getByText('carregando mensagens anteriores…')).toBeTruthy()
    await rolar(ALTURA_ITEM * 40)
    await rolar(0)
    expect(historyCalls(), 'um pedido por vez').toHaveLength(1)
    responder(json({ events: [], before: 0, atStart: true }))
    await esperar()
    expect(screen.queryByText('carregando mensagens anteriores…')).toBeNull()
  })

  it('acrescentar no topo mantém o item que estava na tela', async () => {
    preparar(conversa(100))
    const pagina: HistoryPage = { events: Array.from({ length: 30 }, (_, i) => evFala(1000 + i * 10)), before: 1000, atStart: false }
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => json(String(url).includes('/history') ? pagina : []))
    await montar()
    await rolar(0)
    const antes = chaves()
    expect(antes[0]).toBe(`p${TOPO}`)
    // Chegaram 30 itens acima; a tela continua nos mesmos itens.
    await esperar()
    expect(useStore.getState().chat.s1).toHaveLength(130)
    const depois = chaves()
    expect(depois).toEqual(expect.arrayContaining(antes))
    expect(depois.at(-1)).toBe(antes.at(-1))
    expect(useStore.getState().historyCursor.s1).toMatchObject({ before: 1000, atStart: false })
  })

  it('acrescentar no topo com fusão de grupo de ações mantém o item que estava na tela', async () => {
    // Na tela, o topo é um grupo de ações; a página antiga termina em ações, que
    // entram no MESMO grupo — 3 itens novos, mas só 1 nó novo (o pedido).
    preparar([acao(TOPO), acao(TOPO + 10), acao(TOPO + 20), ...conversa(100, TOPO + 30)])
    const pagina: HistoryPage = { events: [evPedido(1000), evAcao(1010), evAcao(1020)], before: 1000, atStart: true }
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => json(String(url).includes('/history') ? pagina : []))
    await montar()
    await rolar(0)
    const antes = chaves()
    expect(antes[0]).toBe(`g:p${TOPO}`)
    await esperar()
    expect(useStore.getState().chat.s1).toHaveLength(106)
    const depois = chaves()
    // O grupo do topo agora começa na ação antiga, e continua na tela no mesmo lugar.
    expect(depois).toContain('g:p1010')
    expect(depois.at(-1)).toBe(antes.at(-1))
    expect(depois).toEqual(expect.arrayContaining(antes.slice(1)))
  })

  it('página que só engorda o grupo do topo segue para a anterior', async () => {
    // Turno longo de ações: a página antiga só traz ações, que entram no grupo
    // do topo. Nenhum nó novo: a lista não avisaria o topo de novo, e a tela
    // ficaria parada sem o resto da conversa.
    preparar([acao(TOPO), acao(TOPO + 10), acao(TOPO + 20), ...conversa(100, TOPO + 30)])
    const paginas: Record<string, HistoryPage> = {
      [TOPO]: { events: [evAcao(2000), evAcao(2010)], before: 2000, atStart: false },
      2000: { events: [evPedido(1000), evAcao(1010)], before: 1000, atStart: true },
    }
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const before = new URL(String(url), 'http://x').searchParams.get('before')
      return json(String(url).includes('/history') ? paginas[before!] : [])
    })
    await montar()
    await rolar(0)
    await esperar()
    expect(historyCalls()).toEqual([
      `/api/sessions/s1/history?before=${TOPO}&limit=200`,
      '/api/sessions/s1/history?before=2000&limit=200',
    ])
    expect(useStore.getState().chat.s1.map((it) => it.key).slice(0, 2)).toEqual(['p1000', 'p1010'])
    expect(useStore.getState().historyCursor.s1.atStart).toBe(true)
  })

  /** Páginas só de ações, sempre engordando o grupo do topo; o começo fica 10 páginas acima. */
  const sóAções = async (url: unknown) => {
    if (!String(url).includes('/history')) return json([])
    const before = Number(new URL(String(url), 'http://x').searchParams.get('before'))
    return json({ events: [evAcao(before - 20), evAcao(before - 10)], before: before - 20, atStart: before - 20 <= TOPO - 200 })
  }

  it('a sequência de páginas que só engordam o grupo para em 5 e espera voltar ao topo', async () => {
    preparar([acao(TOPO), acao(TOPO + 10), acao(TOPO + 20), ...conversa(100, TOPO + 30)])
    vi.mocked(globalThis.fetch).mockImplementation(sóAções)
    await montar()
    await rolar(0)
    await esperar(600)
    expect(historyCalls()).toHaveLength(5)
    // Saiu do topo e voltou: segue de onde parou.
    await rolar(ALTURA_ITEM * 40)
    await rolar(0)
    await esperar(600)
    expect(historyCalls()).toHaveLength(10)
    expect(historyCalls()[5]).toBe(`/api/sessions/s1/history?before=${TOPO - 100}&limit=200`)
    expect(useStore.getState().historyCursor.s1.atStart).toBe(true)
  })

  it('passado o teto da sequência, o topo oferece carregar mais; o clique segue de onde parou', async () => {
    preparar([acao(TOPO), acao(TOPO + 10), acao(TOPO + 20), ...conversa(100, TOPO + 30)])
    vi.mocked(globalThis.fetch).mockImplementation(sóAções)
    await montar()
    await rolar(0)
    await esperar(600)
    expect(historyCalls()).toHaveLength(5)
    expect(screen.queryByText('carregando mensagens anteriores…')).toBeNull()
    fireEvent.click(screen.getByText('carregar mensagens anteriores'))
    await esperar(600)
    expect(historyCalls()).toHaveLength(10)
    expect(historyCalls()[5]).toBe(`/api/sessions/s1/history?before=${TOPO - 100}&limit=200`)
    // Chegou ao começo: o convite some e fica o aviso do começo.
    expect(screen.queryByText('carregar mensagens anteriores')).toBeNull()
    expect(screen.getByText('início da conversa')).toBeTruthy()
  })

  it('depois de uma falha, o topo oferece carregar mais; o clique tenta de novo', async () => {
    preparar(conversa(100))
    let falhas = 1
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (!String(url).includes('/history')) return json([])
      if (falhas-- > 0) throw new Error('rede caiu')
      return json({ events: [evFala(1000)], before: 1000, atStart: false })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await montar()
    await rolar(0)
    await esperar(600)
    expect(historyCalls()).toHaveLength(1)
    fireEvent.click(screen.getByText('carregar mensagens anteriores'))
    await esperar(600)
    expect(historyCalls()).toHaveLength(2)
    expect(useStore.getState().chat.s1).toHaveLength(101)
    // A página entrou: o topo volta a pedir sozinho, sem convite.
    expect(screen.queryByText('carregar mensagens anteriores')).toBeNull()
  })

  it('a sequência para quando o operador troca de terminal', async () => {
    preparar([acao(TOPO), acao(TOPO + 10), acao(TOPO + 20), ...conversa(100, TOPO + 30)])
    let responder = () => {}
    // Só o histórico fica pendente: os turnos do desfazer, que o terminal novo
    // também pede ao abrir, não podem tomar o lugar do `responder`.
    vi.mocked(globalThis.fetch).mockImplementation((url) => !String(url).includes('/history')
      ? Promise.resolve(json([]))
      : new Promise((r) => { responder = () => r(sóAções(url)) }))
    await montar()
    await rolar(0)
    expect(historyCalls()).toHaveLength(1)
    act(() => {
      useStore.setState((s) => ({
        sessions: { ...s.sessions, s2: { ...sess, localId: 's2' } },
        chat: { ...s.chat, s2: conversa(10) }, historyLoadedFor: { ...s.historyLoadedFor, s2: 'c' },
        historyCursor: { ...s.historyCursor, s2: { before: TOPO, atStart: true, conv: 'c' } },
        activeLocalId: 's2',
      }))
    })
    await act(async () => { responder(); await new Promise((r) => setTimeout(r, 600)) })
    expect(historyCalls()).toHaveLength(1)
    // A página que já estava a caminho entrou na conversa dela.
    expect(useStore.getState().historyCursor.s1.before).toBe(TOPO - 20)
  })

  it('no começo mostra "início da conversa" e não pede mais', async () => {
    preparar(conversa(100), { before: TOPO, atStart: true, conv: 'c' })
    await montar()
    await rolar(0)
    expect(screen.getByText('início da conversa')).toBeTruthy()
    expect(historyCalls()).toEqual([])
  })

  it('falha ao pedir a página anterior: não marca o começo e tenta de novo ao voltar ao topo', async () => {
    preparar(conversa(100))
    let falhas = 1
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (!String(url).includes('/history')) return json([])
      if (falhas-- > 0) throw new Error('rede caiu')
      return json({ events: [evFala(1000)], before: 1000, atStart: true })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await montar()
    await rolar(0)
    await esperar(600)
    // Parado no topo, sem nova tentativa em laço.
    expect(historyCalls()).toHaveLength(1)
    expect(useStore.getState().historyCursor.s1.atStart).toBe(false)
    expect(screen.queryByText('carregando mensagens anteriores…')).toBeNull()
    expect(screen.queryByText('início da conversa')).toBeNull()
    // Saiu do topo e voltou: tenta outra vez, e agora a página entra.
    await rolar(ALTURA_ITEM * 40)
    await rolar(0)
    expect(historyCalls()).toHaveLength(2)
    expect(historyCalls()[1]).toBe(`/api/sessions/s1/history?before=${TOPO}&limit=200`)
    expect(useStore.getState().chat.s1).toHaveLength(101)
    expect(screen.getByText('início da conversa')).toBeTruthy()
  })

  it('grudado no fim acompanha item novo; solto não', async () => {
    preparar(conversa(100))
    await montar()
    const novos = (pos: number, n = 1) => act(() => {
      useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, ...conversa(n, pos)] } }))
    })
    // Mais itens do que a sobra montada abaixo da tela (600px): só aparece o
    // último se a tela desceu junto.
    novos(900_000, 20)
    await esperar()
    expect(chaves().at(-1)).toBe(`p${900_000 + 19 * 10}`)

    await rolar(ALTURA_ITEM * 20)
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()
    novos(950_000)
    await esperar()
    expect(chaves()).not.toContain('p950000')
  })

  it('chat-tofoot volta ao fim e volta a acompanhar', async () => {
    preparar(conversa(100))
    await montar()
    await rolar(ALTURA_ITEM * 20)
    expect(chaves()).not.toContain(`p${TOPO + 99 * 10}`)
    fireEvent.click(screen.getByTestId('chat-tofoot'))
    await esperar()
    expect(chaves().at(-1)).toBe(`p${TOPO + 99 * 10}`)
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, ...conversa(20, 900_000)] } })) })
    await esperar()
    expect(chaves().at(-1)).toBe(`p${900_000 + 19 * 10}`)
  })
})

/**
 * O texto do streaming cresce no rodapé da lista, não num item: a biblioteca só
 * acompanha item novo ou item que cresce. O rodapé que cresce com a tela presa
 * no fim puxa a rolagem junto; com o operador lendo mais acima, não.
 */
describe('o rodapé que cresce durante o streaming', () => {
  type Cb = (entries: { target: Element; contentRect: { height: number } }[]) => void
  let observados: { cb: Cb; alvo: Element }[]
  beforeEach(() => {
    observados = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: Cb) {}
      observe(alvo: Element) { observados.push({ cb: this.cb, alvo }) }
      unobserve() {}
      disconnect() { observados = observados.filter((o) => o.cb !== this.cb) }
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const rodape = () => document.querySelector('.chat-scroll__inner--bottom')!
  const cresce = (altura: number) => act(() => {
    for (const o of observados.filter((o) => o.alvo === rodape())) o.cb([{ target: o.alvo, contentRect: { height: altura } }])
  })
  /** Caixa com geometria controlada: devolve o scrollTop que a tela recebeu. */
  const geometria = (scrollTop: number, scrollHeight: number) => {
    const el = caixa()
    let top = scrollTop
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v }, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true, writable: true })
    Object.defineProperty(el, 'clientHeight', { value: ALTURA_JANELA, configurable: true })
    return { top: () => top, altura: (h: number) => Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true }) }
  }

  it('preso no fim, o streaming que cresce mantém a tela no fim', async () => {
    preparar(conversa(100), undefined, 'working')
    await montar()
    act(() => useStore.getState().applyWsMessage({ type: 'session_event', localId: 's1', event: { kind: 'stream', text: 'linha 1', raw: {} } }))
    expect(screen.getByTestId('streaming-preview')).toBeTruthy()
    expect(observados.some((o) => o.alvo === rodape()), 'o rodapé não é observado').toBe(true)
    cresce(20)
    const g = geometria(6000 - ALTURA_JANELA, 6000)
    g.altura(6040)
    cresce(60)
    expect(g.top()).toBe(6040)
  })

  it('lendo mais acima, o streaming que cresce não puxa a tela', async () => {
    preparar(conversa(100), undefined, 'working')
    await montar()
    cresce(20)
    await rolar(ALTURA_ITEM * 20)
    const g = geometria(ALTURA_ITEM * 20, 6000)
    g.altura(6040)
    cresce(60)
    expect(g.top()).toBe(ALTURA_ITEM * 20)
  })
})
