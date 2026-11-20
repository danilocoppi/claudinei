import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler } from 'react'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return {
    ...real,
    fetchAutoCompact: vi.fn(async () => ({ pct: 0 })),
    fetchProgress: vi.fn(async () => ({ progress: null, path: '' })),
    usageLimitAction: vi.fn(),
  }
})

import { ProgressColumn } from '../components/ProgressColumn'
import { GoalNotice } from '../components/GoalNotice'
import { GoalCardMarker } from '../components/Sidebar'
import { Sidebar } from '../components/Sidebar'
import { ChatView } from '../components/ChatView'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore, progressKey } from '../store'
import { BUILTIN_FALLBACK, SLASH_DESCRIPTIONS, filterCommands } from '../slash'
import en from '../i18n/en'
import ptBR from '../i18n/pt-BR'
import es from '../i18n/es'
import type { EngineMeta, SessionInfo, SessionStatus, TerminalGoal, TerminalState } from '../types'

/**
 * Goal na interface: o bloco "Objetivo" no topo da coluna de acompanhamento, o
 * aviso de pausa/teto com Retomar e Encerrar, o selo estático "🎯 n/20" no
 * cartão da lateral e o `/goal` no autocomplete. Ver
 * docs/superpowers/specs/2026-11-20-delegar-e-goals-design.md.
 */

