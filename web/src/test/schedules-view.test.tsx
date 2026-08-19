import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { SchedulesView } from '../components/SchedulesView'
import { describeCadence, formatRunTimes, formatShort } from '../cadenceText'
import { useStore } from '../store'
import type { Cadence, Schedule, ScheduleRun } from '../api'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: ['', 'opus', 'sonnet'], efforts: ['auto', 'low', 'high'], permissions: ['default'],
  slashSource: 'protocol', slashCommands: [],
}

const run = (seq: number, over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: seq, scheduleId: 1, seq, startedAt: '2026-08-18T12:00:00.000Z', finishedAt: '2026-08-18T12:00:42.000Z',
  status: 'ok', title: `Título ${seq}`, contentSize: 100, error: null, localId: 's1', late: false, ...over,
})

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: 1, projectId: 1, name: 'Preços do produto X', task: 'buscar preços',
  cadence: { kind: 'daily', at: '12:00' }, engine: null, model: null, effort: null,
  expectsResult: true, keepResults: 10, enabled: true,
  nextRunAt: '2026-08-19T12:00:00.000Z', consecutiveFailures: 0, runCount: 3,
  lastRun: run(3, { preview: '## Três lojas\n1. **Loja A** — R$ 189,90' }),
  ...over,
})

const session: SessionInfo = {
  localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
}

/** Respostas por rota; o teste diz só o que lhe interessa. */
const stubFetch = (routes: Record<string, unknown> = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    const key = Object.keys(routes).find((k) => u.includes(k))
    const body = key ? routes[key]
      : u.includes('/schedules/preview') ? { next: ['2026-08-19T12:00:00.000Z'] }
        : u.includes('/schedules') && !init?.method ? [sched()] : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#fff', icon: '🅰️' }],
    sessions: { s1: session }, activeLocalId: 's1', view: 'schedules',
    engines: [CLAUDE], schedules: [], groups: [], sectors: [],
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('describeCadence', () => {
  const t = (k: string, o?: Record<string, unknown>) => `${k}:${JSON.stringify(o ?? {})}`
  const cases: [Cadence, RegExp][] = [
    [{ kind: 'daily', at: '12:00' }, /daily.*12:00/],
    [{ kind: 'every', n: 15, unit: 'minutes' }, /every.*15/],
    [{ kind: 'weekly', weekdays: [1, 5], at: '09:00' }, /weekly/],
    [{ kind: 'monthly', day: 5, at: '09:00' }, /monthly.*5/],
    [{ kind: 'cron', expr: '*/5 * * * *' }, /cron/],
  ]
  for (const [cadence, expected] of cases) {
    it(`descreve a cadência ${cadence.kind} numa frase`, () => {
      expect(describeCadence(cadence, t as never)).toMatch(expected)
    })
  }
})

describe('feed de resultados', () => {
  it('mostra o último resultado ABERTO e os anteriores só com título', async () => {
    stubFetch({ '/runs?': [run(3, { title: 'Título 3' }), run(2, { title: 'Título 2' }), run(1, { title: 'Título 1' })] })
    render(<SchedulesView />)
    // o corpo do último vem do preview que a listagem já trouxe — sem clique
    expect(await screen.findByText(/Loja A/)).toBeTruthy()
    expect(await screen.findByText('Título 2')).toBeTruthy()
    expect(screen.queryByText(/conteúdo de 2/)).toBeNull()
  })

  it('clicar numa execução antiga carrega o conteúdo dela sob demanda', async () => {
    const spy = stubFetch({
      '/runs?': [run(3), run(2)],
      '/runs/2/content': { content: '# conteúdo de 2' },
    })
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText('Título 2'))
    expect(await screen.findByText('conteúdo de 2')).toBeTruthy()
    expect(spy.mock.calls.some(([u]) => String(u).includes('/runs/2/content'))).toBe(true)
  })

  it('arquivo perdido diz que o conteúdo sumiu, sem tirar a execução do feed', async () => {
    stubFetch({ '/runs?': [run(3), run(2)], '/runs/2/content': { content: null } })
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText('Título 2'))
    expect(await screen.findByText(/indisponível/i)).toBeTruthy()
    expect(screen.getByText('Título 2')).toBeTruthy()
  })

  it('falha aparece com o erro no lugar do título', async () => {
    stubFetch({ '/runs?': [run(2, { status: 'error', title: null, error: 'sessão não subiu' })] })
    render(<SchedulesView />)
    expect(await screen.findByText(/sessão não subiu/)).toBeTruthy()
  })

  /** Sem retorno, esperar um resultado que nunca vem seria o pior mal-entendido. */
  it('agendamento "só disparar" mostra carimbos, não feed de resultados', async () => {
    stubFetch({
      '/api/projects/1/schedules': [sched({ expectsResult: false, lastRun: run(3, { title: null, contentSize: null }) })],
      '/runs?': [run(3, { title: null, contentSize: null })],
    })
    render(<SchedulesView />)
    expect(await screen.findByTestId('sched-stamps')).toBeTruthy()
    expect(screen.queryByTestId('sched-feed')).toBeNull()
  })
})

