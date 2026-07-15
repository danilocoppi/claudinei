import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MobileTopbar } from '../components/MobileTopbar'

afterEach(() => cleanup())

describe('MobileTopbar (gaveta mobile)', () => {
  it('mostra o título de contexto e o ☰ alterna a gaveta', () => {
    const onToggle = vi.fn()
    render(<MobileTopbar open={false} onToggle={onToggle} title="FXNfinity" />)
    expect(screen.getByText('FXNfinity')).toBeTruthy()
    const btn = screen.getByLabelText('Abrir menu')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalled()
  })

  it('aberta → aria-expanded true (ícone vira ✕)', () => {
    render(<MobileTopbar open={true} onToggle={() => {}} title="Mural" />)
    expect(screen.getByLabelText('Abrir menu').getAttribute('aria-expanded')).toBe('true')
  })
})
