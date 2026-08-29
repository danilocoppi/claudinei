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
const sess = (localId: string, projectId: number): SessionInfo =>
  ({ localId, projectId, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

const ws = { send: () => {} } as never

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' },
      { id: 2, name: 'Vaexa - Admin', path: '/b', color: '#fff', icon: '📦' },
      { id: 3, name: 'Sessão de Testes', path: '/c', color: '#fff', icon: '🧪' },
    ],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess('s1', 1) },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrir = () =>
  render(<WsContext.Provider value={ws}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)

const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement

/** Digita e posiciona o cursor no fim, como o navegador faria. */
const digitar = (texto: string) => {
  const el = campo()
  fireEvent.change(el, { target: { value: texto, selectionStart: texto.length, selectionEnd: texto.length } })
}

/**
 * "Quando um projeto precisa falar com outro, fica muito subjetivo com quem ele
 * vai falar."
 *
 * O `@@` resolve o QUEM: as ferramentas de colaboração recebem o NOME do projeto
 * e o servidor compara exato, então escrever de memória é errar por um hífen e
 * receber `project "..." does not exist`. Escolher da lista torna isso impossível.
 */
describe('referenciar outro terminal com @@', () => {
  it('dois arrobas abrem a lista com o campo de busca já focado', () => {
    abrir()
    digitar('peça para @@')
    expect(screen.getByTestId('mention-menu')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('mention-search'))
  })

  it('um arroba só não abre nada', () => {
    abrir()
    digitar('meu@email')
    expect(screen.queryByTestId('mention-menu')).toBeNull()
  })

  /** Falar consigo mesmo não é colaboração: o alvo seria a própria sessão. */
  it('o terminal atual não aparece na lista', () => {
    abrir()
    digitar('@@')
    const nomes = screen.getAllByTestId('mention-item').map((i) => i.textContent)
    expect(nomes).toHaveLength(2)
    expect(nomes.join()).not.toContain('Alpha')
  })

  it('escolher escreve o nome exato, delimitado', () => {
    abrir()
    digitar('peça para @@')
    fireEvent.mouseDown(screen.getAllByTestId('mention-item')[0])
    expect(campo().value).toBe('peça para @[Vaexa - Admin] ')
  })

  it('a busca filtra, e sem acento', () => {
    abrir()
    digitar('@@')
    fireEvent.change(screen.getByTestId('mention-search'), { target: { value: 'sessao' } })
    const itens = screen.getAllByTestId('mention-item')
    expect(itens).toHaveLength(1)
    expect(itens[0].textContent).toContain('Sessão de Testes')
  })

  it('setas e Enter escolhem sem tirar a mão do teclado', () => {
    abrir()
    digitar('@@')
    const busca = screen.getByTestId('mention-search')
    fireEvent.keyDown(busca, { key: 'ArrowDown' })
    fireEvent.keyDown(busca, { key: 'Enter' })
    expect(campo().value).toBe('@[Sessão de Testes] ')
  })

  it('Esc fecha e devolve o texto como estava', () => {
    abrir()
    digitar('peça para @@')
    fireEvent.keyDown(screen.getByTestId('mention-search'), { key: 'Escape' })
    expect(screen.queryByTestId('mention-menu')).toBeNull()
    expect(campo().value).toBe('peça para @@')
  })

  it('busca sem acerto avisa em vez de sumir', () => {
    abrir()
    digitar('@@')
    fireEvent.change(screen.getByTestId('mention-search'), { target: { value: 'zzz' } })
    expect(screen.queryAllByTestId('mention-item')).toHaveLength(0)
    expect(screen.getByTestId('mention-menu').textContent).toMatch(/nenhum terminal/i)
  })

  /** Duas referências na mesma frase — coordenar costuma envolver mais de um. */
  it('dá para referenciar mais de um na mesma mensagem', () => {
    abrir()
    digitar('avise @@')
    fireEvent.mouseDown(screen.getAllByTestId('mention-item')[0])
    digitar(`${campo().value}e também @@`)
    fireEvent.mouseDown(screen.getAllByTestId('mention-item')[1])
    expect(campo().value).toBe('avise @[Vaexa - Admin] e também @[Sessão de Testes] ')
  })
})
