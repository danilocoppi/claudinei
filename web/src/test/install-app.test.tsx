import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UserMenu } from '../components/UserMenu'
import { useStore } from '../store'

afterEach(() => {
  cleanup()
  useStore.setState({ installPrompt: null, me: null })
})

const openMenu = () => fireEvent.click(document.querySelector('.user-menu__btn')!)

describe('Instalar app (PWA) no menu do usuário', () => {
  it('sem prompt disponível → item não existe no menu', () => {
    useStore.setState({ me: { username: 'coppi', isAdmin: true, setupRequired: false } })
    render(<UserMenu />)
    openMenu()
    expect(screen.queryByText(/Instalar app/)).toBeNull()
    // o resto do menu continua lá
    expect(screen.getByText('Trocar senha')).toBeTruthy()
  })

  it('com beforeinstallprompt capturado → item aparece; clique dispara o prompt nativo e limpa', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    useStore.setState({
      me: { username: 'coppi', isAdmin: true, setupRequired: false },
      installPrompt: { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) },
    })
    render(<UserMenu />)
    openMenu()
    fireEvent.click(screen.getByText(/Instalar app/))
    await waitFor(() => expect(prompt).toHaveBeenCalled())
    await waitFor(() => expect(useStore.getState().installPrompt).toBeNull())
  })
})
