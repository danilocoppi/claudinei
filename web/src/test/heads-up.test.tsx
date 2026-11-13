import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { HeadsUpBand } from '../components/HeadsUpBand'
import { SessionControls } from '../components/SessionControls'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { nextHeadsUps } from '../headsUp'
import type { HeadsUpNode, SessionInfo } from '../types'

/**
 * Avisos do plugin "You should know" do Claude acima do campo de digitação: o
 * cartão que o plugin desenha (texto, Markdown, botões dele), um X para fechar,
 * e vários empilhados um embaixo do outro.
 */
const PLUGIN = 'cc-plugin-you-should-know'
const btn = (handle: number, label: string, extra: Record<string, unknown> = {}): HeadsUpNode =>
  ({ type: 'Button', props: { key: `b${handle}`, label, ...extra }, press: { plugin: PLUGIN, handle } })
const card = (title: string, body: string, buttons: HeadsUpNode[]): HeadsUpNode => ({ type: 'Box', props: { flexDirection: 'column' }, children: [
  { type: 'Text', props: { bold: true, color: 'warning' }, children: ['Heads up'] },
  { type: 'Text', props: { bold: true }, children: [title] },
  { type: 'Markdown', props: { text: body } },
  { type: 'Box', props: { flexDirection: 'row' }, children: buttons },
  btn(1, 'Dispensar', { role: 'dismiss' }),
] })
const RISCO = 'O lucro de 27% esconde um risco de perda grande'
const oferta = card(RISCO, '- A posição aberta está em **-19%**.', [btn(2, 'Explique', { variant: 'primary' }), btn(3, 'Já sabia')])
const explicado = card(RISCO, 'Somando a posição aberta, a queda real passa de 20%.', [btn(7, 'Entendi')])
const backup = card('O backup de ontem não rodou e ninguém percebeu', 'O cron parou às 02:00.', [btn(5, 'Explique')])

