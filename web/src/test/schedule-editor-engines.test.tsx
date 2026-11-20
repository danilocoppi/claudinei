import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import { ScheduleEditor } from '../components/ScheduleEditor'
import { useStore } from '../store'
import type { Schedule } from '../api'
import type { EngineMeta } from '../types'

const meta = (id: string, label: string): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [],
})

const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: 1, projectId: 1, name: 'Revisão', task: 'revisar',
  cadence: { kind: 'daily', at: '12:00' }, engine: null, model: null, effort: null,
  expectsResult: true, keepResults: 10, enabled: true,
  nextRunAt: '2026-11-21T12:00:00.000Z', consecutiveFailures: 0, runCount: 0,
  ...over,
})

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#fff', icon: '🅰️', engines: ['claude'] }],
    engines: [meta('claude', 'Claude Code'), meta('codex', 'Codex'), meta('kimi', 'Kimi Code')],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ next: ['2026-11-21T12:00:00.000Z'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const opcoes = () => within(screen.getByTestId('sched-engine')).getAllByRole('option').map((o) => o.textContent)

describe('ScheduleEditor e a lista do terminal', () => {
  it('agendamento novo lista só os motores do terminal, com "manter o atual"', () => {
    render(<ScheduleEditor projectId={1} onClose={() => {}} onSave={async () => {}} />)
    expect(opcoes()).toEqual(['manter o atual', 'Claude Code'])
  })

  it('editor de agendamento lista só os motores do terminal e mantém o do agendamento existente', () => {
    render(<ScheduleEditor projectId={1} editing={sched({ engine: 'codex' })} onClose={() => {}} onSave={async () => {}} />)
    expect(opcoes()).toEqual(['manter o atual', 'Claude Code', 'Codex'])
    expect((screen.getByTestId('sched-engine') as HTMLSelectElement).value).toBe('codex')
  })
})
