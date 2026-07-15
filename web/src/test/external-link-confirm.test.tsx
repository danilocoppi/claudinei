import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ExternalLinkConfirm } from '../components/ExternalLinkConfirm'
import { useStore } from '../store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStore.setState({ externalLink: null })
})

describe('ExternalLinkConfirm', () => {
  it('inerte sem link pendente', () => {
    render(<ExternalLinkConfirm />)
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('mostra a URL; confirmar abre em aba nova (noopener) e fecha', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    useStore.setState({ externalLink: 'https://example.com/destino' })
    render(<ExternalLinkConfirm />)
    expect(screen.getByText(/example\.com\/destino/)).toBeTruthy()
    fireEvent.click(screen.getByText('Abrir link'))
    expect(open).toHaveBeenCalledWith('https://example.com/destino', '_blank', 'noopener,noreferrer')
    expect(useStore.getState().externalLink).toBeNull()
  })

  it('cancelar fecha SEM abrir', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    useStore.setState({ externalLink: 'https://example.com/x' })
    render(<ExternalLinkConfirm />)
    fireEvent.click(screen.getByText('Cancelar'))
    expect(open).not.toHaveBeenCalled()
    expect(useStore.getState().externalLink).toBeNull()
  })
})
