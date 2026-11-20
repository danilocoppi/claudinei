import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return {
    ...real,
    fetchAutoCompact: vi.fn(async () => ({ pct: 0 })),
    continueTaskResults: vi.fn(async () => ({ ok: true })),
    dismissTaskResults: vi.fn(async () => ({ ok: true })),
    usageLimitAction: vi.fn(),
  }
})

import * as api from '../api'
import { applyEvent } from '../chat/applyEvent'
import { MessageBlock } from '../components/MessageBlock'
import { TaskResultNotice } from '../components/TaskResultNotice'
import { UsageLimitNotice } from '../components/UsageLimitNotice'
import { EngineTabs } from '../components/EngineTabs'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore, progressKey } from '../store'
import type { ChatItem, EngineMeta, SessionInfo, SessionStatus, TerminalState } from '../types'

/**
 * Delegar e ser acordado, na interface: os cartões do Claudinei para os selos
 * novos (resultado de tarefa, goal, partida do goal), o aviso "A tarefa
 * terminou" com Continuar/×, a aba do motor escondido com resultado pendente e
 * a contagem no aviso do limite. Ver
 * docs/superpowers/specs/2026-11-20-delegar-e-goals-design.md.
 */

const estado = (o: Partial<TerminalState> = {}): TerminalState => ({
  projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null,
  autoResumeLimit: false, usageLimit: null, taskResults: [], taskResultsHeld: false, goal: null, ...o,
})
const pendente = (o: Partial<TerminalState> = {}): TerminalState =>
  estado({ taskResults: [{ id: 7, toProjectName: 'Vaexa', status: 'completed' }], ...o })