beforeEach(() => {
  useStore.setState({ headsUps: {}, dismissedHeadsUps: {}, sessions: {}, projects: [{ id: 1, name: 'P', path: '/p', color: '#fff', icon: '📁', headsUp: true }] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('pilha de avisos (nextHeadsUps)', () => {
  it('o mesmo assunto atualiza no lugar; outro assunto empilha e o anterior fica só leitura', () => {
    let cards = nextHeadsUps([], oferta)
    expect(cards.map((c) => c.live)).toEqual([true])
    cards = nextHeadsUps(cards, explicado)
    expect(cards).toHaveLength(1)
    expect(JSON.stringify(cards[0].tree)).toContain('Somando a posição aberta')
    cards = nextHeadsUps(cards, backup)
    expect(cards.map((c) => c.live)).toEqual([false, true])
    expect(JSON.stringify(cards[0].tree)).toContain('Somando a posição aberta')
  })

  it('quando o plugin tira o cartão, sai o vivo e ficam os antigos', () => {
    let cards = nextHeadsUps(nextHeadsUps([], oferta), backup)
    cards = nextHeadsUps(cards, null)
    expect(cards.map((c) => c.live)).toEqual([false])
    expect(nextHeadsUps([], null)).toEqual([])
  })

  it('a pilha guarda no máximo 4', () => {
    let cards = nextHeadsUps([], null)
    for (let i = 0; i < 6; i++) cards = nextHeadsUps(cards, card(`Assunto número ${i} com um título bem comprido`, 'x', []))
    expect(cards).toHaveLength(4)
    expect(JSON.stringify(cards.at(-1)!.tree)).toContain('Assunto número 5')
  })
})

describe('faixa de avisos acima do campo', () => {
  const show = (localId = 's1') => {
    const send = vi.fn()
    render(<WsContext.Provider value={{ send }}><HeadsUpBand localId={localId} /></WsContext.Provider>)
    return send
  }

  it('sem aviso não desenha nada', () => {
    const { container } = render(<HeadsUpBand localId="s1" />)
    expect(container.innerHTML).toBe('')
  })

  it('desenha o cartão do plugin: etiqueta, título, Markdown e os botões dele', () => {
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: oferta })
    show()
    const region = screen.getByRole('region', { name: 'Avisos do Claude' })
    expect(within(region).getByText('Heads up')).toBeTruthy()
    expect(within(region).getByText(RISCO)).toBeTruthy()
    expect(within(region).getByText('-19%').tagName).toBe('STRONG')
    expect(within(region).getByRole('button', { name: 'Explique' })).toBeTruthy()
    // o "dispensar" do plugin vira o X, não um botão a mais no corpo
    expect(within(region).queryByRole('button', { name: 'Dispensar' })).toBeNull()
  })

  it('os botões do cartão vão ao plugin pelo WebSocket', () => {
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: oferta })
    const send = show()
    fireEvent.click(screen.getByRole('button', { name: 'Explique' }))
    expect(send).toHaveBeenCalledWith({ type: 'heads_up_press', localId: 's1', press: { plugin: PLUGIN, handle: 2, key: 'b2' } })
  })

  it('o X do aviso vivo usa o dispensar do plugin e o tira da tela', () => {
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: oferta })
    const send = show()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }))
    expect(send).toHaveBeenCalledWith({ type: 'heads_up_press', localId: 's1', press: { plugin: PLUGIN, handle: 1, key: 'b1' } })
    expect(screen.queryByText(RISCO)).toBeNull()
    // o mesmo cartão chegando de novo (snapshot) não volta
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: oferta })
    expect(screen.queryByText(RISCO)).toBeNull()
  })

  it('vários avisos empilham, o mais novo embaixo; o antigo fica só leitura e o X dele só fecha aqui', () => {
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: oferta })
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: backup })
    const send = show()
    const cards = screen.getAllByRole('article')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByText(RISCO)).toBeTruthy()
    expect(within(cards[1]).getByText(/O backup de ontem/)).toBeTruthy()
    expect((within(cards[0]).getByRole('button', { name: 'Explique' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(cards[0]).getByRole('button', { name: 'Fechar aviso' }))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('cada chat mostra só os seus avisos', () => {
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 'outro', projectId: 1, tree: oferta })
    const { container } = render(<HeadsUpBand localId="s1" />)
    expect(container.innerHTML).toBe('')
  })

  it('o snapshot das sessões traz o aviso de quem chega depois', () => {
    useStore.getState().applyWsMessage({ type: 'sessions_snapshot', sessions: [
      { localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', headsUp: oferta },
    ] })
    show()
    expect(screen.getByText(RISCO)).toBeTruthy()
  })

  it('link só abre http/https, e passa pela confirmação de link externo', () => {
    const openExternalLink = vi.fn()
    useStore.setState({ openExternalLink })
    useStore.getState().applyWsMessage({ type: 'heads_up', localId: 's1', projectId: 1, tree: { type: 'Box', children: [
      { type: 'Link', props: { href: 'https://exemplo.com/pagina', label: 'Página explicativa' } },
      { type: 'Link', props: { href: 'javascript:alert(1)', label: 'Perigoso' } },
    ] } })
    show()
    fireEvent.click(screen.getByText('Página explicativa'))
    expect(openExternalLink).toHaveBeenCalledWith('https://exemplo.com/pagina')
    expect(screen.getByText('Perigoso').closest('a')).toBeNull()
  })
})

describe('interruptor dos avisos no terminal', () => {
  const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
    ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', engine: 'claude', ...o })

  it('no Claude, desliga os avisos do terminal pela API e atualiza a tela', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => new Response(
      String(url).includes('/heads-up') ? JSON.stringify({ id: 1, name: 'P', path: '/p', color: '#fff', icon: '📁', headsUp: false }) : '{}',
      { status: 200, headers: { 'Content-Type': 'application/json' } }))
    useStore.setState({ engines: [{ id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: [], permissions: [], slashSource: 'protocol', slashCommands: [], contextManagement: true }] })
    render(<WsContext.Provider value={{ send: vi.fn() }}><SessionControls session={sess()} /></WsContext.Provider>)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    const toggle = screen.getByRole('checkbox', { name: /Avisos "You should know"/ }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => expect(useStore.getState().projects[0].headsUp).toBe(false))
    const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/api/projects/1/heads-up'))!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ headsUp: false })
  })

  it('fora do Claude o interruptor não aparece', () => {
    useStore.setState({ engines: [{ id: 'codex', label: 'Codex', icon: '◆', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] }] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(<WsContext.Provider value={{ send: vi.fn() }}><SessionControls session={sess({ engine: 'codex' })} /></WsContext.Provider>)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    expect(screen.queryByRole('checkbox', { name: /Avisos "You should know"/ })).toBeNull()
  })
})
