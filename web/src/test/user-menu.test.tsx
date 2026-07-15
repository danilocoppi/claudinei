import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UserMenu } from '../components/UserMenu'
import { useStore } from '../store'
import i18n from '../i18n'

// setup.ts força pt-BR globalmente (padrão das outras suítes); aqui as
// asserções checam o texto literal em inglês, então fixamos o idioma
// (mesmo padrão de auth-screen.test.tsx).
beforeAll(async () => { await i18n.changeLanguage('en') })
afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  useStore.setState({ authStatus: 'ready', me: { setupRequired: false, id: 1, username: 'root', isAdmin: true, projectIds: [] } })
})

describe('UserMenu', () => {
  it('abre com o username e mostra Manage users só para admin', () => {
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /root/i }))
    expect(screen.getByText(/manage users/i)).toBeTruthy()
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false, projectIds: [1] } })
  })

  it('não-admin não vê Manage users', () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false, projectIds: [1] } })
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /ana/i }))
    expect(screen.queryByText(/manage users/i)).toBeNull()
    expect(screen.getByText(/change password/i)).toBeTruthy()
  })

  it('Sign out chama logout e volta ao login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /root/i }))
    fireEvent.click(screen.getByText(/sign out/i))
    await waitFor(() => expect(useStore.getState().authStatus).toBe('login'))
  })
})
