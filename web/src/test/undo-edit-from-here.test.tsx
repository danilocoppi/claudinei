import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { renderComJanela as render } from './viewport'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useUndoStore } from '../undo/undoStore'
import i18n from '../i18n'
import { en } from '../i18n/en'
import { es } from '../i18n/es'
import { ptBR } from '../i18n/pt-BR'
import type { ChatItem, EngineMeta, SessionInfo } from '../types'
import type {
  PreviewFile, RewindOptionsDto, RewindResultDto, TerminalTurnsDto, TurnDto, UndoPreview,
} from '../../../shared/undo'

const engine = (id: string, label: string): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: ['auto'], permissions: ['default'], slashSource: 'protocol', slashCommands: [],
})
const ENGINES = [engine('claude', 'Claude Code'), engine('codex', 'Codex'), engine('kimi', 'Kimi Code'), engine('opencode', 'OpenCode')]

const turn = (id: number, key: string, over: Partial<TurnDto> = {}): TurnDto => ({
  id, localId: 'a', projectId: 1, engine: 'claude', origin: 'operator', key, midTurn: false,
  state: 'ok', limited: false, endKind: 'result',
  summary: { files: 1, added: 2, removed: 0, outside: 0, uncertain: 0, unsnapshotted: 0 },
  lastRun: null, startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})

const pf = (path: string): PreviewFile => ({ path, class: 'own', verdict: 'revert', mergeable: false, overlapped: false, checked: true })
const preview = (token: string, over: Partial<UndoPreview> = {}): UndoPreview => ({
  token, turnIds: [2], blockedBy: null, branchChanged: null, files: [pf('src/a.ts')], notUndoable: [], hiddenOutside: 0, ...over,
})

const ON = { enabled: true }
const opts = (over: Partial<RewindOptionsDto> = {}): RewindOptionsDto => ({
  engine: 'claude', conversation: ON, files: { ...ON, preview: preview('tok1') }, filesTouched: true, working: false, ...over,
})

const ITEMS: ChatItem[] = [
  { kind: 'user_text', text: 'faça X', key: 'k0' },
  { kind: 'assistant_text', text: 'feito X', key: 'k1' },
  { kind: 'user_text', text: 'faça Y', key: 'k2' },
  { kind: 'assistant_text', text: 'feito Y', key: 'k3' },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Reply = unknown | ((body: any) => Response | unknown)
let routes: Record<string, Reply | Reply[]>
const spyFetch = () => vi.spyOn(globalThis, 'fetch')
let fetchSpy: ReturnType<typeof spyFetch>
const count: Record<string, number> = {}

/** O corpo de cada chamada a uma rota (URL exata), em ordem. */
const calls = (prefix: string) =>
  fetchSpy.mock.calls.filter(([u]) => String(u) === prefix)
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))

function setup(o: { engine?: string; status?: SessionInfo['status']; turns?: TurnDto[]; items?: ChatItem[] } = {}) {
  const sess: SessionInfo = {
    localId: 'a', projectId: 1, status: o.status ?? 'idle', engineSessionId: 'c', updatedAt: 'x', engine: o.engine ?? 'claude',
  }
  const dto: TerminalTurnsDto = {
    git: true, turns: o.turns ?? [turn(1, 'faça X'), turn(2, 'faça Y')], outside: [], interactive: [], intervals: [],
  }
  useUndoStore.setState({ byLocal: {}, terminalOf: {} })
  useStore.setState({
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁' }],
    sessions: { a: sess }, chat: { a: o.items ?? ITEMS }, unread: {}, streaming: {},
    historyLoadedFor: { a: 'c' }, historyCursor: { a: { before: 0, atStart: true, conv: 'c' } },
    view: 'chat', activeLocalId: 'a', engines: ENGINES, editRequest: undefined,
  })
  routes['/api/undo/terminals/a/turns'] = dto
}

