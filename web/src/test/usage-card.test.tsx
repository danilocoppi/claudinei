import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'

const LIMITS = [
  { kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() },
  { kind: 'weekly_all', group: 'weekly', label: null, percent: 43, severity: 'normal', resetsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
  { kind: 'weekly_scoped', group: 'weekly', label: 'Fable', percent: 48, severity: 'normal', resetsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
]

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchUsage: vi.fn(async () => ({ limits: LIMITS })),
}))

import { UsageCard } from '../components/UsageCard'
import { fetchUsage } from '../api'

beforeEach(() => localStorage.setItem('claudinei.usageAdvanced', '1')) // avançado = todas as barras
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })

describe('UsageCard', () => {
  it('renderiza uma barra por limite com rótulos certos (i18n + label da API)', async () => {
    render(<UsageCard />)
    expect(await screen.findByText('Sessão atual')).toBeTruthy()
    expect(screen.getByText('Todos os modelos')).toBeTruthy()
    expect(screen.getByText('Fable')).toBeTruthy()
    expect(screen.getByText('10%')).toBeTruthy()
    expect(screen.getByText('48%')).toBeTruthy()
  })

  it('a barra tem width = percent e cor de ritmo', async () => {
    render(<UsageCard />)
    await screen.findByText('Sessão atual')
    const fills = document.querySelectorAll('.usage-bar__fill')
    expect(fills).toHaveLength(3)
    expect((fills[0] as HTMLElement).style.width).toBe('10%')
    // sessão: 10% usado, ~1h decorrida de 5h → razão < 1 → verde
    expect((fills[0] as HTMLElement).style.background).toContain('--ok')
  })

  it('sem limites → não renderiza nada', async () => {
    ;(fetchUsage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ limits: [] })
    const { container } = render(<UsageCard />)
    await waitFor(() => expect(fetchUsage).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('modo simples (toggle off) mostra só a sessão; toggle liga o avançado e persiste', async () => {
    localStorage.setItem('claudinei.usageAdvanced', '0')
    render(<UsageCard />)
    await screen.findByText('Sessão atual')
    expect(screen.queryByText('Todos os modelos')).toBeNull()
    expect(screen.queryByText('Fable')).toBeNull()
    fireEvent.click(screen.getByLabelText('Avançado'))
    expect(await screen.findByText('Fable')).toBeTruthy()
    expect(localStorage.getItem('claudinei.usageAdvanced')).toBe('1')
  })

  it('respeita o avançado salvo no localStorage (todas as barras já no primeiro render)', async () => {
    localStorage.setItem('claudinei.usageAdvanced', '1')
    render(<UsageCard />)
    expect(await screen.findByText('Fable')).toBeTruthy()
  })
})
