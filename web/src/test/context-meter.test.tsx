import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { ContextMeter, CLAUDE_CONTEXT_WINDOW } from '../components/ContextMeter'
import type { SessionInfo } from '../types'

const sess = (contextTokens?: number, contextWindow?: number): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', contextTokens, contextWindow })

afterEach(cleanup)

describe('ContextMeter', () => {
  it('sem dado (outra engine / sessão sem turno) não renderiza nada', () => {
    render(<ContextMeter session={sess(undefined)} />)
    expect(screen.queryByTestId('ctx-meter')).toBeNull()
  })

  it('mostra o % da janela com o detalhe em tokens no title', () => {
    render(<ContextMeter session={sess(86_000)} />)
    const el = screen.getByTestId('ctx-meter')
    expect(el.textContent).toContain('43%')
    expect(el.title).toContain('86k')
    expect(el.title).toContain('200k')
  })

  it('tons: ok < 60% ≤ warn < 85% ≤ danger (e nunca passa de 100%)', () => {
    render(<ContextMeter session={sess(0.5 * CLAUDE_CONTEXT_WINDOW)} />)
    expect(screen.getByTestId('ctx-meter').className).toContain('ctx-meter--ok')
    cleanup()
    render(<ContextMeter session={sess(0.7 * CLAUDE_CONTEXT_WINDOW)} />)
    expect(screen.getByTestId('ctx-meter').className).toContain('ctx-meter--warn')
    cleanup()
    render(<ContextMeter session={sess(1.2 * CLAUDE_CONTEXT_WINDOW)} />)
    const el = screen.getByTestId('ctx-meter')
    expect(el.className).toContain('ctx-meter--danger')
    expect(el.textContent).toContain('100%')
  })
})

describe('ContextMeter com janela de 1M', () => {
  it('usa a janela do modelo: 200k de contexto num modelo de 1M é 20%, não 100%', () => {
    render(<ContextMeter session={sess(200_000, 1_000_000)} />)
    const el = screen.getByTestId('ctx-meter')
    expect(el.textContent).toContain('20%')
    expect(el.title).toContain('1M')
    expect(el.className).toContain('ctx-meter--ok')
  })

  it('sem janela informada mantém o conservador de 200k', () => {
    render(<ContextMeter session={sess(100_000)} />)
    expect(screen.getByTestId('ctx-meter').textContent).toContain('50%')
  })
})
