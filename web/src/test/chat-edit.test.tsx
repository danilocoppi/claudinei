import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
// A conversa é uma lista virtual: sem medidas fixas, o jsdom não montaria nada.
import { renderComJanela as render } from './viewport'
import { ChatView } from '../components/ChatView'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { ChatItem } from '../types'

const u = (text: string): ChatItem => ({ kind: 'user_text', text })

function setup(status: 'working' | 'idle', items: ChatItem[]) {
  useStore.setState({
    projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
    sessions: { s1: { localId: 's1', projectId: 1, status } as never },
    chat: { s1: items }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
    activeLocalId: 's1', view: 'chat', editRequest: undefined,
  })
}
beforeEach(() => {
  // O campo agora começa no rascunho gravado (drafts.ts): sem limpar, o texto
  // de um caso pré-preenche o seguinte.
  localStorage.clear()
  // O diálogo de editar busca as opções da volta; aqui elas não importam.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ error: 'nada' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('editar mensagem', () => {
  it('lápis aparece só nas últimas 5 mensagens do usuário', async () => {
    setup('idle', [u('m1'), u('m2'), u('m3'), u('m4'), u('m5'), u('m6')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    expect(await screen.findAllByLabelText('Editar esta mensagem')).toHaveLength(5) // m2..m6
  })

  it('lápis durante working abre o diálogo com o aviso de interrupção; Copiar para o campo NÃO interrompe e registra o editRequest', async () => {
    const send = vi.fn()
    setup('working', [u('instrução errada')])
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(await screen.findByLabelText('Editar esta mensagem'))
    // ainda NÃO interrompeu: abriu o diálogo, com o aviso dentro dele
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    const dlg = screen.getByRole('dialog', { name: 'Editar a partir daqui' })
    expect(within(dlg).getByText('Editar interrompe o turno em andamento.')).toBeTruthy()
    expect(screen.queryByText('Editar e interromper?')).toBeNull()
    fireEvent.click(within(dlg).getByRole('button', { name: 'Copiar para o campo' }))
    // Copiar o texto não exige parar o turno (R24): só as duas voltas interrompem.
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    expect(useStore.getState().editRequest).toMatchObject({ localId: 's1', text: 'instrução errada' })
  })

  it('cancelar o diálogo NÃO interrompe nem registra edição (mensagem na fila fica intacta)', async () => {
    const send = vi.fn()
    setup('working', [u('mensagem na fila')])
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(await screen.findByLabelText('Editar esta mensagem'))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Editar a partir daqui' })).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog', { name: 'Editar a partir daqui' })).toBeNull()
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    expect(useStore.getState().editRequest).toBeUndefined()
  })

  it('fora de working, Copiar para o campo NÃO envia interrupt', async () => {
    const send = vi.fn()
    setup('idle', [u('só recuperar')])
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(await screen.findByLabelText('Editar esta mensagem'))
    const dlg = screen.getByRole('dialog', { name: 'Editar a partir daqui' })
    expect(within(dlg).queryByText('Editar interrompe o turno em andamento.')).toBeNull()
    fireEvent.click(within(dlg).getByRole('button', { name: 'Copiar para o campo' }))
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    expect(useStore.getState().editRequest).toMatchObject({ text: 'só recuperar' })
  })

  it('editRequest preenche o campo do ChatInput', async () => {
    setup('idle', [])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    useStore.getState().requestEdit('s1', 'texto recuperado')
    await waitFor(() => expect(textarea.value).toBe('texto recuperado'))
  })

  it('↑ no campo vazio navega o histórico; ↓ sai limpando', async () => {
    setup('idle', [u('antiga'), u('recente')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('recente')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('antiga')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('recente')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('')
  })

  it('↑ com texto no campo não intercepta (cursor nativo)', () => {
    setup('idle', [u('antiga')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'digitando' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('digitando')
  })

  it('recuperar um comando slash do histórico NÃO abre o menu; ↑ segue navegando e Enter envia', async () => {
    const send = vi.fn()
    useStore.setState({ slashCommands: ['compact', 'cost'] } as never)
    setup('idle', [u('mensagem normal'), u('/compact')])
    render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('/compact')
    expect(screen.queryByTestId('slash-menu')).toBeNull() // menu NÃO abriu
    fireEvent.keyDown(textarea, { key: 'ArrowUp' }) // continua navegando o histórico
    expect(textarea.value).toBe('mensagem normal')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('/compact')
    fireEvent.keyDown(textarea, { key: 'Enter' }) // envia, não faz pickSlash
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/compact' })
    expect(textarea.value).toBe('')
  })

  it('digitar após recuperar do histórico reabilita o menu de slash', async () => {
    useStore.setState({ slashCommands: ['compact'] } as never)
    setup('idle', [u('/compact')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'ArrowUp' }) // '/compact' via histórico, menu suprimido
    fireEvent.change(textarea, { target: { value: '/co' } }) // digitou → saiu do modo histórico
    expect(screen.getByTestId('slash-menu')).toBeTruthy() // menu voltou
    const items = screen.getAllByTestId('slash-item').map((el) => el.textContent)
    expect(items.some((t) => t?.includes('/compact'))).toBe(true)
  })
})
