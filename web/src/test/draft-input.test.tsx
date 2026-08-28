import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import { readDraft } from '../drafts'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number): SessionInfo =>
  ({ localId, projectId, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

let enviadas: any[]
const ws = { send: (m: any) => enviadas.push(m) } as never

beforeEach(() => {
  enviadas = []
  localStorage.clear()
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' },
               { id: 2, name: 'Beta', path: '/b', color: '#fff', icon: '📦' }],
    groups: [], sectors: [], schedules: [],
    sessions: { s1: sess('s1', 1), s2: sess('s2', 2) },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** O ChatInput é remontado a cada troca (key={localId}) — como no app de verdade. */
const abrir = (localId: string) =>
  render(<WsContext.Provider value={ws}><ChatInput key={localId} localId={localId} disabled={false} /></WsContext.Provider>)

const campo = () => screen.getByRole('textbox') as HTMLTextAreaElement
const digitar = (texto: string) => fireEvent.change(campo(), { target: { value: texto } })

/**
 * Trocar de terminal no meio de uma frase e voltar para achá-la intacta. Sem isto
 * o texto sumia na troca, sem aviso e sem como recuperar.
 */
describe('o que foi digitado espera você voltar', () => {
  it('volta ao trocar de terminal e retornar', () => {
    abrir('s1')
    digitar('comecei a escrever aqui')
    cleanup()

    abrir('s2')
    expect(campo().value, 'o rascunho vazou para o outro terminal').toBe('')
    cleanup()

    abrir('s1')
    expect(campo().value).toBe('comecei a escrever aqui')
  })

  it('cada terminal guarda o seu', () => {
    abrir('s1'); digitar('texto do primeiro'); cleanup()
    abrir('s2'); digitar('texto do segundo'); cleanup()
    abrir('s1'); expect(campo().value).toBe('texto do primeiro'); cleanup()
    abrir('s2'); expect(campo().value).toBe('texto do segundo')
  })

  /** Enviado é enviado: o rascunho some junto, senão a frase voltaria duplicada. */
  it('enviar limpa o rascunho', () => {
    abrir('s1')
    digitar('vai agora')
    fireEvent.keyDown(campo(), { key: 'Enter' })
    expect(enviadas[0]).toMatchObject({ type: 'send_message', text: 'vai agora' })
    expect(readDraft('s1')).toBe('')
    cleanup()
    abrir('s1')
    expect(campo().value).toBe('')
  })

  it('apagar o que se escreveu apaga o rascunho', () => {
    abrir('s1')
    digitar('escrevi')
    digitar('')
    cleanup()
    abrir('s1')
    expect(campo().value).toBe('')
  })

  /** O `!comando` também sai do campo — e não pode deixar rastro. */
  it('o comando de shell também limpa', () => {
    abrir('s1')
    digitar('!ls')
    fireEvent.keyDown(campo(), { key: 'Enter' })
    expect(enviadas[0]).toMatchObject({ type: 'shell' })
    expect(readDraft('s1')).toBe('')
  })

  it('o rascunho chega no disco, não só na memória do componente', () => {
    abrir('s1')
    digitar('está gravado')
    expect(readDraft('s1')).toBe('está gravado')
  })
})