const sess = (localId: string, status: SessionStatus, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', model: 'opus', engine: 'claude', ...o })

const poe = (s: TerminalState) => useStore.setState({ terminalStates: { [progressKey(s.projectId, s.engine)]: s } })

const userEvt = (text: string) => ({ kind: 'user', message: { role: 'user', content: text }, raw: { type: 'user' } })

beforeEach(() => {
  vi.mocked(api.continueTaskResults).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(api.dismissTaskResults).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(api.usageLimitAction).mockReset()
  useStore.setState({ terminalStates: {}, projects: [], sessions: { s1: sess('s1', 'stopped') } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('cartões do Claudinei', () => {
  it('selos de goal e goal start viram os cartões traduzidos', () => {
    const [goal] = applyEvent([], userEvt('[Claudinei: goal]: Continue toward the goal: os testes passam. Turn 3/20. When it is fully met, call goal_done with the evidence.') as never)
    const { container, unmount } = render(<MessageBlock item={goal} />)
    expect(screen.getByText('Objetivo · turno 3/20')).toBeTruthy()
    expect(screen.getByText('os testes passam')).toBeTruthy()
    expect(screen.queryByText(/Continue toward the goal/)).toBeNull()
    expect(container.querySelector('.msg-bubble--claudinei')).toBeTruthy()
    unmount()

    const [start] = applyEvent([], userEvt('[Claudinei: goal start]: New goal: os testes passam. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.') as never)
    render(<MessageBlock item={start} />)
    expect(screen.getByText('Objetivo definido')).toBeTruthy()
    expect(screen.getByText('os testes passam')).toBeTruthy()
    expect(screen.queryByText(/New goal/)).toBeNull()
  })

  it('cartão de resultado: lista com #id, projeto e estado; corpo em markdown dobrável', () => {
    const longo = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\n')
    const texto = `[Claudinei: task result]: Task #7 sent to Vaexa - Backend completed.\n**Feito** sem erro.\n\nTask #9 sent to NFE failed.\n${longo}\n(full text: list_tasks #9)`
    const [item] = applyEvent([], userEvt(texto) as never)
    const { container } = render(<MessageBlock item={item} />)
    expect(screen.getByText('Resultados de tarefas')).toBeTruthy()
    expect(screen.getByText('#7 · Vaexa - Backend')).toBeTruthy()
    expect(screen.getByText('#9 · NFE')).toBeTruthy()
    expect(screen.getByText('concluída')).toBeTruthy()
    expect(screen.getByText('falhou')).toBeTruthy()
    // markdown de verdade, não o texto cru
    expect(container.querySelector('strong')?.textContent).toBe('Feito')
    // corpo longo dobrado; o rodapé do corte vira a nota traduzida
    expect(screen.queryByText(/linha 30/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /mostrar tudo/i }))
    expect(screen.getByText(/linha 30/)).toBeTruthy()
    expect(screen.getByText(/texto inteiro está em list_tasks #9/)).toBeTruthy()
    expect(screen.queryByText(/full text:/)).toBeNull()
    // sem lápis: não foi o operador que escreveu
    expect(screen.queryByTitle(/editar/i)).toBeNull()
  })

  it('cartão de uma tarefa só usa o título no singular', () => {
    const item: ChatItem = { kind: 'claudinei_message', reason: 'task_result', text: 'x', tasks: [{ id: 3, project: 'P', status: 'completed', body: 'ok' }] }
    render(<MessageBlock item={item} />)
    expect(screen.getByText('Resultado de tarefa')).toBeTruthy()
  })
})

describe('TaskResultNotice', () => {
  it('TaskResultNotice: só aparece com pendentes e sessão sem processo de pé; Continuar chama a API; × dispensa', async () => {
    // sem pendentes: nada
    poe(estado())
    const { container, rerender } = render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(container.textContent).toBe('')

    // com pendente e sessão viva: o árbitro entrega sozinho, o aviso não aparece
    useStore.setState({ sessions: { s1: sess('s1', 'idle') } })
    poe(pendente())
    rerender(<TaskResultNotice projectId={1} engine="claude" />)
    expect(container.textContent).toBe('')

    // parada: o aviso aparece
    useStore.setState({ sessions: { s1: sess('s1', 'stopped') } })
    rerender(<TaskResultNotice projectId={1} engine="claude" />)
    expect(screen.getByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(api.continueTaskResults).toHaveBeenCalledWith(1, 'claude'))
    // Continuar não tira o aviso sozinho: ele some quando o servidor esvazia a lista
    expect(screen.getByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /dispensar/i }))
    await waitFor(() => expect(api.dismissTaskResults).toHaveBeenCalledWith(1, 'claude'))
    await waitFor(() => expect(container.textContent).toBe(''))
    expect(useStore.getState().terminalStates[progressKey(1, 'claude')].taskResults).toEqual([])
  })

  it('várias pendentes: uma linha só, com a contagem e os números', () => {
    poe(estado({ taskResults: [
      { id: 7, toProjectName: 'Vaexa', status: 'completed' },
      { id: 9, toProjectName: 'NFE', status: 'failed' },
    ] }))
    render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(screen.getByText('2 tarefas delegadas terminaram: #7, #9.')).toBeTruthy()
  })

  it('tarefa que falhou diz que falhou', () => {
    poe(estado({ taskResults: [{ id: 9, toProjectName: 'NFE', status: 'failed' }] }))
    render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(screen.getByText('A tarefa #9 enviada a NFE falhou.')).toBeTruthy()
  })

  it.each(['none', 'armed'] as const)('no limite de uso (%s) o aviso fica com o do limite (que mostra a contagem)', (action) => {
    poe(pendente({ usageLimit: { hitAt: 'x', resetsAt: null, action, origin: 'operator' }, taskResultsHeld: true }))
    const { container } = render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(container.textContent).toBe('')
  })

  it('limite adiado com resultado pendente: o aviso aparece sem Continuar (só o ×)', () => {
    poe(pendente({ usageLimit: { hitAt: 'x', resetsAt: 9_999_999_999, action: 'snoozed', origin: 'operator' }, taskResultsHeld: true }))
    render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(screen.getByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()
    expect(screen.getByText(/espera o terminal voltar a trabalhar depois do limite/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
    expect(screen.getByRole('button', { name: /dispensar/i })).toBeTruthy()
  })

  it('limite já saiu, sessão viva parada e resultado segurado pela marca: o aviso aparece com Continuar', async () => {
    useStore.setState({ sessions: { s1: sess('s1', 'idle') } })
    poe(pendente({ taskResultsHeld: true }))
    render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(screen.getByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()
    expect(screen.queryByText(/depois do limite/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(api.continueTaskResults).toHaveBeenCalledWith(1, 'claude'))
  })

  it.each([
    ['trabalhando', 'working'],
    ['aberta no terminal', 'in_terminal'],
  ] as const)('segurado mas com a sessão %s: o aviso não aparece', (_nome, status) => {
    useStore.setState({ sessions: { s1: sess('s1', status) } })
    poe(pendente({ taskResultsHeld: true }))
    const { container } = render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(container.textContent).toBe('')
  })

  it('com o aviso de interrompido aberto, só ele aparece (um Continuar só)', () => {
    poe(pendente({ interruption: { at: '2026-11-20T10:00:00.000Z', reason: 'off' } }))
    const { container } = render(<TaskResultNotice projectId={1} engine="claude" />)
    expect(container.textContent).toBe('')
  })

  it('erro do Continuar aparece no aviso', async () => {
    vi.mocked(api.continueTaskResults).mockRejectedValue(Object.assign(new Error('Falhou ao reviver a sessão'), { code: 'revive_failed' }))
    poe(pendente())
    render(<TaskResultNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByText('Falhou ao reviver a sessão')).toBeTruthy()
    expect(screen.getByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()
  })

  it('"nada a continuar" (409) tira o aviso na hora', async () => {
    vi.mocked(api.continueTaskResults).mockRejectedValue(Object.assign(new Error('x'), { code: 'nothing_to_continue' }))
    poe(pendente())
    const { container } = render(<TaskResultNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('montado no ChatView, acima do campo', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁', engines: ['claude'] }],
      sessions: { s1: sess('s1', 'stopped') }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
      view: 'chat', activeLocalId: 's1', engines: [],
    })
    poe(pendente())
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    expect(await screen.findByText('A tarefa #7 enviada a Vaexa terminou.')).toBeTruthy()
  })
})

describe('aba e aviso do limite', () => {
  const meta = (id: string, label: string): EngineMeta =>
    ({ id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [] })

  it('aba de motor escondido com resultado pendente', () => {
    useStore.setState({
      engines: [meta('claude', 'Claude Code'), meta('codex', 'Codex')],
      projects: [{ id: 1, name: 'T', path: '/tmp/t', color: '#000', icon: 'x', engines: ['claude'] }],
      sessions: { c1: sess('c1', 'idle') },
      terminalStates: { '1:codex': estado({ engine: 'codex', taskResults: [{ id: 7, toProjectName: 'Vaexa', status: 'completed' }] }) },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const labels = screen.getAllByRole('tab').map((el) => el.querySelector('.engine-tab__label')?.textContent)
    expect(labels).toEqual(['Claude Code', 'Codex'])
  })

  it('aviso do limite mostra a contagem de resultados esperando', () => {
    const limite = { hitAt: 'x', resetsAt: null, action: 'none' as const, origin: 'operator' as const }
    poe(estado({ usageLimit: limite }))
    const { rerender } = render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.queryByText(/esperando/)).toBeNull()

    poe(estado({ usageLimit: limite, taskResults: [{ id: 7, toProjectName: 'Vaexa', status: 'completed' }] }))
    rerender(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.getByText('1 resultado de tarefa esperando')).toBeTruthy()

    poe(estado({ usageLimit: { ...limite, action: 'armed' }, taskResults: [
      { id: 7, toProjectName: 'Vaexa', status: 'completed' },
      { id: 9, toProjectName: 'NFE', status: 'failed' },
    ] }))
    rerender(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.getByText('2 resultados de tarefa esperando')).toBeTruthy()
  })
})
