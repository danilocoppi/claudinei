import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

/**
 * O servidor devolve o último uso bom do Claude mesmo quando a Anthropic recusa
 * a consulta (429). O número continua na tela; quando está velho, o cartão diz
 * de quando ele é.
 */
const MIN = 60_000
let updatedAt: string | undefined
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchUsage: vi.fn(async () => ({
    limits: [{ kind: 'session', group: 'session', label: null, percent: 31, severity: 'normal',
      resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), ...(updatedAt ? { updatedAt } : {}) }],
  })),
}))
import { UsageCard } from '../components/UsageCard'

afterEach(() => { cleanup(); updatedAt = undefined })
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

describe('UsageCard — uso velho', () => {
  it('número de 40 minutos atrás continua na tela e diz de quando é', async () => {
    updatedAt = new Date(Date.now() - 40 * MIN).toISOString()
    render(<UsageCard />)
    expect(await screen.findByText('31%')).toBeTruthy()
    expect(screen.getByText(`atualizado às ${hhmm(updatedAt)}`)).toBeTruthy()
  })

  it('número recente não ganha aviso', async () => {
    updatedAt = new Date(Date.now() - 2 * MIN).toISOString()
    render(<UsageCard />)
    await screen.findByText('31%')
    expect(screen.queryByText(/atualizado às/)).toBeNull()
  })

  it('sem a hora (servidor antigo), nada muda', async () => {
    render(<UsageCard />)
    await screen.findByText('31%')
    expect(screen.queryByText(/atualizado às/)).toBeNull()
  })
})
