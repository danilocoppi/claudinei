import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { ClaudeEvent, EngineMeta, SessionInfo } from '../types'

/**
 * O `MessageBlock` de verdade, medido por um `Profiler` em volta dele. O
 * invólucro é memoizado com a MESMA comparação do bloco: só re-renderiza quando
 * o bloco de verdade re-renderizaria.
 */
const medida = vi.hoisted(() => ({ renders: {} as Record<string, number>, mounts: {} as Record<string, number> }))
vi.mock('../components/MessageBlock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components/MessageBlock')>()
  const React = await import('react')
  type Props = React.ComponentProps<typeof real.MessageBlock>
  const compare = (real.MessageBlock as unknown as { compare: ((a: Props, b: Props) => boolean) | null }).compare ?? undefined
  // Montagem contada pelo efeito do próprio invólucro: o `phase` do Profiler diz
  // o tipo do commit ('nested-update' quando a lista renderiza de dentro de um
  // efeito de layout), não se o bloco nasceu agora.
  const Medido = React.memo((props: Props) => {
    const id = props.item.key ?? '?'
    React.useEffect(() => { medida.mounts[id] = (medida.mounts[id] ?? 0) + 1 }, [])
    return React.createElement(React.Profiler, {
      id,
      onRender: () => { medida.renders[id] = (medida.renders[id] ?? 0) + 1 },
    }, React.createElement(real.MessageBlock, props))
  }, compare)
  return { ...real, MessageBlock: Medido }
})

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' }
const ws = { send: () => {} } as never

const resposta = (i: number): ClaudeEvent =>
  ({ kind: 'assistant', pos: i * 100, message: { role: 'assistant', content: [{ type: 'text', text: `resposta **${i}**` }] }, raw: {} })

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [], sessions: { s1: sess },
    chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    historyCursor: {}, folds: {}, orphanResults: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('a releitura do fim na conversa de verdade', () => {
  it('fim igual mais um item novo: os blocos que não mudaram não re-renderizam nem remontam', async () => {
    const historico = Array.from({ length: 20 }, (_, i) => resposta(i))
    act(() => useStore.getState().setHistoryTail('s1', { events: historico, before: 0, atStart: true }, 'c'))
    // Janela alta: a conversa inteira montada, para medir todos os blocos.
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 4000, itemHeight: 50 }}>
        <WsContext.Provider value={ws}><ChatView /></WsContext.Provider>
      </VirtuosoMockContext.Provider>,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    const antigos = useStore.getState().chat.s1.map((it) => it.key!)
    expect(antigos).toHaveLength(20)
    expect(screen.getByText('19')).toBeTruthy()
    for (const conta of [medida.renders, medida.mounts]) for (const k of Object.keys(conta)) delete conta[k]

    // A releitura traz o fim (as últimas 10 já na tela, iguais) e uma resposta nova.
    act(() => useStore.getState().setHistoryTail('s1', { events: [...historico.slice(10), resposta(20)], before: 1000, atStart: false }, 'c'))
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })

    expect(useStore.getState().chat.s1).toHaveLength(21)
    expect(screen.getByText('20')).toBeTruthy()
    const remontados = antigos.filter((k) => medida.mounts[k])
    expect(remontados, 'blocos que não mudaram remontados pela releitura').toEqual([])
    const refeitos = antigos.filter((k) => medida.renders[k])
    expect(refeitos, 'blocos que não mudaram re-renderizados pela releitura').toEqual([])
    const nova = useStore.getState().chat.s1.at(-1)!.key!
    expect(medida.mounts[nova], 'a resposta nova monta').toBeGreaterThan(0)
  })
})