describe('estados do agendamento', () => {
  it('mostra nome, cadência e quando é a próxima', async () => {
    stubFetch()
    render(<SchedulesView />)
    expect(await screen.findByText('Preços do produto X')).toBeTruthy()
    expect(screen.getByTestId('sched-cadence').textContent).toBeTruthy()
  })

  it('pausar chama o PATCH e a linha fica dessaturada', async () => {
    const spy = stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByTitle(/pausar/i))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('/api/schedules/1', expect.objectContaining({ method: 'PATCH' })))
    const body = JSON.parse(String((spy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PATCH')![1] as RequestInit).body))
    expect(body.enabled).toBe(false)
  })

  it('pausado mostra o botão de retomar', async () => {
    stubFetch({ '/api/projects/1/schedules': [sched({ enabled: false })] })
    render(<SchedulesView />)
    expect(await screen.findByTitle(/retomar/i)).toBeTruthy()
  })

  it('falhas seguidas aparecem no cartão', async () => {
    stubFetch({ '/api/projects/1/schedules': [sched({ consecutiveFailures: 3 })] })
    render(<SchedulesView />)
    expect(await screen.findByText(/3/)).toBeTruthy()
    expect(screen.getByTestId('sched-card').className).toMatch(/failing/)
  })

  it('executar agora dispara sem esperar a execução terminar', async () => {
    const spy = stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByTitle(/executar agora/i))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/schedules/1/run', expect.objectContaining({ method: 'POST' })))
  })

  it('excluir pede confirmação antes', async () => {
    const spy = stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByTitle(/excluir/i))
    expect(screen.getByText(/histórico de resultados/i)).toBeTruthy()  // mensagem do diálogo
    expect(spy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'DELETE')).toBe(false)
  })
})

describe('editor', () => {
  /**
   * O editor tem de nascer dentro do primitivo de modal do app (`.modal-overlay`,
   * que é quem centraliza e escurece o fundo). Já nasceu com um nome de classe
   * inventado uma vez, e o resultado foi um formulário jogado no canto da página
   * com o botão Salvar fora da tela — invisível para os testes de comportamento.
   */
  it('renderiza dentro do overlay de modal do app', async () => {
    stubFetch()
    const { container } = render(<SchedulesView />)
    fireEvent.click(await screen.findByText(/novo|new/i))
    const editor = await screen.findByTestId('sched-editor')
    expect(container.querySelector('.modal-overlay')).toBeTruthy()
    expect(editor.closest('.modal-overlay')).toBeTruthy()
  })

  it('o preview das próximas execuções vem do SERVIDOR', async () => {
    const spy = stubFetch({ '/api/schedules/preview': { next: ['2026-08-19T12:00:00.000Z', '2026-08-20T12:00:00.000Z'] } })
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText(/novo/i))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/schedules/preview', expect.objectContaining({ method: 'POST' })))
    expect(await screen.findByTestId('sched-preview')).toBeTruthy()
  })

  it('engine, model e effort nascem em "manter o atual"', async () => {
    stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText(/novo/i))
    const editor = await screen.findByTestId('sched-editor')
    for (const field of ['engine', 'model', 'effort']) {
      expect((within(editor).getByTestId(`sched-${field}`) as HTMLSelectElement).value).toBe('')
    }
  })

  it('a quantidade de resultados desaparece quando não se espera retorno', async () => {
    stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText(/novo/i))
    expect(screen.getByTestId('sched-keep')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sched-no-result'))
    expect(screen.queryByTestId('sched-keep')).toBeNull()
  })

  it('salvar manda a cadência montada pela frase', async () => {
    const spy = stubFetch()
    render(<SchedulesView />)
    fireEvent.click(await screen.findByText(/novo/i))
    const editor = await screen.findByTestId('sched-editor')
    fireEvent.change(within(editor).getByTestId('sched-name'), { target: { value: 'Novo' } })
    fireEvent.change(within(editor).getByTestId('sched-task'), { target: { value: 'faça algo' } })
    fireEvent.change(within(editor).getByTestId('sched-kind'), { target: { value: 'every' } })
    fireEvent.change(within(editor).getByTestId('sched-n'), { target: { value: '15' } })
    fireEvent.click(within(editor).getByText(/salvar/i))

    await vi.waitFor(() => {
      // exclui o /preview, que também é POST e também bate em '/schedules'
      const call = spy.mock.calls.find(([u, i]) => String(u).includes('/projects/1/schedules') && (i as RequestInit)?.method === 'POST')
      expect(call).toBeTruthy()
      const body = JSON.parse(String((call![1] as RequestInit).body))
      expect(body.name).toBe('Novo')
      expect(body.cadence).toMatchObject({ kind: 'every', n: 15, unit: 'minutes' })
    })
  })
})

describe('datas do log', () => {
  it('a data aparece uma vez por dia no preview, e o resto vira só hora', () => {
    const day = new Date('2026-08-19T09:00:00').toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })
    const out = formatRunTimes([
      '2026-08-19T09:00:00', '2026-08-19T09:15:00', '2026-08-19T09:30:00', '2026-08-20T09:00:00',
    ])
    // dois dias distintos → a data daquele dia aparece uma vez, não quatro
    expect(out.split(day).length - 1).toBe(1)
    expect(out.split(' · ')).toHaveLength(4)
  })

  it('a data do log não carrega ano nem segundos', () => {
    const out = formatShort('2026-08-14T12:00:42')
    expect(out).not.toMatch(/2026/)
    expect(out).not.toMatch(/:42/)
  })
})