const objetivo = (o: Partial<TerminalGoal> = {}): TerminalGoal => ({
  criterion: 'os testes da web passam', status: 'active', pause: null, turns: 3, max: 20, evidence: null, ...o,
})
const estado = (o: Partial<TerminalState> = {}): TerminalState => ({
  projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null,
  autoResumeLimit: false, usageLimit: null, taskResults: [], taskResultsHeld: false, goal: null, ...o,
})
const comGoal = (g: Partial<TerminalGoal> = {}, o: Partial<TerminalState> = {}) => estado({ goal: objetivo(g), ...o })
const sess = (localId: string, status: SessionStatus, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', model: 'opus', engine: 'claude', ...o })
const poe = (...states: TerminalState[]) =>
  useStore.setState({ terminalStates: Object.fromEntries(states.map((s) => [progressKey(s.projectId, s.engine), s])) })

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ terminalStates: {}, progress: {}, progressOpen: true, projects: [], sessions: { s1: sess('s1', 'idle') } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('bloco Objetivo na coluna', () => {
  it('bloco Objetivo mostra critério, turno e estado; evidência quando cumprido', async () => {
    poe(comGoal())
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="working" />)
    const bloco = screen.getByTestId('goal-block')
    expect(within(bloco).getByText('Objetivo')).toBeTruthy()
    expect(within(bloco).getByText('os testes da web passam')).toBeTruthy()
    expect(within(bloco).getByText('turno 3/20')).toBeTruthy()
    expect(within(bloco).getByText('ativo')).toBeTruthy()
    // No topo: antes do vazio do acompanhamento (a coluna mostra o bloco mesmo sem update_progress).
    const vazio = await screen.findByText(/ainda não tem tarefa longa/)
    expect(bloco.compareDocumentPosition(vazio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(bloco).queryByText('Evidência')).toBeNull()

    act(() => useStore.getState().setTerminalState(comGoal({ status: 'waiting' })))
    expect(within(bloco).getByText('esperando tarefas')).toBeTruthy()
    act(() => useStore.getState().setTerminalState(comGoal({ status: 'paused', pause: 'interrupt' })))
    expect(within(bloco).getByText('pausado: o turno foi interrompido')).toBeTruthy()
    act(() => useStore.getState().setTerminalState(comGoal({ status: 'cap', turns: 20 })))
    expect(within(bloco).getByText('turno 20/20')).toBeTruthy()
    expect(within(bloco).getByText('chegou ao teto')).toBeTruthy()

    act(() => useStore.getState().setTerminalState(comGoal({ status: 'done', turns: 5, evidence: '1.560 testes passaram' })))
    const cumprido = screen.getByTestId('goal-block')
    expect(within(cumprido).getByText('cumprido')).toBeTruthy()
    expect(within(cumprido).getByText('Evidência')).toBeTruthy()
    expect(within(cumprido).getByText('1.560 testes passaram')).toBeTruthy()

    act(() => useStore.getState().setTerminalState(estado()))
    expect(screen.queryByTestId('goal-block')).toBeNull()
  })

  it('o goal de outro motor do mesmo projeto não aparece na coluna deste', () => {
    poe(comGoal({}, { engine: 'codex' }))
    render(<ProgressColumn projectId={1} engine="claude" sessionStatus="idle" />)
    expect(screen.queryByTestId('goal-block')).toBeNull()
  })
})

describe('aviso do goal pausado ou no teto', () => {
  const abre = (localId = 's1', status: SessionStatus = 'idle') => {
    const send = vi.fn()
    render(<WsContext.Provider value={{ send }}>
      <GoalNotice projectId={1} engine="claude" localId={localId} sessionStatus={status} />
    </WsContext.Provider>)
    return send
  }

  it('GoalNotice pausado: Retomar manda /goal resume; Encerrar manda /goal stop', () => {
    poe(comGoal({ status: 'paused', pause: 'operator' }))
    const send = abre()
    expect(screen.getByText('Objetivo pausado: você mandou uma mensagem.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/goal resume' })
    cleanup()
    const send2 = abre()
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(send2).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/goal stop' })
  })

  it.each([
    ['error', 'o turno terminou com erro'],
    ['limit', 'o terminal bateu o limite de uso'],
    ['interrupt', 'o turno foi interrompido'],
  ] as const)('pausa por %s mostra o motivo', (pause, motivo) => {
    poe(comGoal({ status: 'paused', pause }))
    abre()
    expect(screen.getByText(`Objetivo pausado: ${motivo}.`)).toBeTruthy()
  })

  it('no teto: diz o teto e oferece Retomar', () => {
    poe(comGoal({ status: 'cap', turns: 20 }))
    const send = abre()
    expect(screen.getByText('O objetivo chegou ao teto de 20 turnos sem ser cumprido.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/goal resume' })
  })

  it.each(['active', 'waiting', 'done'] as const)('%s: sem aviso', (status) => {
    poe(comGoal({ status }))
    const { container } = render(<WsContext.Provider value={{ send: vi.fn() }}>
      <GoalNotice projectId={1} engine="claude" localId="s1" sessionStatus="idle" />
    </WsContext.Provider>)
    expect(container.textContent).toBe('')
  })

  it('sem goal: sem aviso', () => {
    poe(estado())
    const { container } = render(<WsContext.Provider value={{ send: vi.fn() }}>
      <GoalNotice projectId={1} engine="claude" localId="s1" sessionStatus="idle" />
    </WsContext.Provider>)
    expect(container.textContent).toBe('')
  })

  it.each(['stopped', 'dead', 'in_terminal'] as const)('sessão %s: mostra o motivo, sem os botões (o envio seria recusado)', (status) => {
    poe(comGoal({ status: 'paused', pause: 'error' }))
    abre('s1', status)
    expect(screen.getByText('Objetivo pausado: o turno terminou com erro.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retomar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Encerrar' })).toBeNull()
    expect(screen.getByText(/Inicie o terminal para retomar ou encerrar/)).toBeTruthy()
  })

  it('o clique não repete o envio até o estado do goal mudar', () => {
    poe(comGoal({ status: 'paused', pause: 'operator' }))
    const send = abre()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    expect((screen.getByRole('button', { name: 'Retomar' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Encerrar' }) as HTMLButtonElement).disabled).toBe(true)
    // Pausa de novo (outro motivo): os botões voltam.
    act(() => useStore.getState().setTerminalState(comGoal({ status: 'paused', pause: 'error', turns: 4 })))
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('envio recusado ou perdido (erro do WebSocket para este chat) solta os botões', () => {
    poe(comGoal({ status: 'paused', pause: 'operator' }))
    const send = abre()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    expect((screen.getByRole('button', { name: 'Retomar' }) as HTMLButtonElement).disabled).toBe(true)
    // Erro de outro chat não solta.
    act(() => useStore.getState().applyWsMessage({ type: 'error', localId: 's2', message: 'x' }))
    expect((screen.getByRole('button', { name: 'Retomar' }) as HTMLButtonElement).disabled).toBe(true)
    // O servidor recusou (ou o envio expirou na conexão caída): o goal não mudou, e o operador pode tentar de novo.
    act(() => useStore.getState().applyWsMessage({ type: 'error', localId: 's1', message: 'session_not_active' }))
    expect((screen.getByRole('button', { name: 'Retomar' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a sessão mudou de estado depois do clique: os botões voltam', () => {
    poe(comGoal({ status: 'paused', pause: 'operator' }))
    const send = vi.fn()
    const ui = (status: SessionStatus) => <WsContext.Provider value={{ send }}>
      <GoalNotice projectId={1} engine="claude" localId="s1" sessionStatus={status} />
    </WsContext.Provider>
    const { rerender } = render(ui('working'))
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect((screen.getByRole('button', { name: 'Encerrar' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(ui('idle'))
    expect((screen.getByRole('button', { name: 'Encerrar' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('montado no ChatView, acima do campo', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁', engines: ['claude'] }],
      sessions: { s1: sess('s1', 'idle') }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
      view: 'chat', activeLocalId: 's1', engines: [], progressOpen: false,
    })
    poe(comGoal({ status: 'cap', turns: 20 }))
    const send = vi.fn()
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    expect(await screen.findByText('O objetivo chegou ao teto de 20 turnos sem ser cumprido.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '/goal stop' })
  })
})

describe('selo no cartão da lateral', () => {
  const projetos = () => useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '📁' },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '📁' },
    ],
    groups: [], sectors: [], schedules: [],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined,
  })
  const cartao = (nome: string) => screen.getAllByTestId('term-card').find((c) => within(c).queryByText(nome))!
  beforeEach(() => { projetos(); localStorage.removeItem('claudinei:collapsedCards') })

  it('selo 🎯 n/20 no cartão; some com goal null; sem animação (sem classe de pulso)', () => {
    poe(comGoal({ turns: 7 }))
    render(<Sidebar />)
    const selo = within(cartao('Alpha')).getByTestId('goal-marker')
    expect(selo.textContent).toBe('🎯 7/20')
    expect(selo.getAttribute('title')).toBe('Objetivo: turno 7/20 · ativo')
    expect(selo.className).not.toMatch(/pulse|sonar|anim|blink|spin/i)
    // Cartão expandido: na linha de status, como a marca do limite — não na do
    // nome, que ele espremia até sumir (D1). Um selo só no cartão.
    expect(selo.parentElement).toBe(cartao('Alpha').querySelector('.term-card__status'))
    expect(selo.className).toMatch(/term-card__goal--in-status/)
    expect(within(cartao('Alpha')).getAllByTestId('goal-marker')).toHaveLength(1)
    expect(within(cartao('Beta')).queryByTestId('goal-marker')).toBeNull()

    act(() => useStore.getState().setTerminalState(comGoal({ status: 'waiting', turns: 8 })))
    expect(within(cartao('Alpha')).getByTestId('goal-marker').getAttribute('title')).toBe('Objetivo: turno 8/20 · esperando tarefas')

    act(() => useStore.getState().setTerminalState(estado()))
    expect(screen.queryByTestId('goal-marker')).toBeNull()

    // No CSS, nenhuma regra do selo anima.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')
    const regras = [...css.matchAll(/([^{}]*\.term-card__goal[^{}]*)\{([^{}]*)\}/g)]
    expect(regras.length).toBeGreaterThan(0)
    for (const [, , corpo] of regras) expect(corpo).not.toMatch(/animation|transition/)
    // O selo encolhe antes do nome (com reticências) e nunca é rígido: `flex: none`
    // com nowrap espremia o nome do projeto a 0-2 px.
    // O seletor capturado leva o comentário que o precede: vale a última linha.
    const seletor = (sel: string) => sel.trim().split('\n').pop()!.trim()
    const base = regras.find(([, sel]) => seletor(sel) === '.term-card__goal')![2]
    expect(base).not.toMatch(/flex:\s*none/)
    expect(base).toMatch(/flex:\s*0 4 auto/)
    expect(base).toMatch(/min-width:\s*0/)
    expect(base).toMatch(/overflow:\s*hidden/)
    expect(base).toMatch(/text-overflow:\s*ellipsis/)
    const naLinhaDeStatus = regras.find(([, sel]) => seletor(sel) === '.term-card__goal--in-status')
    expect(naLinhaDeStatus?.[2]).toMatch(/flex:\s*0 1 auto/)
  })

  it('colapsado: o selo segue na linha do nome', () => {
    localStorage.setItem('claudinei:collapsedCards', '[1]')
    poe(comGoal({ status: 'paused', pause: 'operator' }))
    render(<Sidebar />)
    const card = cartao('Alpha')
    expect(within(card).getByTestId('goal-marker').parentElement).toBe(card.querySelector('.term-card__title'))
    expect(within(card).getByTestId('goal-marker').className).not.toMatch(/in-status/)
    expect(within(card).getAllByTestId('goal-marker')).toHaveLength(1)
  })

  it('mudança de outro terminal não re-renderiza o cartão', () => {
    // A marca em si: o goal de outro projeto e o resto do estado deste terminal não a redesenham.
    poe(comGoal({ turns: 2 }), estado({ projectId: 2 }))
    let marca = 0
    render(<Profiler id="marca" onRender={() => { marca++ }}><GoalCardMarker projectId={1} /></Profiler>)
    expect(screen.getByTestId('goal-marker').textContent).toBe('🎯 2/20')
    const antes = marca
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 9 }, { projectId: 2 })))
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 10 }, { projectId: 2 })))
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 2, evidence: 'x', criterion: 'outro texto' }, { autostart: true })))
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 2 }, { taskResults: [{ id: 3, toProjectName: 'B', status: 'completed' }] })))
    expect(marca, 'a marca redesenhou por mudança que ela não mostra').toBe(antes)
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 3 })))
    expect(marca, 'a marca não redesenhou com o turno novo').toBeGreaterThan(antes)
    expect(screen.getByTestId('goal-marker').textContent).toBe('🎯 3/20')
    cleanup()

    // A lateral inteira: estado de outro terminal (sem goal) mudado não a redesenha.
    poe(comGoal({ turns: 2 }), estado({ projectId: 2 }))
    let lateral = 0
    render(<Profiler id="lateral" onRender={() => { lateral++ }}><Sidebar /></Profiler>)
    const antesLateral = lateral
    act(() => useStore.getState().setTerminalState(estado({ projectId: 2, autostart: true })))
    act(() => useStore.getState().setTerminalState(estado({ projectId: 2, taskResults: [{ id: 4, toProjectName: 'A', status: 'failed' }] })))
    act(() => useStore.getState().setTerminalState(comGoal({ turns: 2, evidence: 'y' })))
    expect(lateral, 'a lateral redesenhou por mudança de outro terminal').toBe(antesLateral)
  })
})

