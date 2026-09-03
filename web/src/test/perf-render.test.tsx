import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { MessageBlock } from '../components/MessageBlock'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

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
  it('editável chama onEdit com o texto do próprio item', () => {
    const onEdit = vi.fn()
    const item = { kind: 'user_text' as const, text: 'corrija isto' }
    render(<MessageBlock item={item} currentLocalId="s1" editable onEdit={onEdit} />)
    fireEvent.click(screen.getByTitle(/edit|editar/i))
    expect(onEdit).toHaveBeenCalledWith('corrija isto')
  })

  it('não editável não expõe o botão, mesmo com onEdit', () => {
    const item = { kind: 'user_text' as const, text: 'antigo' }
    render(<MessageBlock item={item} currentLocalId="s1" editable={false} onEdit={() => {}} />)
    expect(screen.queryByTitle(/edit|editar/i)).toBeNull()
  })
})