beforeEach(() => {
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  for (const k of Object.keys(count)) delete count[k]
  routes = {}
  fetchSpy = spyFetch().mockImplementation(async (input, init) => {
    const url = String(input)
    // O histórico recarregado fica pendente: o teste vê o pedido, e o chat fica como estava.
    if (url.startsWith('/api/sessions/a/history')) return new Promise<Response>(() => {})
    // A rota mais específica primeiro: `/rewind/options` também começa com `/rewind`.
    const hit = Object.keys(routes).sort((x, y) => y.length - x.length).find(k => url.startsWith(k))
    if (!hit) return json([])
    const list = Array.isArray(routes[hit]) ? routes[hit] as Reply[] : [routes[hit]]
    const n = count[hit] = (count[hit] ?? 0) + 1
    const r = list[Math.min(n, list.length) - 1]
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = typeof r === 'function' ? (r as (b: any) => unknown)(body) : r
    return out instanceof Response ? out : json(out)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const OPTIONS = '/api/undo/terminals/a/rewind/options'
const REWIND = '/api/undo/terminals/a/rewind'

function abrir(send = vi.fn()) {
  render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
  return send
}

/** Clica no lápis da mensagem `n` (0 = a primeira editável) e espera o diálogo. */
async function editar(n: number) {
  const pencils = await screen.findAllByLabelText('Editar esta mensagem')
  fireEvent.click(pencils[n])
  return screen.findByRole('dialog', { name: 'Editar a partir daqui' })
}

const botao = (dlg: HTMLElement, name: string) => within(dlg).getByRole('button', { name }) as HTMLButtonElement

describe('Editar a partir daqui', () => {
  it('Kimi/OpenCode: as duas opções desligadas com o motivo e Copiar para o campo funciona', async () => {
    // Com o agente trabalhando: copiar para o campo não interrompe (R24).
    setup({ engine: 'kimi', status: 'working' })
    const off = { enabled: false, reason: 'engine_unsupported' as const, params: { engine: 'kimi' } }
    routes[OPTIONS] = opts({ engine: 'kimi', conversation: off, files: off })
    const send = abrir()
    const dlg = await editar(1)
    expect(await within(dlg).findByText('O Kimi Code não deixa o Claudinei voltar a conversa.')).toBeTruthy()
    // Um motivo só para as duas.
    expect(within(dlg).getAllByText(/não deixa o Claudinei/)).toHaveLength(1)
    expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(true)
    expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(true)
    // O alvo foi pedido com o turno casado, o texto e a ocorrência.
    expect(calls(OPTIONS)).toEqual([{ target: { turnId: 2, text: 'faça Y', occurrence: 0 } }])

    const campo = within(dlg).getByRole('textbox') as HTMLTextAreaElement
    expect(campo.value).toBe('faça Y')
    fireEvent.change(campo, { target: { value: 'faça Y direito' } })
    fireEvent.click(botao(dlg, 'Copiar para o campo'))
    expect(useStore.getState().editRequest).toMatchObject({ localId: 'a', text: 'faça Y direito' })
    expect(screen.queryByRole('dialog', { name: 'Editar a partir daqui' })).toBeNull()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    expect(calls(REWIND)).toEqual([])
  })

  it('Kimi trabalhando: sem volta possível, o aviso de interrupção não aparece', async () => {
    setup({ engine: 'kimi', status: 'working' })
    const off = { enabled: false, reason: 'engine_unsupported' as const, params: { engine: 'kimi' } }
    routes[OPTIONS] = opts({ engine: 'kimi', conversation: off, files: off })
    abrir()
    const dlg = await editar(1)
    await within(dlg).findByText('O Kimi Code não deixa o Claudinei voltar a conversa.')
    // O aviso é das duas voltas; com as duas desligadas, só resta copiar, que não interrompe.
    expect(within(dlg).queryByText('Editar interrompe o turno em andamento.')).toBeNull()
  })

  it('OpenCode: o nome de exibição do motor', async () => {
    setup({ engine: 'opencode' })
    const off = { enabled: false, reason: 'engine_unsupported' as const, params: { engine: 'opencode' } }
    routes[OPTIONS] = opts({ engine: 'opencode', conversation: off, files: off })
    abrir()
    const dlg = await editar(0)
    expect(await within(dlg).findByText('O OpenCode não deixa o Claudinei voltar a conversa.')).toBeTruthy()
  })

  it('Codex no meio do turno: as duas desligadas com o motivo', async () => {
    setup({ engine: 'codex', turns: [turn(1, 'faça X', { engine: 'codex' }), turn(2, 'faça Y', { engine: 'codex', midTurn: true })] })
    const off = { enabled: false, reason: 'codex_mid_turn' as const }
    routes[OPTIONS] = opts({ engine: 'codex', conversation: off, files: off })
    abrir()
    const dlg = await editar(1)
    expect(await within(dlg).findByText('Esta mensagem entrou no meio de um turno do Codex, e o Codex só volta turnos inteiros.')).toBeTruthy()
    expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(true)
    expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(true)
    expect(botao(dlg, 'Copiar para o campo').disabled).toBe(false)
  })

  it('Claude com mensagem enfileirada no meio do turno: o motivo próprio', async () => {
    setup()
    const off = { enabled: false, reason: 'claude_mid_turn' as const }
    routes[OPTIONS] = opts({ conversation: off, files: off })
    abrir()
    const dlg = await editar(1)
    expect(await within(dlg).findByText('Esta mensagem entrou no meio de um turno do Claude, e voltar a partir dela não é seguro.')).toBeTruthy()
  })

  it('sessão aberta no terminal: as duas desligadas com o motivo nas três línguas', async () => {
    setup({ status: 'in_terminal' })
    const off = { enabled: false, reason: 'in_terminal' as const }
    routes[OPTIONS] = opts({ conversation: off, files: off })
    abrir()
    const dlg = await editar(1)
    expect(await within(dlg).findByText('A sessão está aberta no terminal: feche-o para voltar a conversa.')).toBeTruthy()
    expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(true)
    expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(true)
    for (const lng of ['en', 'es'] as const) {
      await i18n.changeLanguage(lng)
      expect(i18n.t('undo.reason.in_terminal')).not.toBe('undo.reason.in_terminal')
    }
    await i18n.changeLanguage('pt-BR')
  })

  it('sem git: só a conversa ligada', async () => {
    setup()
    routes[OPTIONS] = opts({ files: { enabled: false, reason: 'no_git' } })
    abrir()
    const dlg = await editar(1)
    expect(await within(dlg).findByText('Sem git nesta pasta: os arquivos não podem voltar.')).toBeTruthy()
    await waitFor(() => expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(false))
    expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(true)
  })

  it('mensagem sem turno casado: o alvo vai sem turnId', async () => {
    setup({ turns: [] })
    routes[OPTIONS] = opts()
    abrir()
    await editar(0)
    await waitFor(() => expect(calls(OPTIONS)).toEqual([{ target: { text: 'faça X', occurrence: 0 } }]))
  })

  it('voltar só a conversa corta o chat local e manda rewind com mode conversation', async () => {
    setup()
    routes[OPTIONS] = opts()
    // O chat é cortado antes do envio: o eco do servidor chega pelo WS durante o pedido.
    let chatNoEnvio: ChatItem[] | undefined
    routes[REWIND] = () => {
      chatNoEnvio = useStore.getState().chat.a
      return { conversationRewound: true } satisfies RewindResultDto
    }
    abrir()
    const dlg = await editar(1)
    const campo = within(dlg).getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'faça Z' } })
    await waitFor(() => expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(false))
    const turnosAntes = calls('/api/undo/terminals/a/turns').length
    fireEvent.click(botao(dlg, 'Voltar só a conversa'))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar a partir daqui' })).toBeNull())
    expect(calls(REWIND)).toEqual([
      { target: { turnId: 2, text: 'faça Y', occurrence: 0 }, mode: 'conversation', editedText: 'faça Z' },
    ])
    expect(chatNoEnvio?.map(i => i.key)).toEqual(['k0', 'k1'])
    // Os turnos do terminal recarregam: nenhuma mensagem do WS tira os do trecho da conversa atual.
    await waitFor(() => expect(calls('/api/undo/terminals/a/turns').length).toBe(turnosAntes + 1))
    expect(useStore.getState().editRequest).toBeUndefined()
  })

  it('voltar a conversa e os arquivos passa pela tela de desfazer antes', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = [
      // Os arquivos mudaram entre a prévia e a escrita: 409 com a prévia nova.
      json({ error: 'mudou', code: 'undo_changed', preview: preview('tok2', { files: [pf('src/a.ts'), pf('src/b.ts')] }) }, 409),
      { conversationRewound: true, run: { id: 9, kind: 'undo', turnIds: [2], files: [], redone: false } } satisfies RewindResultDto,
    ]
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))

    // A tela de desfazer em modo de escolha, sem rede própria: nada foi mandado ainda.
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    expect(within(tela).getByText('src/a.ts')).toBeTruthy()
    expect(calls(REWIND)).toEqual([])
    expect(calls('/api/undo/apply')).toEqual([])

    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))
    await waitFor(() => expect(calls(REWIND)).toHaveLength(1))
    expect(calls(REWIND)[0]).toEqual({
      target: { turnId: 2, text: 'faça Y', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'faça Y',
      token: 'tok1', decisions: { 'src/a.ts': 'revert' },
    })
    // A prévia nova volta à tela, com o aviso.
    expect(await within(tela).findByText('src/b.ts')).toBeTruthy()
    expect(within(tela).getByText('Os arquivos mudaram desde que você abriu esta tela')).toBeTruthy()

    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))
    await waitFor(() => expect(calls(REWIND)).toHaveLength(2))
    expect(calls(REWIND)[1]).toMatchObject({ mode: 'conversation_and_files', token: 'tok2', decisions: { 'src/a.ts': 'revert', 'src/b.ts': 'revert' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('cancelar a tela de desfazer não manda nada e volta ao diálogo', async () => {
    setup()
    routes[OPTIONS] = opts()
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    fireEvent.keyDown(tela, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Voltar a conversa e os arquivos' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Editar a partir daqui' })).toBeTruthy()
    expect(calls(REWIND)).toEqual([])
    expect(useStore.getState().chat.a).toHaveLength(4)
  })

  it('prévia nova (409) e o operador desiste: o chat cortado volta do histórico', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = json({ error: 'mudou', code: 'undo_changed', preview: preview('tok2') }, 409)
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))
    expect(await within(tela).findByText('Os arquivos mudaram desde que você abriu esta tela')).toBeTruthy()
    // O corte fica para a confirmação seguinte.
    expect(useStore.getState().chat.a.map(i => i.key)).toEqual(['k0', 'k1'])
    expect('a' in useStore.getState().historyLoadedFor).toBe(true)
    fireEvent.keyDown(tela, { key: 'Escape' })
    expect('a' in useStore.getState().historyLoadedFor).toBe(false)
  })

  it('arquivo que não voltou: a volta segue e o diálogo avisa', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = {
      conversationRewound: true,
      run: { id: 9, kind: 'undo', turnIds: [2], files: [{ path: 'src/a.ts', result: 'failed', error: 'EACCES' }], redone: false },
    } satisfies RewindResultDto
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))
    expect(await within(dlg).findByText('Alguns arquivos não voltaram: src/a.ts')).toBeTruthy()
    // A conversa voltou: o corte vale, e fechar não recarrega o histórico.
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Fechar' }).at(-1)!)
    expect('a' in useStore.getState().historyLoadedFor).toBe(true)
    expect(useStore.getState().editRequest).toBeUndefined()
  })

  it('falha da conversa: texto volta ao campo e o aviso aparece', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = {
      conversationRewound: false,
      run: { id: 9, kind: 'undo', turnIds: [2], files: [], redone: false },
      error: { code: 'rewind_failed', message: 'thread/revert recusou' },
    } satisfies RewindResultDto
    abrir()
    const dlg = await editar(1)
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'faça W' } })
    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))

    expect(await screen.findByText(
      'A conversa não voltou: thread/revert recusou. Os arquivos desfeitos ficam desfeitos; use Refazer se quiser trazê-los.',
    )).toBeTruthy()
    expect(useStore.getState().editRequest).toMatchObject({ localId: 'a', text: 'faça W' })
    // O histórico recarrega (o chat local foi cortado antes do envio).
    expect('a' in useStore.getState().historyLoadedFor).toBe(false)
    await waitFor(() => expect(fetchSpy.mock.calls.some(([u]) => String(u).startsWith('/api/sessions/a/history'))).toBe(true))
  })

  it('falha da conversa só da conversa: o aviso sem os arquivos', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = { conversationRewound: false, error: { code: 'rewind_failed', message: 'sem âncora' } } satisfies RewindResultDto
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar só a conversa'))
    expect(await screen.findByText('A conversa não voltou: sem âncora. O texto editado ficou no campo.')).toBeTruthy()
    expect(useStore.getState().editRequest).toMatchObject({ text: 'faça Y' })
  })

  it('a conversa voltou mas o texto não saiu: o aviso e o texto no campo', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = { conversationRewound: true, error: { code: 'rewind_failed', message: 'o envio falhou' } } satisfies RewindResultDto
    abrir()
    const dlg = await editar(1)
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'faça V' } })
    await waitFor(() => expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar só a conversa'))
    expect(await within(dlg).findByText('A conversa voltou, mas o texto editado não saiu: o envio falhou. Ele ficou no campo.')).toBeTruthy()
    expect(useStore.getState().editRequest).toMatchObject({ localId: 'a', text: 'faça V' })
    // A conversa voltou: o corte do chat local vale, e fechar não recarrega o histórico.
    expect(useStore.getState().chat.a.map(i => i.key)).toEqual(['k0', 'k1'])
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'Fechar' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Editar a partir daqui' })).toBeNull()
    expect('a' in useStore.getState().historyLoadedFor).toBe(true)
  })

  it('pedido recusado (409): o erro aparece e o histórico recarrega', async () => {
    setup()
    routes[OPTIONS] = opts()
    routes[REWIND] = json({ error: 'x', code: 'rewind_turn_stuck' }, 409)
    abrir()
    const dlg = await editar(1)
    await waitFor(() => expect(botao(dlg, 'Voltar só a conversa').disabled).toBe(false))
    fireEvent.click(botao(dlg, 'Voltar só a conversa'))
    expect(await within(dlg).findByText('O turno do agente não terminou a tempo; tente de novo.')).toBeTruthy()
    expect('a' in useStore.getState().historyLoadedFor).toBe(false)
    expect(useStore.getState().editRequest).toBeUndefined()
  })

  it('agente trabalhando: o aviso de interrupção aparece dentro do diálogo e não há mais o ConfirmDialog antigo', async () => {
    setup({ status: 'working' })
    routes[OPTIONS] = opts({ working: true, files: { enabled: true } })
    routes[REWIND] = [
      // Interrompeu, e a prévia dos arquivos chega no 409.
      json({ error: 'mudou', code: 'undo_changed', preview: preview('tok3') }, 409),
      { conversationRewound: true } satisfies RewindResultDto,
    ]
    const send = abrir()
    const dlg = await editar(1)
    const aviso = within(dlg).getByText('Editar interrompe o turno em andamento.')
    expect(screen.queryByText('Editar e interromper?')).toBeNull()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))

    await waitFor(() => expect(botao(dlg, 'Voltar a conversa e os arquivos').disabled).toBe(false))
    // O aviso descreve as duas voltas, não o Copiar para o campo.
    expect(aviso.id).not.toBe('')
    expect(botao(dlg, 'Voltar só a conversa').getAttribute('aria-describedby')).toBe(aviso.id)
    expect(botao(dlg, 'Voltar a conversa e os arquivos').getAttribute('aria-describedby')).toBe(aviso.id)
    expect(botao(dlg, 'Copiar para o campo').hasAttribute('aria-describedby')).toBe(false)
    fireEvent.click(botao(dlg, 'Voltar a conversa e os arquivos'))
    // Sem prévia nas opções: o rewind sai sem token; o servidor interrompe e devolve a prévia.
    await waitFor(() => expect(calls(REWIND)).toHaveLength(1))
    expect(calls(REWIND)[0]).toEqual({ target: { turnId: 2, text: 'faça Y', occurrence: 0 }, mode: 'conversation_and_files', editedText: 'faça Y' })
    const tela = await screen.findByRole('dialog', { name: 'Voltar a conversa e os arquivos' })
    // A tela não promete que cancelar desfaz a interrupção.
    expect(within(tela).getByText('O turno em andamento já foi interrompido; cancelar agora não o retoma.')).toBeTruthy()
    fireEvent.click(within(tela).getByRole('button', { name: 'Voltar a conversa e os arquivos' }))
    await waitFor(() => expect(calls(REWIND)).toHaveLength(2))
    expect(calls(REWIND)[1]).toMatchObject({ token: 'tok3', decisions: { 'src/a.ts': 'revert' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Esc no campo do diálogo fecha só o diálogo', async () => {
    setup()
    routes[OPTIONS] = opts()
    abrir()
    const dlg = await editar(1)
    const campo = within(dlg).getByRole('textbox')
    expect(document.activeElement).toBe(campo)
    // O Esc sai marcado (`preventDefault`): o campo do chat não o vê como "parar o turno".
    expect(fireEvent.keyDown(campo, { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('dialog', { name: 'Editar a partir daqui' })).toBeNull()
  })

  it('o texto "recomeça a conversa a partir dela" não existe mais em nenhuma língua', async () => {
    const all = JSON.stringify([ptBR, en, es])
    expect(all).not.toMatch(/recomeça a conversa a partir dela/)
    expect(all).not.toMatch(/restarts the conversation from it/)
    expect(all).not.toMatch(/reinicia la conversación desde él/)
    expect(ptBR.chat.editWorkingMsg).toBe('Editar interrompe o turno em andamento.')
    expect(en.chat.editWorkingMsg).toBe('Editing interrupts the turn in progress.')
    expect(es.chat.editWorkingMsg).toBe('Editar interrumpe el turno en curso.')
    // As chaves novas resolvem nas três línguas.
    for (const lng of ['en', 'es', 'pt-BR'] as const) {
      await i18n.changeLanguage(lng)
      for (const k of ['undo.edit.title', 'undo.edit.conversation', 'undo.edit.conversationAndFiles', 'undo.edit.copy',
        'undo.edit.failed', 'undo.edit.failedNoFiles', 'undo.edit.notSent', 'undo.edit.interrupted'] as const) {
        expect(i18n.t(k), `${k} em ${lng}`).not.toBe(k)
      }
    }
    await i18n.changeLanguage('pt-BR')
  })
})