describe('/goal no autocomplete', () => {
  const CLAUDE: EngineMeta = {
    id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
    permissions: ['default'], slashSource: 'protocol', slashCommands: [],
  }
  const meta = (id: string, slashSource: EngineMeta['slashSource'], slashCommands: string[] = []): EngineMeta =>
    ({ id, label: id, icon: id, models: [''], efforts: [], permissions: [], slashSource, slashCommands })

  it('/goal digitado não vira balão do operador no chat (o servidor o intercepta)', () => {
    useStore.setState({
      engines: [CLAUDE], slashCommands: [],
      sessions: { s1: sess('s1', 'idle') }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    })
    const send = vi.fn()
    render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const box = screen.getByRole('textbox')
    for (const text of ['/goal testes verdes', '/goal stop']) {
      fireEvent.change(box, { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: /enviar|send/i }))
      expect(send).toHaveBeenLastCalledWith({ type: 'send_message', localId: 's1', text })
    }
    expect(useStore.getState().chat.s1).toEqual([])
    // Outro texto que só começa parecido segue virando balão.
    fireEvent.change(box, { target: { value: '/goalx algo' } })
    fireEvent.click(screen.getByRole('button', { name: /enviar|send/i }))
    expect(useStore.getState().chat.s1).toEqual([{ kind: 'user_text', text: '/goalx algo' }])
  })

  it('/goal aparece no autocomplete', () => {
    expect(BUILTIN_FALLBACK).toContain('goal')
    expect(SLASH_DESCRIPTIONS.goal).toBe('slash.goal')
    for (const dict of [en, ptBR, es]) expect((dict.slash as Record<string, string>).goal).toBeTruthy()
    expect(filterCommands(['compact', 'goal'], 'go')).toEqual(['goal'])
  })

  it.each([
    // O Claude depois do init: a lista do protocolo não traz o /goal, que é do Claudinei.
    ['claude (protocolo)', CLAUDE, ['compact', 'cost']],
    ['codex (curado)', meta('codex', 'curated', ['model', 'review']), []],
    ['kimi (sem slash)', meta('kimi', 'none'), []],
  ] as const)('em todos os motores: %s', (_nome, engine, protocolo) => {
    useStore.setState({
      engines: [engine], slashCommands: [...protocolo],
      sessions: { s1: sess('s1', 'idle', { engine: engine.id }) }, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/go' } })
    const itens = screen.getAllByTestId('slash-item').map((el) => el.textContent ?? '')
    expect(itens.some((t) => t.includes('/goal'))).toBe(true)
  })
})
