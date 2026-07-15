import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { InstallAppButton } from '../components/InstallAppButton'
import { useStore } from '../store'

afterEach(() => {
  cleanup()
  useStore.setState({ installPrompt: null })
})

describe('InstallAppButton (PWA)', () => {
  it('sem prompt disponível → não renderiza nada', () => {
    render(<InstallAppButton />)
    expect(document.querySelector('.install-app-btn')).toBeNull()
  })

  it('com beforeinstallprompt capturado → botão aparece; clique dispara o prompt nativo e limpa', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ installPrompt: { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) } })
    render(<InstallAppButton />)
    const btn = screen.getByLabelText('Instalar app no dispositivo')
    fireEvent.click(btn)
    await waitFor(() => expect(prompt).toHaveBeenCalled())
    await waitFor(() => expect(useStore.getState().installPrompt).toBeNull())
  })
})
