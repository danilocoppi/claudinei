import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

const IN_4H = new Date(Date.now() + 4 * 3_600_000).toISOString()

const LIMITS = [
  { kind: 'session', group: 'session', label: null, percent: 19, severity: 'normal', resetsAt: IN_4H },
  { kind: 'kimi_weekly', group: 'weekly', label: null, percent: 0, severity: 'normal', resetsAt: IN_4H, provider: 'kimi' },
]
const tk = (total: number) => ({ input: total, cachedInput: 0, output: 0, reasoning: 0, total })
const TOKENS = {
  codex: { total: tk(2_893_900_000), today: tk(0) },
  kimi: { total: tk(4_000_000), today: tk(0) },
  opencode: { total: tk(250_000), today: tk(0) },
}

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchUsage: vi.fn(async () => ({ limits: LIMITS, tokens: TOKENS, active: ['claude', 'codex'] })),
}))

import { UsageCard } from '../components/UsageCard'
import { fetchUsage } from '../api'
import { useStore } from '../store'

beforeEach(() => {
  localStorage.setItem('claudinei.usageAdvanced', '1')
  useStore.setState({
    engines: [
      { id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: [], permissions: [], slashSource: 'protocol', slashCommands: [] },
      { id: 'codex', label: 'Codex', icon: 'openai', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] },
      { id: 'kimi', label: 'Kimi Code', icon: '🌙', models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [] },
      { id: 'opencode', label: 'OpenCode', icon: 'opencode', models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [] },
    ],
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })

// O ícone do Kimi é um emoji e entra no texto do título: compara pelo nome contido.
const NOMES = ['Codex', 'Kimi Code', 'OpenCode']
const blocos = () => [...document.querySelectorAll('.usage-engine .usage-tokens__group')]
  .map((el) => NOMES.find((n) => el.textContent?.includes(n)))

/** O cartão da lateral só mostra os motores que o servidor marcou em `active`. */
describe('UsageCard — só motores usados nas últimas 24 h', () => {
  it('esconde os blocos dos motores fora de `active` (Kimi e OpenCode parados)', async () => {
    render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
    expect(blocos()).toEqual(['Codex'])
    expect(screen.queryByText('Kimi Code')).toBeNull()
    expect(screen.queryByText('OpenCode')).toBeNull()
    // o Claude segue com as barras de plano; o "0 hoje" do Codex fica como estava
    expect(screen.getByText('Sessão atual')).toBeTruthy()
    expect(screen.getByText('0 hoje')).toBeTruthy()
  })

  it('Claude fora de `active` → some o bloco de planos dele', async () => {
    vi.mocked(fetchUsage).mockResolvedValueOnce({ limits: LIMITS, tokens: TOKENS, active: ['codex'] } as never)
    render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
    expect(screen.queryByText('Sessão atual')).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('nenhum motor ativo → uma linha curta e o Ver detalhes', async () => {
    vi.mocked(fetchUsage).mockResolvedValueOnce({ limits: LIMITS, tokens: TOKENS, active: [] } as never)
    const { container } = render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Nenhum motor usado nas últimas 24 h')).toBeTruthy())
    expect(container.querySelectorAll('.usage-engine')).toHaveLength(0)
    expect(container.querySelectorAll('.usage-bar')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Ver detalhes' })).toBeTruthy()
  })

  it('modo simples (Avançado desligado) também esconde os motores fora de `active`', async () => {
    localStorage.setItem('claudinei.usageAdvanced', '0')
    render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
    expect(blocos()).toEqual(['Codex'])
    expect(screen.queryByText('Kimi Code')).toBeNull()
    // só a barra da sessão do Claude; o Kimi (plano em 0%) não ganha barra
    expect(document.querySelectorAll('.usage-bar')).toHaveLength(1)
    expect(screen.getByText('Sessão atual')).toBeTruthy()
  })

  it('servidor sem `active` (versão antiga) → mostra todos, como antes', async () => {
    vi.mocked(fetchUsage).mockResolvedValueOnce({ limits: LIMITS, tokens: TOKENS } as never)
    render(<UsageCard />)
    await waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
    expect(blocos()).toEqual(['Codex', 'Kimi Code', 'OpenCode'])
  })
})
