import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler, memo } from 'react'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { MessageBlock } from '../components/MessageBlock'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { ChatItem, ClaudeEvent, EngineMeta, SessionInfo } from '../types'

/**
 * Duas causas medidas com CPU profile na base real do operador (27 projetos):
 *
 * 1. `ChatInput.tsx:63`, o maior custo isolado do app — o auto-resize do textarea
 *    lia `scrollHeight` logo após invalidar o estilo, forçando um reflow SÍNCRONO
 *    da página inteira (~2.000 nós, 29 blurs) a cada montagem. E o ChatInput é
 *    remontado a cada troca de terminal.
 * 2. O `react-markdown` reconstrói o pipeline a cada render (sem cache; confirmado
 *    no código da lib), e o `rehype-highlight` re-registra 37 linguagens junto.
 *    Apareciam no profile numa SEGUNDA visita, com histórico em cache: nada tinha
 *    mudado, mas cada `MessageBlock` refazia tudo.
 */
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number): SessionInfo =>
  ({ localId, projectId, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })
const ws = { send: () => {} } as never

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess('s1', 1) },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('o auto-resize do campo não força reflow da página', () => {
  const espiaScrollHeight = () => {
    const spy = vi.fn(() => 24)
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: spy })
    return spy
  }
  const abrir = () =>
    render(<WsContext.Provider value={ws}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement

  /** Montar com rascunho vazio é o caso de TODA troca de terminal: cabe numa
   *  linha, não há o que medir — e medir custava ~12 ms de reflow por troca. */
  it('vazio ou de uma linha: não lê scrollHeight (nada a medir)', () => {
    const spy = espiaScrollHeight()
    abrir()
    expect(spy, 'reflow forçado ao montar com campo vazio').not.toHaveBeenCalled()
    fireEvent.change(campo(), { target: { value: 'uma linha curta' } })
    expect(spy).not.toHaveBeenCalled()
  })

  /** Com quebra de linha, medir é inevitável (e correto): o campo tem de crescer. */
  it('com quebra de linha: mede, porque precisa crescer', () => {
    const spy = espiaScrollHeight()
    abrir()
    fireEvent.change(campo(), { target: { value: 'linha 1\nlinha 2\nlinha 3' } })
    expect(spy).toHaveBeenCalled()
  })

  /** Onde o navegador dimensiona sozinho (`field-sizing: content`), o JS sai da
   *  frente por completo — zero reflow forçado, em qualquer texto. */
  it('com field-sizing nativo, o JS não mede nunca', () => {
    const spy = espiaScrollHeight()
    const proto = CSSStyleDeclaration.prototype as unknown as Record<string, unknown>
    proto.fieldSizing = ''
    try {
      abrir()
      fireEvent.change(campo(), { target: { value: 'a\nb\nc\nd\ne' } })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      delete proto.fieldSizing
    }
  })
})

