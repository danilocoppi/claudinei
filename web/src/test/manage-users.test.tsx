import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManageUsersModal } from '../components/ManageUsersModal'
import { useStore } from '../store'
import i18n from '../i18n'

// setup.ts força pt-BR globalmente; aqui as asserções checam o texto literal
// em inglês, então fixamos o idioma (mesmo padrão de auth-screen.test.tsx).
beforeAll(async () => { await i18n.changeLanguage('en') })

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('ManageUsersModal', () => {
  it('lista usuários com badge de admin e os terminais', async () => {
    useStore.setState({ projects: [{ id: 1, name: 'Alfa', path: '/a', color: '#fff', icon: '📁' } as any] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([
      { id: 1, username: 'root', isAdmin: true, projectIds: [], createdAt: '' },
      { id: 2, username: 'ana', isAdmin: false, projectIds: [1], createdAt: '' },
    ]))
    render(<ManageUsersModal onClose={vi.fn()} />)
    expect(await screen.findByText('root')).toBeTruthy()
    expect(await screen.findByText('ana')).toBeTruthy()
  })

  it('Revoke all pede confirmação e chama a API', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson([]))                     // fetchUsers
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // revoke
    render(<ManageUsersModal onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke all/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^ok$/i })) // ConfirmDialog usa confirmLabel="OK"
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/auth/revoke-all', expect.objectContaining({ method: 'POST' })))
  })
})
