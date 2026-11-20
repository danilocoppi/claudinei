import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { VirtuosoMockContext, type VirtuosoHandle } from 'react-virtuoso'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { chatFollow, chatListRef } from '../chat/listHandle'
import { foldsToOpen, locateHit, locateLiveHit, matchRanges } from '../chat/find'
import { paintFindMatches } from '../chat/findHighlight'
import { groupActions } from '../chat/grouping'
import type { ChatItem, ClaudeEvent, EngineMeta, SearchHit, SessionInfo } from '../types'

/**
 * Busca na conversa (Ctrl+F). O servidor procura em fatias (`/search`, uma por
 * pedido, encadeadas pelo `before`); a barra acumula as ocorrências, e ir a uma
 * delas carrega as páginas antigas até ela, abre as dobras e rola até lá.
 *
 * Lista virtual com medidas fixas (VirtuosoMockContext), como em chat-virtual.
 */
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }
const ws = { send: () => {} } as never

const ALTURA_JANELA = 600
const ALTURA_ITEM = 60
const TOPO = 100_000
const MB = 1024 * 1024

const fala = (pos: number): ChatItem => ({ kind: 'assistant_text', text: `fala ${pos}`, key: `p${pos}` })
const conversa = (n: number, primeiro = TOPO) => Array.from({ length: n }, (_, i) => fala(primeiro + i * 10))
const acao = (pos: number, id: string, result?: string): ChatItem =>
  ({ kind: 'tool_call', id, name: 'Bash', input: { command: `cmd ${id}` }, result, key: `p${pos}` })

const evFala = (pos: number): ClaudeEvent =>
  ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'text', text: `antiga ${pos}` }] }, raw: {} })
const evPensa = (pos: number, text: string): ClaudeEvent =>
  ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] }, raw: {} })