describe('MessageBlock não refaz o markdown à toa', () => {
  /** A decisão em si, travada: sem memo, cada render do ChatView refaz o pipeline
   *  do react-markdown — e o highlight re-registra 37 linguagens — em cada bloco. */
  it('é um componente memoizado', () => {
    expect((MessageBlock as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })

  /** A assinatura que faz o memo valer: o pai passa UMA callback estável, e o
   *  bloco a chama com o próprio texto — sem closure nova por render. */
  it('editável chama onEdit com o texto e a chave do próprio item', () => {
    const onEdit = vi.fn()
    const item = { kind: 'user_text' as const, text: 'corrija isto', key: 'p42' }
    render(<MessageBlock item={item} currentLocalId="s1" editable onEdit={onEdit} />)
    fireEvent.click(screen.getByTitle(/edit|editar/i))
    expect(onEdit).toHaveBeenCalledWith('corrija isto', 'p42')
  })

  it('não editável não expõe o botão, mesmo com onEdit', () => {
    const item = { kind: 'user_text' as const, text: 'antigo' }
    render(<MessageBlock item={item} currentLocalId="s1" editable={false} onEdit={() => {}} />)
    expect(screen.queryByTitle(/edit|editar/i)).toBeNull()
  })
})

/**
 * Conversa longa ficava lenta com o tempo, e reabrir a página "resolvia" (o
 * histórico volta limitado). Medido no Chrome com o CLI falso: com ~1.200
 * entradas no chat, cada evento novo custava ~190 ms de JavaScript, contra
 * ~7 ms no começo; 70% disso era o react-markdown refazendo TODAS as mensagens.
 * O memo do MessageBlock existia, mas peças de dentro dele assinavam mapas
 * GLOBAIS do store — o cache de arquivos resolvidos (muda a cada mensagem que
 * cita um caminho), as sessões (mudam a cada evento: status, contexto) e os
 * projetos —, e assinatura do store re-renderiza por cima do memo.
 */
describe('mensagens antigas não re-renderizam com o que muda no store', () => {
  const conversa = () => Array.from({ length: 12 }, (_, i) => [
    { kind: 'user_text' as const, text: `pedido ${i} sobre src/pedido-${i}.ts` },
    { kind: 'user_text' as const, text: `# skill ${i}\n\ninjetada`, fromEngine: true },
    { kind: 'assistant_text' as const, text: `Mexi em **src/arquivo-${i}.ts** e segui.` },
  ]).flat()
  const montar = () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const commits = { n: 0 }
    const items = conversa()
    render(
      <WsContext.Provider value={ws}>
        <Profiler id="conversa" onRender={() => { commits.n++ }}>
          {items.map((item, i) => <MessageBlock key={i} item={item} currentLocalId="s1" />)}
        </Profiler>
      </WsContext.Provider>,
    )
    commits.n = 0
    return commits
  }

  it('um caminho novo resolvido (citado em outra mensagem) não refaz a conversa', async () => {
    const commits = montar()
    act(() => useStore.getState().setFilesResolved([{ path: 'src/novo.ts', exists: true, inScope: true, kind: 'text' } as never], 1))
    expect(commits.n, 'mensagens re-renderizaram por um arquivo que nenhuma cita').toBe(0)
  })

  it('evento de sessão (status, contexto) e projeto mexido não refazem a conversa', () => {
    const commits = montar()
    act(() => useStore.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1, status: 'working', contextTokens: 1234 } } })))
    act(() => useStore.setState((s) => ({ sessions: { ...s.sessions, s2: sess('s2', 1) } })))
    act(() => useStore.setState((s) => ({ projects: s.projects.map((p) => ({ ...p })) })))
    expect(commits.n, 'mensagens re-renderizaram por evento de sessão/projeto').toBe(0)
  })

  it('o caminho que a mensagem cita, quando resolve, ainda vira link', async () => {
    montar()
    expect(screen.queryByRole('link', { name: 'src/arquivo-3.ts' })).toBeNull()
    act(() => useStore.getState().setFilesResolved([{ path: 'src/arquivo-3.ts', exists: true, inScope: true, kind: 'text' } as never], 1))
    expect(screen.getByText('src/arquivo-3.ts').closest('a')).not.toBeNull()
  })
})

/**
 * O refetch do fim do turno (working → idle) relia o histórico e SUBSTITUÍA a
 * lista inteira: objetos novos para tudo, e cada `MessageBlock` refazia o
 * markdown. Agora a reconciliação por chave devolve o MESMO objeto para o que
 * não mudou, e só o que mudou (ou o que era ao vivo) é trocado.
 */
describe('o refetch do fim de turno não re-renderiza blocos que não mudaram', () => {
  const fala = (i: number): ClaudeEvent[] => [
    { kind: 'user', pos: i * 100, message: { role: 'user', content: [{ type: 'text', text: `pedido ${i}` }] }, raw: {} },
    { kind: 'assistant', pos: i * 100 + 50, message: { role: 'assistant', content: [{ type: 'text', text: `resposta **${i}**` }] }, raw: {} },
  ]
  const commits: Record<string, number> = {}
  // A linha memoizada é o que a lista virtual fará: chave estável + mesmo objeto = nada a fazer.
  const Linha = memo(({ item }: { item: ChatItem }) => (
    <Profiler id={item.key!} onRender={(id) => { commits[id] = (commits[id] ?? 0) + 1 }}>
      <MessageBlock item={item} currentLocalId="s1" />
    </Profiler>
  ))
  const Lista = () => {
    const items = useStore((s) => s.chat.s1) ?? []
    return <>{items.map((item) => <Linha key={item.key} item={item} />)}</>
  }

  it('o refetch do fim de turno não re-renderiza blocos que não mudaram', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const historico = Array.from({ length: 10 }, (_, i) => fala(i)).flat()
    act(() => useStore.getState().setHistoryTail('s1', { events: historico, before: 0, atStart: true }))
    render(<WsContext.Provider value={ws}><Lista /></WsContext.Provider>)
    const antigos = useStore.getState().chat.s1.map((it) => it.key!)
    for (const k of Object.keys(commits)) delete commits[k]

    // turno ao vivo, depois o refetch do fim com o turno já gravado
    act(() => useStore.getState().addLocalUserText('s1', 'pedido 10'))
    act(() => useStore.getState().applyWsMessage({ type: 'session_event', localId: 's1', event:
      { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'resposta **10**' }] }, raw: {} } }))
    act(() => useStore.getState().setHistoryTail('s1', { events: [...historico.slice(10), ...fala(10)], before: 500, atStart: false }))

    expect(useStore.getState().chat.s1).toHaveLength(22)
    const refeitos = antigos.filter((k) => commits[k])
    expect(refeitos, 'blocos antigos re-renderizados pelo refetch').toEqual([])
    expect(screen.getAllByText(/pedido 10/)).toHaveLength(1)
  })
})
