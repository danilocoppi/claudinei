import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReauthBanner } from '../components/ReauthBanner'
import * as api from '../api'

const URLS = { manualUrl: 'https://claude.ai/oauth?manual=1', automaticUrl: 'https://claude.ai/oauth?auto=1' }

beforeEach(() => {
  vi.spyOn(api, 'startSessionAuth').mockResolvedValue(URLS as never)
  vi.spyOn(api, 'completeSessionAuth').mockResolvedValue(undefined as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ReauthBanner', () => {
  it('não aparece com a credencial válida', () => {
    const { container } = render(<ReauthBanner localId="s1" expired={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('avisa quando a sessão do Claude expirou', () => {
    render(<ReauthBanner localId="s1" expired />)
    expect(screen.getByText(/sess(ã|a)o do Claude expirou/i)).toBeTruthy()
  })

  it('começar o login pede as URLs ao servidor', async () => {
    render(<ReauthBanner localId="s1" expired />)
    fireEvent.click(screen.getByRole('button', { name: /reautenticar/i }))
    await waitFor(() => expect(api.startSessionAuth).toHaveBeenCalledWith('s1'))
  })

  it('mostra o link de autorização e o campo de código', async () => {
    render(<ReauthBanner localId="s1" expired />)
    fireEvent.click(screen.getByRole('button', { name: /reautenticar/i }))
    const link = await screen.findByRole('link', { name: /abrir/i })
    expect(link.getAttribute('href')).toBe(URLS.automaticUrl)
    expect(screen.getByPlaceholderText(/c(ó|o)digo/i)).toBeTruthy()
  })

  it('enviar o código conclui o login', async () => {
    render(<ReauthBanner localId="s1" expired />)
    fireEvent.click(screen.getByRole('button', { name: /reautenticar/i }))
    const campo = await screen.findByPlaceholderText(/c(ó|o)digo/i)
    fireEvent.change(campo, { target: { value: 'meu-codigo' } })
    fireEvent.click(screen.getByRole('button', { name: /concluir/i }))
    await waitFor(() => expect(api.completeSessionAuth).toHaveBeenCalledWith('s1', 'meu-codigo'))
  })

  it('mostra o erro quando o código é recusado', async () => {
    vi.spyOn(api, 'completeSessionAuth').mockRejectedValue(new Error('código inválido'))
    render(<ReauthBanner localId="s1" expired />)
    fireEvent.click(screen.getByRole('button', { name: /reautenticar/i }))
    const campo = await screen.findByPlaceholderText(/c(ó|o)digo/i)
    fireEvent.change(campo, { target: { value: 'ruim' } })
    fireEvent.click(screen.getByRole('button', { name: /concluir/i }))
    expect(await screen.findByText(/inválido/i)).toBeTruthy()
  })

  it('código vazio não chama o servidor', async () => {
    render(<ReauthBanner localId="s1" expired />)
    fireEvent.click(screen.getByRole('button', { name: /reautenticar/i }))
    await screen.findByPlaceholderText(/c(ó|o)digo/i)
    fireEvent.click(screen.getByRole('button', { name: /concluir/i }))
    expect(api.completeSessionAuth).not.toHaveBeenCalled()
  })
})
