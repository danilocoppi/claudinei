import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { SessionControls } from '../components/SessionControls'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo } from '../types'

const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', engine: 'claude', ...o })

// Espelha as capabilities reais do backend (server/src/engine/{claude,codex}).
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: '✳',
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'],
  slashSource: 'protocol', slashCommands: [],
}
const CODEX: EngineMeta = {
  id: 'codex', label: 'Codex', icon: '◆',
  models: ['', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  permissions: [],
  slashSource: 'curated', slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(sess({ permissionMode: 'plan' })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  useStore.setState({ engines: [CLAUDE, CODEX] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const renderWithWs = (session: SessionInfo, send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><SessionControls session={session} /></WsContext.Provider>)
  return send
}

describe('SessionControls', () => {
  it('pill discreto (só engrenagem) abre o popover mostrando o modelo atual', () => {
    render(<SessionControls session={sess()} />)
    // o pill não exibe mais o texto do modelo — só a engrenagem
    expect(screen.getByTestId('session-controls-pill').textContent).toContain('⚙')
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    expect(screen.getByText('Opus')).toBeTruthy() // o modelo aparece no popover
    expect(screen.getByText('Plano')).toBeTruthy() // label pt do modo plan (setup fixa pt-BR)
  })

  it('clicar um modo faz PATCH /options', async () => {
    render(<SessionControls session={sess()} />)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    fireEvent.click(screen.getByText('Plano'))
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/s1/options', expect.objectContaining({ method: 'PATCH' })))
  })

  it('desabilitado quando a sessão está trabalhando', () => {
    render(<SessionControls session={sess({ status: 'working' })} />)
    expect((screen.getByTestId('session-controls-pill') as HTMLButtonElement).disabled).toBe(true)
  })

  describe('effort', () => {
    // slashCommands simula o farejamento do evento `init` do protocolo do Claude,
    // que traz 'effort' entre os slash commands — é essa lista (não um hardcode de
    // engine) que decide se o /effort é enviado como mensagem de chat (SP-C Task 5).
    beforeEach(() => { useStore.setState({ sessionEffort: {}, chat: {}, sessions: {}, unread: {}, streaming: {}, slashCommands: ['compact', 'cost', 'context', 'usage', 'clear', 'model', 'mcp', 'agents', 'effort'] }) })

    it('popover lista os 7 níveis com auto (padrão) marcado por default', () => {
      renderWithWs(sess())
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
        expect(screen.getByText(lvl)).toBeTruthy()
      }
      const auto = screen.getByText('auto (padrão)')
      expect(auto.closest('.sess-pop__item')?.querySelector('.sess-pop__check')).toBeTruthy()
    })

    it('clicar um nível envia /effort <nível> como mensagem e registra no chat local', () => {
      const send = renderWithWs(sess())
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      fireEvent.click(screen.getByText('xhigh'))
      expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/effort xhigh' })
      const chat = useStore.getState().chat['s1'] ?? []
      expect(chat.some((i) => i.kind === 'user_text' && i.text === '/effort xhigh')).toBe(true)
    })

    it('clicar um nível persistível também faz PATCH /options com o effort', async () => {
      renderWithWs(sess())
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      fireEvent.click(screen.getByText('max'))
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/s1/options',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ effort: 'max' }) })))
    })

    it('ultracode NÃO persiste (só aplica na sessão atual) e mostra a dica', async () => {
      renderWithWs(sess())
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      fireEvent.click(screen.getByText('ultracode'))
      // nenhuma chamada PATCH com effort
      const patches = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH' && String((init as RequestInit).body).includes('effort'))
      expect(patches).toHaveLength(0)
      useStore.setState({ sessionEffort: { s1: 'ultracode' } })
      expect(await screen.findByText(/ultracode/i, { selector: '.sess-pop__warn' })).toBeTruthy()
    })

    it('✓ usa o persistido (session.effort) quando não há valor farejado', () => {
      renderWithWs(sess({ effort: 'high' }))
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      expect(screen.getByText('high').closest('.sess-pop__item')?.querySelector('.sess-pop__check')).toBeTruthy()
    })

    it('✓ segue o valor farejado no store', () => {
      useStore.setState({ sessionEffort: { s1: 'max' } })
      renderWithWs(sess())
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      const max = screen.getByText('max')
      expect(max.closest('.sess-pop__item')?.querySelector('.sess-pop__check')).toBeTruthy()
      expect(screen.getByText('auto (padrão)').closest('.sess-pop__item')?.querySelector('.sess-pop__check')).toBeNull()
    })
  })

  describe('sessão Codex (SP-C Task 5: controls dirigidos pela engine)', () => {
    const codexSess = (o: Partial<SessionInfo> = {}) => sess({ engine: 'codex', model: 'gpt-5.6-sol', ...o })

    it('esconde a seção de permissão (Codex não tem permissions)', () => {
      render(<SessionControls session={codexSess()} />)
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      expect(screen.queryByText('Permissão')).toBeNull() // eyebrow da seção (pt-BR fixado no setup)
    })

    it('lista os efforts do Codex (sem auto/ultracode, que são só do Claude)', () => {
      render(<SessionControls session={codexSess()} />)
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      for (const lvl of CODEX.efforts) expect(screen.getByText(lvl)).toBeTruthy()
      expect(screen.queryByText('ultracode')).toBeNull()
    })

    it('lista os modelos do Codex, com o id cru como label (sem chave i18n)', () => {
      render(<SessionControls session={codexSess()} />)
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      expect(screen.getByText('gpt-5.6-sol')).toBeTruthy()
      expect(screen.getByText('gpt-5.6-terra')).toBeTruthy()
    })

    it('clicar um effort do Codex faz PATCH mas NÃO envia /effort como mensagem (curada não traz "effort")', async () => {
      const send = vi.fn()
      useStore.setState({ sessionEffort: {}, chat: {}, sessions: {}, unread: {}, streaming: {} })
      render(<WsContext.Provider value={{ send }}><SessionControls session={codexSess()} /></WsContext.Provider>)
      fireEvent.click(screen.getByTestId('session-controls-pill'))
      fireEvent.click(screen.getByText('high'))

      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/s1/options',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ effort: 'high' }) })))
      expect(send).not.toHaveBeenCalled()
    })
  })
})
