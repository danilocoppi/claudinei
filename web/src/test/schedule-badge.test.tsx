import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { Schedule } from '../api'
import type { EngineMeta, Project } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const proj = (id: number, name: string): Project =>
  ({ id, name, path: `/tmp/${id}`, color: '#fff', icon: '📁' })

const sched = (id: number, projectId: number, over: Partial<Schedule> = {}): Schedule => ({
  id, projectId, name: `S${id}`, task: 't', cadence: { kind: 'daily', at: '12:00' },
  engine: null, model: null, effort: null, expectsResult: true, keepResults: 10,
  enabled: true, nextRunAt: '2026-08-19T12:00:00.000Z', consecutiveFailures: 0, runCount: 0, ...over,
})

const setup = (schedules: Schedule[]) => {
  useStore.setState({
    projects: [proj(1, 'Alpha'), proj(2, 'Beta')],
    groups: [], sectors: [], schedules,
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined, engines: [CLAUDE],
  })
}

const cardOf = (name: string) =>
  screen.getAllByTestId('term-card').find((c) => within(c).queryByText(name))!

beforeEach(() => setup([]))
afterEach(() => cleanup())

/**
 * O ⏱ no cartão existe para responder "este terminal faz algo sozinho?" sem abrir
 * nada. Pausado não conta: um agendamento parado não age, e mostrá-lo faria o ícone
 * mentir sobre o que está no ar.
 */
describe('⏱ do terminal com agendamento', () => {
  it('aparece no terminal que tem agendamento ativo, e só nele', () => {
    setup([sched(1, 1)])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge')).toBeTruthy()
    expect(within(cardOf('Beta')).queryByTestId('schedule-badge')).toBeNull()
  })

  it('não aparece quando o único agendamento está pausado', () => {
    setup([sched(1, 1, { enabled: false })])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).queryByTestId('schedule-badge')).toBeNull()
  })

  it('com mais de um ativo, leva o número — e conta só os ativos', () => {
    setup([sched(1, 1), sched(2, 1), sched(3, 1, { enabled: false })])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge').textContent).toContain('2')
  })

  it('sem contagem quando é um só (o número não acrescentaria nada)', () => {
    setup([sched(1, 1)])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge').textContent).not.toMatch(/\d/)
  })

  /** Cron quebrado que ninguém percebe é o modo clássico de falhar deste recurso. */
  it('acende em âmbar quando um agendamento vem falhando seguido', () => {
    setup([sched(1, 1, { consecutiveFailures: 3 })])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge').className).toMatch(/failing/)
  })

  it('uma falha isolada não acende — só o que se repete', () => {
    setup([sched(1, 1, { consecutiveFailures: 1 })])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge').className).not.toMatch(/failing/)
  })

  it('o tooltip diz quantos são e quando é o próximo', () => {
    setup([sched(1, 1)])
    render(<Sidebar />)
    expect(within(cardOf('Alpha')).getByTestId('schedule-badge').getAttribute('title')).toMatch(/1/)
  })
})
