import { describe, it, expect, beforeEach } from 'vitest'
import { Profiler } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MessageBlock } from '../components/MessageBlock'
import { ActionGroup } from '../components/ActionGroup'
import { groupActions } from '../chat/grouping'
import { foldId } from '../chat/folds'
import { useStore } from '../store'
import type { ChatItem, ClaudeEvent, SessionInfo } from '../types'

/**
 * Dobras (grupo de ações, cartão de ferramenta, "mostrar tudo", resumo da
 * compactação) guardadas no store por chave estável do item: com a lista
 * virtual, o bloco desmonta fora da tela, e o estado local se perderia.
 */

const tool = (id: string, key?: string): ChatItem =>
  ({ kind: 'tool_call', id, name: 'Bash', input: { command: `ls ${id}` }, result: `saida ${id}`, ...(key ? { key } : {}) })
const longo = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n')

const assistant = (content: object[], pos?: number): ClaudeEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content }, raw: {}, ...(pos !== undefined ? { pos } : {}) }) as ClaudeEvent
const user = (content: object[] | string, pos?: number): ClaudeEvent =>
  ({ kind: 'user', message: { role: 'user', content }, raw: {}, ...(pos !== undefined ? { pos } : {}) }) as ClaudeEvent
const pedido = (text: string, pos?: number) => user([{ type: 'text', text }], pos)
const chamada = (id: string, pos?: number) => assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: `ls ${id}` } }], pos)
const resultado = (id: string, pos?: number) => user([{ type: 'tool_result', tool_use_id: id, content: `saida ${id}` }], pos)
const texto = (text: string, pos?: number) => assistant([{ type: 'text', text }], pos)
const sess = (localId: string): SessionInfo =>
  ({ localId, projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

const st = () => useStore.getState()

beforeEach(() => {
  useStore.setState({
    chat: {}, historyCursor: {}, orphanResults: {}, historyLoadedFor: {}, unread: {}, streaming: {},
    sessions: { s1: sess('s1') }, folds: {},
  })
})

describe('slice folds do store', () => {
  it('foldId junta a chave do item e o nome da dobra', () => {
    expect(foldId('p120.1', 'tool')).toBe('p120.1:tool')
  })

  it('setFold abre e fecha; fechar apaga a entrada (o mapa não acumula falsos)', () => {
    st().setFold('s1', 'p1:tool', true)
    expect(st().folds.s1).toEqual({ 'p1:tool': true })
    st().setFold('s1', 'p1:tool', false)
    expect(st().folds.s1).toEqual({})
  })

  it('setFold sem mudança não troca o objeto do store', () => {
    st().setFold('s1', 'p1:tool', true)
    const antes = st().folds
    st().setFold('s1', 'p1:tool', true)
    expect(st().folds).toBe(antes)
  })

  it('renameFolds leva cada dobra da chave ao vivo para a confirmada e mantém as outras', () => {
    st().setFold('s1', 'l7:group', true)
    st().setFold('s1', 'l7:tool', true)
    st().setFold('s1', 'p3:more', true)
    st().renameFolds('s1', { l7: 'p50', l8: 'p60' })
    expect(st().folds.s1).toEqual({ 'p50:group': true, 'p50:tool': true, 'p3:more': true })
  })

  it('a sessão que some do snapshot leva junto as dobras dela', () => {
    useStore.setState({ folds: { s1: { 'p1:tool': true }, s2: { 'p2:tool': true } } })
    st().applyWsMessage({ type: 'sessions_snapshot', sessions: [sess('s1')] })
    expect(st().folds).toEqual({ s1: { 'p1:tool': true } })
  })

  it('a conversa trocada descarta as dobras da anterior (mesma posição, outro conteúdo)', () => {
    st().setHistoryTail('s1', { events: [pedido('velho', 0), chamada('t1', 50), resultado('t1', 60)], before: 0, atStart: true }, 'c1')
    st().setFold('s1', 'p50:tool', true)
    st().setHistoryTail('s1', { events: [pedido('novo', 0), chamada('t9', 50), resultado('t9', 60)], before: 0, atStart: true }, 'c2')
    expect(st().folds.s1 ?? {}).toEqual({})
  })
})

describe('dobras no store', () => {
  it('dobra aberta sobrevive a desmontar e montar o bloco', () => {
    const item = tool('t1', 'p10')
    const { unmount } = render(<MessageBlock item={item} currentLocalId="s1" />)
    expect(screen.queryByText('saida t1')).toBeNull()
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByText('saida t1')).toBeTruthy()
    unmount()

    render(<MessageBlock item={item} currentLocalId="s1" />)
    expect(screen.getByText('saida t1')).toBeTruthy()
  })

  it('o raciocínio aberto sobrevive a desmontar e montar e grava p<n>:thinking', () => {
    const item: ChatItem = { kind: 'thinking', text: 'pensando no plano', key: 'p42' }
    const { unmount } = render(<MessageBlock item={item} currentLocalId="s1" />)
    expect(screen.queryByText('pensando no plano')).toBeNull()
    fireEvent.click(screen.getByText(/Pensamento/))
    expect(st().folds.s1).toEqual({ 'p42:thinking': true })
    unmount()
    render(<MessageBlock item={item} currentLocalId="s1" />)
    expect(screen.getByText('pensando no plano')).toBeTruthy()
  })

  it('o grupo aberto também sobrevive a desmontar e montar', () => {
    const items = [tool('a', 'p1'), tool('b', 'p2'), tool('c', 'p3')].map((item, index) => ({ item, index }))
    const { unmount } = render(<ActionGroup items={items} currentLocalId="s1" />)
    fireEvent.click(screen.getByText('3 ações'))
    expect(st().folds.s1).toEqual({ 'p1:group': true })
    unmount()
    render(<ActionGroup items={items} currentLocalId="s1" />)
    expect(screen.getAllByText('Bash')).toHaveLength(3)
  })

  it('abrir um grupo não re-renderiza os outros MessageBlock', () => {
    const commits: Record<string, number> = {}
    const onRender = (id: string) => { commits[id] = (commits[id] ?? 0) + 1 }
    const grupoA = [tool('a1', 'p1'), tool('a2', 'p2'), tool('a3', 'p3')].map((item, index) => ({ item, index }))
    const grupoB = [tool('b1', 'p20'), tool('b2', 'p21'), tool('b3', 'p22')].map((item, index) => ({ item, index: index + 7 }))
    const soltos: ChatItem[] = [
      { kind: 'user_text', text: longo(20), key: 'p4' },
      tool('m1', 'p5'),
      { kind: 'user_text', text: 'resumo', compactSummary: true, fromEngine: true, key: 'p6' },
    ]
    render(<>
      <Profiler id="gA" onRender={onRender}><ActionGroup items={grupoA} currentLocalId="s1" /></Profiler>
      {soltos.map((item) => (
        <Profiler key={item.key} id={item.key!} onRender={onRender}><MessageBlock item={item} currentLocalId="s1" /></Profiler>
      ))}
      <Profiler id="gB" onRender={onRender}><ActionGroup items={grupoB} currentLocalId="s1" /></Profiler>
    </>)
    for (const k of Object.keys(commits)) delete commits[k]

    fireEvent.click(screen.getAllByText('3 ações')[0])
    expect(commits.gA).toBeGreaterThan(0)
    expect(Object.keys(commits).filter((k) => k !== 'gA'), 're-renderizados ao abrir o grupo A').toEqual([])
  })

  it('dobra de item ao vivo continua aberta depois que o histórico confirma', () => {
    // Como o ChatView virtual fará: o grupo é chaveado pela chave do 1º item,
    // e a confirmação troca essa chave (ao vivo → posição), remontando o grupo.
    const Lista = () => {
      const items = useStore((s) => s.chat.s1) ?? []
      return <>{groupActions(items, false).map((node) => node.kind === 'group'
        ? <ActionGroup key={`g-${node.items[0].item.key}`} items={node.items} currentLocalId="s1" />
        : <MessageBlock key={node.item.key} item={node.item} currentLocalId="s1" />)}</>
    }
    act(() => st().setHistoryTail('s1', { events: [pedido('faz', 0)], before: 0, atStart: true }, 'c'))
    render(<Lista />)

    // turno ao vivo: três ferramentas com chave provisória
    act(() => {
      for (const id of ['t1', 't2', 't3']) {
        st().applyWsMessage({ type: 'session_event', localId: 's1', event: chamada(id) })
        st().applyWsMessage({ type: 'session_event', localId: 's1', event: resultado(id) })
      }
    })
    const primeira = st().chat.s1[1].key!
    expect(primeira).toMatch(/^l\d+$/)
    fireEvent.click(screen.getByText('3 ações'))
    fireEvent.click(screen.getAllByText('Bash')[1])
    expect(screen.getByText('saida t2')).toBeTruthy()

    // fim do turno: o histórico confirma as mesmas ferramentas com posição
    act(() => st().setHistoryTail('s1', {
      events: [pedido('faz', 0), chamada('t1', 10), resultado('t1', 20), chamada('t2', 30), resultado('t2', 40),
        chamada('t3', 50), resultado('t3', 60), texto('pronto', 70)],
      before: 0, atStart: true,
    }, 'c'))
    expect(st().chat.s1[1].key).toBe('p10')
    expect(st().folds.s1).toEqual({ 'p10:group': true, 'p30:tool': true })
    expect(screen.getAllByText('Bash')).toHaveLength(3)
    expect(screen.getByText('saida t2')).toBeTruthy()
  })

  it('grupo aberto continua aberto quando a página antiga junta ações no topo dele; fechar limpa todas', () => {
    // O grupo é chaveado pelo 1º item: a página antiga traz ações que entram
    // ANTES dele no mesmo grupo, e a chave do 1º item muda (g:p300 → g:p100).
    const Lista = () => {
      const items = useStore((s) => s.chat.s1) ?? []
      return <>{groupActions(items, false).map((node) => node.kind === 'group'
        ? <ActionGroup key={`g-${node.items[0].item.key}`} items={node.items} currentLocalId="s1" />
        : <MessageBlock key={node.item.key} item={node.item} currentLocalId="s1" />)}</>
    }
    act(() => st().setHistoryTail('s1', {
      events: [chamada('t3', 300), resultado('t3', 310), chamada('t4', 320), resultado('t4', 330),
        chamada('t5', 340), resultado('t5', 350), texto('pronto', 360)],
      before: 300, atStart: false,
    }, 'c'))
    render(<Lista />)
    fireEvent.click(screen.getByText('3 ações'))
    expect(st().folds.s1).toEqual({ 'p300:group': true })

    act(() => st().prependHistory('s1', {
      events: [pedido('faz', 0), chamada('t1', 100), resultado('t1', 110), chamada('t2', 200), resultado('t2', 210)],
      before: 0, atStart: true,
    }, 300))
    expect(st().chat.s1[1].key).toBe('p100')
    // Os cinco cartões à vista: o grupo continua aberto.
    expect(screen.getByText('5 ações')).toBeTruthy()
    expect(screen.getAllByText('Bash')).toHaveLength(5)

    // Fechar fecha de verdade: nenhuma chave do grupo segura a dobra.
    fireEvent.click(screen.getByText('5 ações'))
    expect(st().folds.s1).toEqual({})
    expect(screen.queryAllByText('Bash')).toHaveLength(0)
  })

  it('resumo da compactação, mostrar tudo, cartão de ferramenta e raciocínio usam a mesma dobra do store', () => {
    const resumo: ChatItem = { kind: 'user_text', text: 'Summary:\n\n**Primary Request**', compactSummary: true, fromEngine: true, key: 'p1' }
    const operador: ChatItem = { kind: 'user_text', text: longo(20), key: 'p2' }
    const tarefa: ChatItem = { kind: 'task_message', text: longo(20), from: 'Outro', key: 'p3' }
    const agendada: ChatItem = { kind: 'scheduled_message', text: longo(20), name: 'Diária', run: 1, key: 'p4' }
    const cartao = tool('t5', 'p5')
    const raciocinio: ChatItem = { kind: 'thinking', text: 'pesando opções', key: 'p6' }
    const blocos = [resumo, operador, tarefa, agendada, cartao, raciocinio]
    const { unmount } = render(<>{blocos.map((it) => <MessageBlock key={it.key} item={it} currentLocalId="s1" />)}</>)

    fireEvent.click(screen.getByText('Contexto compactado'))
    for (const b of screen.getAllByText(/mostrar tudo/)) fireEvent.click(b)
    fireEvent.click(screen.getByText('Bash'))
    fireEvent.click(screen.getByText(/Pensamento/))
    expect(st().folds.s1).toEqual({
      'p1:summary': true, 'p2:more': true, 'p3:more': true, 'p4:more': true, 'p5:tool': true, 'p6:thinking': true,
    })
    unmount()

    // E o caminho inverso: o store manda, o bloco obedece.
    render(<>{blocos.map((it) => <MessageBlock key={it.key} item={it} currentLocalId="s1" />)}</>)
    expect(screen.getByText('Primary Request')).toBeTruthy()
    expect(screen.getAllByText(/linha 20/)).toHaveLength(3)
    expect(screen.getByText('saida t5')).toBeTruthy()
    expect(screen.getByText('pesando opções')).toBeTruthy()
    act(() => { st().setFold('s1', 'p5:tool', false); st().setFold('s1', 'p1:summary', false); st().setFold('s1', 'p6:thinking', false) })
    expect(screen.queryByText('pesando opções')).toBeNull()
    expect(screen.queryByText('saida t5')).toBeNull()
    expect(screen.queryByText('Primary Request')).toBeNull()
  })

  it('item sem chave (legado) continua com a dobra local, fora do store', () => {
    render(<MessageBlock item={tool('t1')} currentLocalId="s1" />)
    fireEvent.click(screen.getByText('Bash'))
    expect(screen.getByText('saida t1')).toBeTruthy()
    expect(st().folds).toEqual({})
  })
})