const evAcao = (pos: number): ClaudeEvent =>
  ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${pos}`, name: 'Bash', input: {} }] }, raw: {} })

const hit = (pos: number, field: SearchHit['field'] = 'text', toolUseId?: string): SearchHit =>
  ({ pos, field, snippet: `… ${pos} …`, ...(toolUseId ? { toolUseId } : {}) })

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const chamadas = () =>
  (globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } }).mock.calls
const urls = (trecho: string) => chamadas().map(([url]) => String(url)).filter((u) => u.includes(trecho))

const esperar = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

/**
 * Servidor falso: `/search` responde a fila `buscas` (ou fica pendente), `/history` a fila `paginas`
 * e, acabada a fila, o começo da conversa (uma página pendente para sempre prenderia o
 * carregador de páginas da sessão nos testes seguintes).
 */
function servidor(buscas: (unknown | 'pendente')[], paginas: unknown[] = []) {
  vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
    const u = String(url)
    if (u.includes('/search')) {
      const r = buscas.shift()
      if (r === undefined || r === 'pendente') return new Promise<Response>(() => {})
      return json(r)
    }
    if (u.includes('/history')) {
      return json(paginas.shift() ?? { events: [], before: 0, atStart: true })
    }
    return json([])
  })
}

function preparar(items: ChatItem[], cursor = { before: TOPO, atStart: false, conv: 'c' }) {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess, s2: { ...sess, localId: 's2', engineSessionId: 'd' } },
    chat: { s1: items, s2: conversa(3) }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c', s2: 'd' },
    historyCursor: { s1: cursor, s2: { before: 0, atStart: true, conv: 'd' } }, folds: {}, orphanResults: {}, find: null,
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

const ctrlF = (alvo: Element = document.body) => fireEvent.keyDown(alvo, { key: 'f', ctrlKey: true })
const campoBusca = () => screen.getByPlaceholderText('Buscar na conversa') as HTMLInputElement
/** Abre a barra, digita e aperta Enter. */
async function buscar(q: string, { ferramentas = false } = {}) {
  if (!screen.queryByPlaceholderText('Buscar na conversa')) ctrlF()
  if (ferramentas) fireEvent.click(screen.getByLabelText('incluir ferramentas'))
  fireEvent.change(campoBusca(), { target: { value: q } })
  fireEvent.keyDown(campoBusca(), { key: 'Enter' })
  await esperar()
}
const chaves = () => [...document.querySelectorAll<HTMLElement>('.chat-entry')].map((e) => e.dataset.key!)

/** Espia o `scrollToIndex` da lista (que troca o objeto do handle a cada render: o espião fica no ref). */
function espiarRolagem() {
  const rolagem = vi.fn()
  let handle: VirtuosoHandle | null = null
  Object.defineProperty(chatListRef, 'current', {
    configurable: true,
    get: () => handle && { ...handle, scrollToIndex: (a: Parameters<VirtuosoHandle['scrollToIndex']>[0]) => { rolagem(a); handle!.scrollToIndex(a) } },
    set: (v: VirtuosoHandle | null) => { handle = v },
  })
  onTestFinished(() => { Object.defineProperty(chatListRef, 'current', { value: null, writable: true, configurable: true }) })
  return rolagem
}

/**
 * Rola a caixa até `top`, como o navegador faria depois do `scrollToIndex`. Com
 * as medidas fixas do jsdom, a lista não acompanha a rolagem por índice depois
 * de acrescentar páginas no topo (a posição dela se descola do `scrollTop`); o
 * ensaio no navegador (Task 7) confere a rolagem de verdade.
 */
async function rolarPara(top: number) {
  const el = screen.getByTestId('chat-scroll')
  const total = groupActions(useStore.getState().chat.s1, false).length * ALTURA_ITEM
  for (const [k, v] of Object.entries({ scrollTop: top, scrollHeight: total, clientHeight: ALTURA_JANELA })) {
    Object.defineProperty(el, k, { value: v, configurable: true, writable: true })
  }
  fireEvent.scroll(el)
  await esperar()
}
const find = () => useStore.getState().find

beforeEach(() => {
  localStorage.clear()
  // Sem fila combinada: a conversa não tem nada antes do que está na tela.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    json(String(url).includes('/history') ? { events: [], before: 0, atStart: true } : []))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Ctrl+F no chat', () => {
  it('abre a barra com o foco nela; com a barra aberta, o segundo Ctrl+F é do navegador; Esc fecha', async () => {
    preparar(conversa(10))
    await montar()
    expect(ctrlF(), 'o primeiro Ctrl+F é do Claudinei').toBe(false)
    expect(document.activeElement).toBe(campoBusca())
    expect(ctrlF(campoBusca()), 'o segundo é do navegador').toBe(true)
    fireEvent.keyDown(campoBusca(), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Buscar na conversa')).toBeNull()
    expect(find()).toBeNull()
  })

  it('no campo de mensagem também abre a busca do Claudinei', async () => {
    preparar(conversa(10))
    await montar()
    const campo = document.querySelector<HTMLTextAreaElement>('.chat-compose__area')!
    expect(ctrlF(campo)).toBe(false)
    expect(campoBusca()).toBeTruthy()
  })
})

describe('a busca em fatias', () => {
  it('Enter encadeia fatias até atStart e acumula ocorrências na ordem', async () => {
    preparar(conversa(100))
    servidor([
      { hits: [hit(TOPO + 900), hit(TOPO + 800)], before: 70_000, atStart: false },
      { hits: [hit(TOPO + 600)], before: 0, atStart: true },
    ])
    await montar()
    await buscar('fala')
    expect(urls('/search')).toEqual([
      '/api/sessions/s1/search?q=fala&tools=0',
      '/api/sessions/s1/search?q=fala&tools=0&before=70000',
    ])
    expect(find()!.hits.map((h) => h.pos)).toEqual([TOPO + 900, TOPO + 800, TOPO + 600])
    expect(find()).toMatchObject({ scanning: false, atStart: true, capped: false, index: 0 })
    expect(screen.getByText('1 de 3')).toBeTruthy()
    // Enter vai para a mais antiga seguinte; Shift+Enter volta.
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()!.index).toBe(1)
    expect(screen.getByText('2 de 3')).toBeTruthy()
    fireEvent.keyDown(campoBusca(), { key: 'Enter', shiftKey: true })
    await esperar()
    expect(find()!.index).toBe(0)
    expect(urls('/search'), 'navegar não busca de novo').toHaveLength(2)
  })

  it('a consulta vai codificada e "incluir ferramentas" pede tools=1', async () => {
    preparar(conversa(10))
    servidor([{ hits: [], before: 0, atStart: true }])
    await montar()
    await buscar('a+b&c#d é', { ferramentas: true })
    const u = new URL(urls('/search')[0], 'http://x')
    expect(u.searchParams.get('q')).toBe('a+b&c#d é')
    expect(u.searchParams.get('tools')).toBe('1')
    expect(screen.getByText('nada encontrado')).toBeTruthy()
  })

  it('para em 500 e mostra "500+"', async () => {
    preparar(conversa(10))
    const lote = (de: number) => Array.from({ length: 300 }, (_, i) => hit(de - i))
    servidor([
      { hits: lote(90_000), before: 80_000, atStart: false },
      { hits: lote(70_000), before: 60_000, atStart: false },
      { hits: lote(50_000), before: 0, atStart: true },
    ])
    await montar()
    await buscar('fala')
    expect(urls('/search'), 'passou de 500: não pede a terceira fatia').toHaveLength(2)
    expect(find()!.hits).toHaveLength(500)
    expect(find()).toMatchObject({ capped: true, scanning: false })
    expect(screen.getByText('500+ — refine a busca')).toBeTruthy()
    expect(screen.queryByText('buscar mais para trás')).toBeNull()
  })

  it('para em 64 MB e oferece buscar mais para trás', async () => {
    preparar(conversa(10))
    // Cada fatia anda 8 MB para trás; o arquivo tem 200 MB.
    const fatias = Array.from({ length: 20 }, (_, i) => ({ hits: [], before: 200 * MB - (i + 1) * 8 * MB, atStart: false }))
    servidor(fatias)
    await montar()
    await buscar('fala')
    expect(urls('/search'), '8 fatias de 8 MB').toHaveLength(8)
    expect(find()).toMatchObject({ scanning: false, atStart: false, scannedBytes: 64 * MB })
    fireEvent.click(screen.getByText('buscar mais para trás'))
    await esperar()
    // Outra rodada de 64 MB, a partir de onde a anterior parou.
    expect(urls('/search')[8]).toBe(`/api/sessions/s1/search?q=fala&tools=0&before=${200 * MB - 8 * 8 * MB}`)
    expect(urls('/search')).toHaveLength(16)
    expect(screen.getByText('buscar mais para trás')).toBeTruthy()
  })

  it('mostra quantas achou enquanto varre', async () => {
    preparar(conversa(100))
    servidor([{ hits: [hit(TOPO + 900), hit(TOPO + 800)], before: 70_000, atStart: false }, 'pendente'])
    await montar()
    await buscar('fala')
    expect(screen.getByText('2 encontrados até agora…')).toBeTruthy()
  })

  it('Esc cancela o pedido em andamento', async () => {
    preparar(conversa(10))
    servidor(['pendente'])
    await montar()
    await buscar('fala')
    const [, init] = chamadas().find(([u]) => String(u).includes('/search'))!
    expect(init?.signal?.aborted).toBe(false)
    fireEvent.keyDown(campoBusca(), { key: 'Escape' })
    expect(init!.signal!.aborted).toBe(true)
    expect(find()).toBeNull()
  })

  it('nova busca cancela a anterior', async () => {
    preparar(conversa(10))
    servidor(['pendente', { hits: [], before: 0, atStart: true }])
    await montar()
    await buscar('fala')
    const [, primeira] = chamadas().find(([u]) => String(u).includes('/search'))!
    await buscar('outra')
    expect(primeira!.signal!.aborted).toBe(true)
    expect(find()).toMatchObject({ q: 'outra', atStart: true })
  })

  it('trocar de terminal fecha a busca e cancela o pedido; nada cai na outra conversa', async () => {
    preparar(conversa(10))
    servidor(['pendente'])
    await montar()
    await buscar('fala')
    const [, init] = chamadas().find(([u]) => String(u).includes('/search'))!
    act(() => { useStore.getState().openSession('s2') })
    await esperar()
    expect(init!.signal!.aborted).toBe(true)
    expect(find()).toBeNull()
    expect(screen.queryByPlaceholderText('Buscar na conversa')).toBeNull()
  })

  it('"reinicio" acha "reinício"', async () => {
    preparar([{ kind: 'user_text', text: 'o reinício do serviço', key: 'p50' }, ...conversa(10)])
    servidor([{ hits: [{ pos: 50, field: 'text', snippet: 'o reinício do serviço' }], before: 0, atStart: true }])
    await montar()
    await buscar('reinicio')
    expect(new URL(urls('/search')[0], 'http://x').searchParams.get('q')).toBe('reinicio')
    expect(screen.getByText('1 de 1')).toBeTruthy()
    expect(find()!.currentKey).toBe('p50')
  })
})

describe('ir a uma ocorrência', () => {
  it('ir a uma ocorrência antiga carrega páginas até achar, abre o grupo e marca chat-hit', async () => {
    preparar(conversa(100))
    const pagina1 = { events: Array.from({ length: 30 }, (_, i) => evFala(90_000 + i * 10)), before: 90_000, atStart: false }
    const pagina2 = {
      // O grupo no meio da página: no jsdom a rolagem até o índice 0 não muda nada.
      events: [...Array.from({ length: 20 }, (_, i) => evFala(100 + i * 10)),
        evPensa(510, 'pensando no reinício'), evAcao(520), evAcao(530), evAcao(540), evFala(600)],
      before: 100, atStart: true,
    }
    servidor([{ hits: [hit(510, 'thinking')], before: 0, atStart: true }], [pagina1, pagina2])
    const rolagem = espiarRolagem()
    await montar()
    await buscar('reinicio', { ferramentas: true })
    expect(urls('/history')).toEqual([
      `/api/sessions/s1/history?before=${TOPO}&limit=200`,
      '/api/sessions/s1/history?before=90000&limit=200',
    ])
    const folds = useStore.getState().folds.s1
    expect(folds).toMatchObject({ 'p510:group': true, 'p510:thinking': true })
    expect(find()!.currentKey).toBe('p510')
    // O nó do grupo é o 21º: 20 falas da página antiga antes dele.
    const nos = groupActions(useStore.getState().chat.s1, false)
    expect(rolagem).toHaveBeenCalledWith({ index: 20, align: 'center' })
    expect(nos[20].kind === 'group' && nos[20].items[0].item.key).toBe('p510')
    await rolarPara(20 * ALTURA_ITEM)
    expect(chaves()).toContain('g:p510')
    expect(document.querySelector('.action-group--open.action-group--hit')).toBeTruthy()
    const marcado = document.querySelector('.chat-hit')
    expect(marcado?.textContent).toContain('pensando no reinício')
  })

  it('ocorrência em saída de ferramenta abre grupo e cartão', async () => {
    preparar([
      fala(TOPO),
      acao(TOPO + 10, 't1', 'saída t1'), acao(TOPO + 20, 't2', 'saída t2 com reinício'), acao(TOPO + 30, 't3', 'saída t3'),
      ...conversa(60, TOPO + 100),
    ])
    servidor([{ hits: [hit(TOPO + 25, 'tool_output', 't2')], before: 0, atStart: true }])
    useStore.setState({ historyCursor: { s1: { before: TOPO, atStart: true, conv: 'c' } } })
    await montar()
    await buscar('reinicio', { ferramentas: true })
    expect(urls('/history'), 'já estava carregada').toEqual([])
    expect(useStore.getState().folds.s1).toMatchObject({ [`p${TOPO + 10}:group`]: true, [`p${TOPO + 20}:tool`]: true })
    const marcado = document.querySelector('.chat-hit')
    expect(marcado?.textContent).toContain('saída t2 com reinício')
    expect(find()!.currentKey).toBe(`p${TOPO + 20}`)
  })

  it('evento novo durante a busca não muda o índice atual nem rola a tela', async () => {
    preparar(conversa(100))
    // A primeira fatia acha; a segunda fica pendente (a busca continua varrendo).
    servidor([{ hits: [hit(TOPO + 500)], before: 70_000, atStart: false }, 'pendente'])
    const rolagem = espiarRolagem()
    await montar()
    await buscar('fala')
    expect(rolagem).toHaveBeenCalledTimes(1)
    expect(rolagem).toHaveBeenCalledWith({ index: 50, align: 'center' })
    expect(find()).toMatchObject({ index: 0, currentKey: `p${TOPO + 500}`, scanning: true })
    // Ir à ocorrência soltou o "grudado no fim".
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()

    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, ...conversa(20, 900_000)] } })) })
    await esperar()
    expect(find()).toMatchObject({ index: 0, currentKey: `p${TOPO + 500}` })
    expect(rolagem).toHaveBeenCalledTimes(1)
    expect(chaves()).toContain(`p${TOPO + 500}`)
    expect(chaves()).not.toContain(`p${900_000 + 19 * 10}`)
    expect(document.querySelector('.chat-hit')?.textContent).toContain(`fala ${TOPO + 500}`)
  })

  it('ir a uma ocorrência no fim da conversa também solta o "grudado no fim"', async () => {
    preparar(conversa(100))
    // A penúltima: a tela continua no fim, e a lista não avisaria que saiu dele.
    servidor([{ hits: [hit(TOPO + 980)], before: 0, atStart: true }])
    await montar()
    await buscar('fala')
    expect(find()!.currentKey).toBe(`p${TOPO + 980}`)
    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, ...conversa(20, 900_000)] } })) })
    await esperar()
    expect(chaves()).toContain(`p${TOPO + 980}`)
    expect(chaves()).not.toContain(`p${900_000 + 19 * 10}`)
  })

  it('buscar sem ocorrência não solta o "grudado no fim"', async () => {
    preparar(conversa(100))
    servidor([{ hits: [], before: 0, atStart: true }])
    await montar()
    await buscar('nada')
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, ...conversa(20, 900_000)] } })) })
    await esperar()
    expect(chaves().at(-1)).toBe(`p${900_000 + 19 * 10}`)
  })

  it('Esc no meio da ida às páginas antigas para de carregar', async () => {
    preparar(conversa(100))
    const pagina1 = { events: Array.from({ length: 30 }, (_, i) => evFala(90_000 + i * 10)), before: 90_000, atStart: false }
    let responder = (_r: Response) => {}
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/search')) return json({ hits: [hit(500)], before: 0, atStart: true })
      if (u.includes('/history')) return new Promise<Response>((r) => { responder = r })
      return json([])
    })
    await montar()
    await buscar('fala')
    expect(urls('/history')).toHaveLength(1)
    fireEvent.keyDown(campoBusca(), { key: 'Escape' })
    responder(json(pagina1))
    await esperar()
    expect(urls('/history'), 'não pediu a página seguinte').toHaveLength(1)
    // A página que já vinha entrou na conversa, sem buraco.
    expect(useStore.getState().historyCursor.s1.before).toBe(90_000)
  })
})

describe('revisão: turno ao vivo, visita tardia, fatia parada, Esc, cancelamento', () => {
  const aoVivo = (texto: string, key = 'l5'): ChatItem => ({ kind: 'assistant_text', text: texto, key })
  const comTexto = (pos: number, snippet: string): SearchHit => ({ pos, field: 'text', snippet })

  it('ocorrência no turno em andamento acha o item ao vivo pelo trecho', async () => {
    preparar([...conversa(30), aoVivo('primeira linha\n\ntexto novo com o Reinício   do serviço', 'l4'), aoVivo('outra coisa', 'l5')])
    useStore.setState((s) => ({ sessions: { ...s.sessions, s1: { ...sess, status: 'working' } } }))
    // O servidor já leu a linha nova (pos depois de tudo na tela) e junta os espaços do trecho.
    servidor([{ hits: [comTexto(TOPO + 5000, 'texto novo com o reinício do serviço')], before: 0, atStart: true }])
    await montar()
    await buscar('reinicio')
    expect(urls('/history'), 'não carrega páginas para o que está depois do cursor').toEqual([])
    expect(find()!.currentKey).toBe('l4')
    expect(document.querySelector('.chat-hit')?.textContent).toContain('Reinício')
  })

  it('a releitura do fim do turno que confirma o item no meio da ida não deixa a marca na chave velha', async () => {
    const TEXTO = 'primeira linha\n\ntexto novo com o Reinício   do serviço'
    preparar([...conversa(30), aoVivo(TEXTO, 'l4'), aoVivo('outra coisa', 'l5')])
    useStore.setState((s) => ({ sessions: { ...s.sessions, s1: { ...sess, status: 'working' } } }))
    servidor([{ hits: [comTexto(TOPO + 5000, 'texto novo com o reinício do serviço')], before: 0, atStart: true }])
    await montar()
    // O fim do turno chega entre abrir as dobras e marcar o item: l4 vira p<pos>.
    const fala = (pos: number, text: string): ClaudeEvent =>
      ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'text', text }] }, raw: {} })
    let soltar = chatFollow.release
    Object.defineProperty(chatFollow, 'release', {
      configurable: true,
      get: () => () => {
        soltar()
        useStore.getState().setHistoryTail('s1', {
          events: [fala(TOPO + 290, `fala ${TOPO + 290}`), fala(TOPO + 5000, TEXTO), fala(TOPO + 5010, 'outra coisa')],
          before: TOPO + 290, atStart: false,
        }, 'c')
      },
      set: (v: () => void) => { soltar = v },
    })
    onTestFinished(() => { Object.defineProperty(chatFollow, 'release', { value: soltar, writable: true, configurable: true }) })
    await buscar('reinicio')
    expect(useStore.getState().chat.s1.at(-2)?.key).toBe(`p${TOPO + 5000}`)
    expect(find()!.currentKey).toBe(`p${TOPO + 5000}`)
    expect(document.querySelector('.chat-hit')?.textContent).toContain('Reinício')
  })

  it('Enter numa ocorrência que não levou a nada tenta de novo antes de seguir', async () => {
    preparar(conversa(30))
    servidor([{ hits: [comTexto(TOPO + 5000, 'texto novo'), hit(TOPO + 100)], before: 0, atStart: true }])
    await montar()
    await buscar('novo')
    expect(find()).toMatchObject({ index: 0, currentKey: null })
    expect(screen.getByText('1 de 2')).toBeTruthy()
    // O item apareceu (ao vivo); Enter tenta a mesma ocorrência, não pula para a 2ª.
    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, aoVivo('um texto novo aqui')] } })) })
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()).toMatchObject({ index: 0, currentKey: 'l5' })
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()).toMatchObject({ index: 1, currentKey: `p${TOPO + 100}` })
  })

  it('a ocorrência que nunca aparece é tentada uma vez a mais, e o Enter seguinte segue', async () => {
    preparar(conversa(30))
    servidor([{ hits: [comTexto(TOPO + 5000, 'nunca'), hit(TOPO + 100)], before: 0, atStart: true }])
    await montar()
    await buscar('nunca')
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()).toMatchObject({ index: 0, currentKey: null })
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()).toMatchObject({ index: 1, currentKey: `p${TOPO + 100}` })
  })

  /** Primeira fatia sem nada; a segunda (com a ocorrência) espera `responder`. */
  function segundaFatiaDepois() {
    let responder = (_r: Response) => {}
    let n = 0
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/search')) {
        if (n++ === 0) return json({ hits: [], before: 70_000, atStart: false })
        return new Promise<Response>((r) => { responder = r })
      }
      return json(u.includes('/history') ? { events: [], before: 0, atStart: true } : [])
    })
    return () => responder(json({ hits: [hit(TOPO + 500)], before: 0, atStart: true }))
  }

  it('ocorrência que chega depois de o operador voltar a rolar não o arranca de onde está', async () => {
    preparar(conversa(100))
    const chegar = segundaFatiaDepois()
    await montar()
    await buscar('fala')
    fireEvent.wheel(screen.getByTestId('chat-scroll'), { deltaY: -100 })
    chegar()
    await esperar()
    expect(find()).toMatchObject({ index: 0, currentKey: null, atStart: true })
    expect(screen.getByText('1 de 1')).toBeTruthy()
    expect(screen.queryByTestId('chat-tofoot'), 'continua grudado no fim').toBeNull()
    // O próximo Enter leva até ela.
    fireEvent.keyDown(campoBusca(), { key: 'Enter' })
    await esperar()
    expect(find()!.currentKey).toBe(`p${TOPO + 500}`)
  })

  it('ocorrência que chega com o foco já fora da barra também não é visitada sozinha', async () => {
    preparar(conversa(100))
    const chegar = segundaFatiaDepois()
    await montar()
    await buscar('fala')
    document.querySelector<HTMLTextAreaElement>('.chat-compose__area')!.focus()
    chegar()
    await esperar()
    expect(find()).toMatchObject({ index: 0, currentKey: null })
  })

  it('fatia que não anda para trás para a busca com aviso, sem pedir de novo', async () => {
    preparar(conversa(10))
    servidor([
      { hits: [], before: 70_000, atStart: false },
      { hits: [], before: 70_000, atStart: false },
      { hits: [], before: 70_000, atStart: false },
    ])
    await montar()
    await buscar('fala')
    expect(urls('/search')).toHaveLength(2)
    expect(find()).toMatchObject({ scanning: false })
    expect(screen.getByText('a busca parou: o servidor não avançou na conversa')).toBeTruthy()
  })

  it('Esc fora da coluna do chat (menu da lateral, foco em nada) é de quem está lá; no chat fecha', async () => {
    preparar(conversa(10))
    await montar()
    const fora = document.createElement('button')
    document.body.appendChild(fora)
    onTestFinished(() => fora.remove())
    ctrlF()
    fireEvent.keyDown(fora, { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByPlaceholderText('Buscar na conversa')).toBeTruthy()
    fireEvent.keyDown(document.querySelector('.chat-entry')!, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Buscar na conversa')).toBeNull()
  })

  it('a busca fechada pelo store (conversa trocada, conta bloqueada) cancela o pedido no ar', async () => {
    preparar(conversa(10))
    servidor(['pendente', 'pendente'])
    await montar()
    await buscar('fala')
    const sinais = () => chamadas().filter(([u]) => String(u).includes('/search')).map(([, i]) => i!.signal!)
    act(() => { useStore.getState().setHistoryTail('s1', { events: [evFala(10)], before: 10, atStart: true }, 'outra-conversa') })
    expect(find()).toBeNull()
    expect(sinais()[0].aborted).toBe(true)

    await buscar('fala')
    act(() => {
      useStore.getState().setAuth('ready', {
        setupRequired: false, id: 1, username: 'u', isAdmin: true, access: { allowed: false, serverNow: 0, checkAt: null },
      })
    })
    expect(find()).toBeNull()
    expect(sinais()[1].aborted).toBe(true)
  })
})

describe('o destaque do termo (CSS Custom Highlight API)', () => {
  let pinturas: unknown[][]
  let apagadas: number
  beforeEach(() => {
    pinturas = []
    apagadas = 0
    vi.stubGlobal('CSS', { highlights: { set: (_n: string, h: { r: unknown[] }) => { pinturas.push(h.r) }, delete: () => { apagadas++ } } })
    vi.stubGlobal('Highlight', class { r: unknown[]; constructor(...r: unknown[]) { this.r = r } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('pinta ao buscar; evento novo não repinta; barra fechada não agenda nada', async () => {
    preparar(conversa(100))
    // Ocorrência no meio: o item novo chega lá embaixo, fora da faixa montada.
    servidor([{ hits: [hit(TOPO + 200)], before: 0, atStart: true }])
    await montar()
    await buscar('fala')
    await esperar()
    expect(pinturas.length).toBeGreaterThan(0)
    expect(pinturas.at(-1)!.length).toBeGreaterThan(0)
    const antes = pinturas.length
    act(() => { useStore.setState((s) => ({ chat: { s1: [...s.chat.s1, aoVivoFala()] } })) })
    await esperar()
    expect(pinturas.length, 'evento novo não repinta').toBe(antes)

    fireEvent.keyDown(campoBusca(), { key: 'Escape' })
    await esperar()
    expect(apagadas).toBeGreaterThan(0)
    const depois = pinturas.length
    const apagadasDepois = apagadas
    // A faixa montada muda (rolagem) com a barra fechada: nada a agendar.
    await rolarPara(ALTURA_ITEM * 60)
    expect(chaves()).toContain(`p${TOPO + 600}`)
    expect(pinturas.length).toBe(depois)
    expect(apagadas, 'nada pintado, nada a apagar').toBe(apagadasDepois)
  })

  it('não dobra nó de texto enorme', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="chat-entry"><p>o reinício</p><pre></pre></div>'
    root.querySelector('pre')!.textContent = 'reinício '.repeat(5000)
    expect(paintFindMatches(root, 'reinicio')).toBe(1)
  })
})

const aoVivoFala = (): ChatItem => ({ kind: 'assistant_text', text: 'fala nova', key: 'l99' })

describe('a busca no store', () => {
  const aberta = (currentKey: string | null) => ({
    localId: 's1', q: 'fala', tools: false, hits: [hit(10)], index: 0, scanning: false, before: 0, atStart: true,
    scannedBytes: 0, capped: false, currentKey, error: null,
  })
  const evTexto = (pos: number, text: string): ClaudeEvent =>
    ({ kind: 'assistant', pos, message: { role: 'assistant', content: [{ type: 'text', text }] }, raw: {} })

  it('a ocorrência num item ao vivo acompanha a chave confirmada', () => {
    preparar([fala(10), { kind: 'assistant_text', text: 'nova', key: 'l7' }])
    useStore.setState({ find: aberta('l7') })
    useStore.getState().setHistoryTail('s1', { events: [evTexto(10, 'fala 10'), evTexto(20, 'nova')], before: 10, atStart: true }, 'c')
    expect(useStore.getState().chat.s1.map((it) => it.key)).toEqual(['p10', 'p20'])
    expect(find()!.currentKey).toBe('p20')
  })

  it('conversa trocada fecha a busca: as posições eram de outro arquivo', () => {
    preparar([fala(10)])
    useStore.setState({ find: aberta('p10') })
    useStore.getState().setHistoryTail('s1', { events: [evTexto(10, 'outra')], before: 10, atStart: true }, 'outra-conversa')
    expect(find()).toBeNull()
  })
})

describe('find.ts', () => {
  it('locateHit: a chave da posição, o item do campo certo e a chamada da ferramenta', () => {
    const items: ChatItem[] = [
      { kind: 'thinking', text: 'pensa', key: 'p10' },
      { kind: 'assistant_text', text: 'fala', key: 'p10.1' },
      acao(20, 't20', 'ok'),
      { kind: 'user_text', text: 'pedido', key: 'p30' },
      { kind: 'assistant_text', text: 'ao vivo', key: 'l1' },
    ]
    expect(locateHit(items, hit(10, 'thinking'))).toBe('p10')
    expect(locateHit(items, hit(10, 'text'))).toBe('p10.1')
    expect(locateHit(items, hit(30))).toBe('p30')
    expect(locateHit(items, hit(25, 'tool_output', 't20'))).toBe('p20')
    expect(locateHit(items, hit(20, 'tool_input', 't20'))).toBe('p20')
    expect(locateHit(items, hit(1))).toBeNull()
    expect(locateHit(items, hit(25, 'tool_output', 'outra'))).toBeNull()
    // `p1` não é prefixo de `p10`.
    expect(locateHit([{ kind: 'assistant_text', text: 'x', key: 'p10' }], hit(1))).toBeNull()
  })

  it('foldsToOpen: grupo, ferramenta, raciocínio, "mostrar tudo" e resumo', () => {
    const longo = Array.from({ length: 20 }, (_, i) => `linha ${i}`).join('\n')
    const items: ChatItem[] = [
      { kind: 'user_text', text: longo, key: 'p1' },
      { kind: 'user_text', text: 'curto', key: 'p2' },
      { kind: 'user_text', text: longo, compactSummary: true, fromEngine: true, key: 'p3' },
      { kind: 'thinking', text: 'pensa', key: 'p4' },
      acao(5, 't5', 'ok'), acao(6, 't6', 'ok'),
      { kind: 'task_message', from: 'outro', text: longo, key: 'p7' },
      acao(8, 't8', 'ok'),
      { kind: 'assistant_text', text: 'fim', key: 'p9' },
    ]
    const nodes = groupActions(items, false)
    expect(foldsToOpen(nodes, items, 'p1', 'text')).toEqual(['p1:more'])
    expect(foldsToOpen(nodes, items, 'p2', 'text')).toEqual([])
    expect(foldsToOpen(nodes, items, 'p3', 'text')).toEqual(['p3:summary'])
    expect(foldsToOpen(nodes, items, 'p4', 'thinking')).toEqual(['p4:group', 'p4:thinking'])
    expect(foldsToOpen(nodes, items, 'p6', 'tool_output')).toEqual(['p4:group', 'p6:tool'])
    expect(foldsToOpen(nodes, items, 'p7', 'text')).toEqual(['p7:more'])
    // Fora de grupo (ação sozinha): só o cartão.
    expect(foldsToOpen(nodes, items, 'p8', 'tool_input')).toEqual(['p8:tool'])
    expect(foldsToOpen(nodes, items, 'p9', 'text')).toEqual([])
  })

  it('locateLiveHit: só itens ao vivo, do campo, do mais novo para o mais antigo', () => {
    const items: ChatItem[] = [
      { kind: 'assistant_text', text: 'o Reinício\n do serviço', key: 'p10' },
      { kind: 'assistant_text', text: 'o reinício  do serviço, de novo', key: 'l1' },
      { kind: 'thinking', text: 'o reinício do serviço', key: 'l2' },
      { kind: 'user_text', text: 'pedi REINICIO do servico', key: 'l3' },
    ]
    expect(locateLiveHit(items, { pos: 99, field: 'text', snippet: 'o reinício do serviço' })).toBe('l1')
    expect(locateLiveHit(items, { pos: 99, field: 'thinking', snippet: 'o reinício do serviço' })).toBe('l2')
    expect(locateLiveHit(items, { pos: 99, field: 'text', snippet: 'reinicio do servico' })).toBe('l3')
    expect(locateLiveHit(items, { pos: 99, field: 'text', snippet: 'nada disso' })).toBeNull()
  })

  it('matchRanges: sem caixa nem acento, nos índices do texto original', () => {
    expect(matchRanges('O Reinício e o reinicio', 'reinicio')).toEqual([[2, 10], [15, 23]])
    // Acento combinante (NFD) fica dentro do trecho.
    expect(matchRanges('reínicio!', 'reinicio')).toEqual([[0, 9]])
    expect(matchRanges('AÇÃO', 'acao')).toEqual([[0, 4]])
    expect(matchRanges('nada aqui', 'reinicio')).toEqual([])
    expect(matchRanges('qualquer', '')).toEqual([])
  })
})
