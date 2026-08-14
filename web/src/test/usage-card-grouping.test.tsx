import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

const IN_4H = new Date(Date.now() + 4 * 3_600_000).toISOString()

const LIMITS = [
  { kind: 'session', group: 'session', label: null, percent: 19, severity: 'normal', resetsAt: IN_4H },
  { kind: 'kimi_weekly', group: 'weekly', label: null, percent: 4, severity: 'normal', resetsAt: IN_4H, provider: 'kimi' },
  { kind: 'kimi_5h', group: 'session', label: null, percent: 4, severity: 'normal', resetsAt: IN_4H, provider: 'kimi' },
]
const TOKENS = {
  codex: { total: { input: 10, output: 2, reasoning: 0, total: 12 }, today: { input: 0, output: 0, reasoning: 0, total: 0 } },
  kimi: { total: { input: 5, output: 1, reasoning: 0, total: 6 }, today: { input: 0, output: 0, reasoning: 0, total: 0 } },
}

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchUsage: vi.fn(async () => ({ limits: LIMITS, tokens: TOKENS })),
}))

import { UsageCard } from '../components/UsageCard'
import { useStore } from '../store'

beforeEach(() => {
  localStorage.setItem('claudinei.usageAdvanced', '1')
  useStore.setState({
    engines: [
      { id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: [], permissions: [], slashSource: 'protocol', slashCommands: [] },
      { id: 'codex', label: 'Codex', icon: 'openai', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] },
      { id: 'kimi', label: 'Kimi Code', icon: '🌙', models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [] },
    ],
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })

/**
 * As barras de plano do Kimi ficavam na lista de PLANS, junto das do Claude,
 * enquanto os tokens do Kimi apareciam num bloco próprio lá embaixo — a mesma
 * engine em dois lugares distantes.
 */
describe('UsageCard — barras agrupadas por engine', () => {
  const blocoDoKimi = () =>
    [...document.querySelectorAll('.usage-engine')].find((el) => el.textContent?.includes('Kimi Code'))

  it('as barras do Kimi ficam dentro do bloco do Kimi', async () => {
    render(<UsageCard />)
    await waitFor(() => expect(blocoDoKimi()).toBeTruthy())
    const bloco = blocoDoKimi()!
    expect(bloco.textContent).toMatch(/semanal|weekly/i)
    expect(bloco.querySelectorAll('.usage-bar').length).toBe(2)
  })

  it('as barras do Claude NÃO entram no bloco de outra engine', async () => {
    render(<UsageCard />)
    await waitFor(() => expect(blocoDoKimi()).toBeTruthy())
    expect(blocoDoKimi()!.textContent).not.toMatch(/Sessão atual/i)
    expect(screen.getByText('Sessão atual')).toBeTruthy()
  })

  it('engine com barras mas ainda sem tokens continua aparecendo', async () => {
    const { fetchUsage } = await import('../api')
    ;(fetchUsage as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ limits: LIMITS, tokens: { codex: TOKENS.codex } })
    render(<UsageCard />)
    await waitFor(() => expect(blocoDoKimi()).toBeTruthy())
    expect(blocoDoKimi()!.querySelectorAll('.usage-bar').length).toBe(2)
  })

  it('o Codex (só tokens) segue com seu bloco', async () => {
    render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
  })
})
