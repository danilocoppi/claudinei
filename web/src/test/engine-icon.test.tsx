import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EngineIcon, CLAUDE_ICON, OPENAI_ICON } from '../components/EngineIcon'

afterEach(() => cleanup())

describe('EngineIcon', () => {
  it('renderiza o logomark do Claude como SVG para o token claude', () => {
    const { container } = render(<EngineIcon icon={CLAUDE_ICON} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(container.textContent).toBe('')
  })

  it('mantém o logomark da OpenAI como SVG (regressão)', () => {
    const { container } = render(<EngineIcon icon={OPENAI_ICON} />)
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('desenha o Claude monocromático, herdando currentColor', () => {
    const { container } = render(<EngineIcon icon={CLAUDE_ICON} />)
    expect(container.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
  })

  it('renderiza emoji/glyph como texto, sem SVG', () => {
    const { container } = render(<EngineIcon icon="🌙" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('🌙')
  })

  it('não renderiza nada sem ícone', () => {
    const { container } = render(<EngineIcon />)
    expect(container.innerHTML).toBe('')
  })
})
