import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = {
  localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
}

let enviadas: any[]
const ws = { send: (m: any) => enviadas.push(m) } as never

beforeEach(() => {
  enviadas = []
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [], sessions: { s1: sess },
    chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const digitar = (texto: string) => {
  render(<WsContext.Provider value={ws}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  const campo = screen.getByRole('textbox')
  fireEvent.change(campo, { target: { value: texto } })
  fireEvent.keyDown(campo, { key: 'Enter' })
}

/**
 * `!ls` é um atalho para olhar a pasta sem gastar um turno da engine — nem token,
 * nem espera. O que sai daqui é outra mensagem de WebSocket, não a de sempre.
 */
describe('! vira comando de terminal', () => {
  it('manda como shell, não como mensagem', () => {
    digitar('!ls -la')
    expect(enviadas).toEqual([{ type: 'shell', localId: 's1', command: 'ls -la' }])
  })

  it('texto normal continua indo para a engine', () => {
    digitar('oi, tudo bem?')
    expect(enviadas[0].type).toBe('send_message')
  })

  /** Escapatória: quem precisa começar a frase com "!" põe um espaço antes. */
  it('espaço antes do ! manda para a engine', () => {
    digitar(' !isso é texto')
    expect(enviadas[0].type).toBe('send_message')
  })

  it('só o ! não vira nada', () => {
    digitar('!')
    expect(enviadas).toEqual([])
  })

  /**
   * Olhar a pasta ENQUANTO o agente trabalha é metade da graça: o comando não
   * passa pela engine, então não há turno para atrapalhar nem fila para esperar.
   */
  it('funciona com a engine ocupada', () => {
    useStore.setState({ sessions: { s1: { ...sess, status: 'working' } } })
    digitar('!git status')
    expect(enviadas).toEqual([{ type: 'shell', localId: 's1', command: 'git status' }])
  })

  /** O comando aparece na hora, antes de a saída voltar — senão parece travado. */
  it('o comando ecoa no chat imediatamente', () => {
    digitar('!pwd')
    const itens = useStore.getState().chat.s1
    expect(itens.at(-1)).toMatchObject({ kind: 'local_command', command: 'pwd' })
  })
})

describe('a saída volta para o chat', () => {
  it('vira bloco de saída', () => {
    useStore.getState().applyWsMessage({
      type: 'shell_result', localId: 's1', command: 'pwd', output: '/home/u/alpha', isError: false,
    } as never)
    expect(useStore.getState().chat.s1.at(-1)).toMatchObject({ kind: 'command_output', text: '/home/u/alpha' })
  })

  it('erro vem marcado como erro', () => {
    useStore.getState().applyWsMessage({
      type: 'shell_result', localId: 's1', command: 'x', output: 'não achei', isError: true,
    } as never)
    expect(useStore.getState().chat.s1.at(-1)).toMatchObject({ kind: 'command_output', isError: true })
  })

  /** Saída de um terminal não pode aparecer na conversa de outro. */
  it('cada saída no seu terminal', () => {
    useStore.getState().applyWsMessage({
      type: 'shell_result', localId: 'outro', command: 'x', output: 'y', isError: false,
    } as never)
    expect(useStore.getState().chat.s1).toHaveLength(0)
  })
})
