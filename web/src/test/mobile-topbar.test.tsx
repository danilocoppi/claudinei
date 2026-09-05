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
  // Visão de DETALHE (conversa/terminal): o mesmo botão vira "voltar", porque é
  // isso que ele faz ali — trazer a lista de terminais de volta.
  it('com onBack o botão vira "voltar" e chama onBack, não o toggle', () => {
    const onBack = vi.fn()
    const onToggle = vi.fn()
    render(<MobileTopbar open={false} onToggle={onToggle} title="Claudinei Web" onBack={onBack} />)
    fireEvent.click(screen.getByLabelText('Voltar para a lista de terminais'))
    expect(onBack).toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  // Com a gaveta ABERTA o que resolve é fechar, não voltar de novo — senão o
  // botão vira um beco: abre a lista e não tem como sair dela pelo mesmo lugar.
  it('gaveta aberta manda no ícone: volta a ser fechar mesmo com onBack', () => {
    const onBack = vi.fn()
    const onToggle = vi.fn()
    render(<MobileTopbar open onToggle={onToggle} title="Claudinei Web" onBack={onBack} />)
    fireEvent.click(screen.getByLabelText('Abrir menu'))
    expect(onToggle).toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()
  })
})
