import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthScreen } from '../components/AuthScreen'
import i18n from '../i18n'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// setup.ts força pt-BR globalmente (padrão das outras suítes); aqui as
// asserções checam o texto literal em inglês, então fixamos o idioma.
beforeAll(async () => { await i18n.changeLanguage('en') })
afterEach(() => vi.restoreAllMocks())

describe('AuthScreen', () => {
  it('modo login: submete credenciais e chama onDone com o me', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root', isAdmin: true }))
    const onDone = vi.fn()
    render(<AuthScreen mode="login" onDone={onDone} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 's3nha' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ username: 'root' })))
  })

  it('modo setup: exige confirmação igual antes de enviar', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root' }, 201))
    render(<AuthScreen mode="setup" onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'abcd' } })
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'DIFERENTE' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(spy).not.toHaveBeenCalled()
    expect(await screen.findByText(/match/i)).toBeTruthy()
  })

  it('mostra erro de lockout com minutos restantes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'locked', retryAfterMs: 14 * 60_000 }, 429))
    render(<AuthScreen mode="login" onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/14/)).toBeTruthy()
  })
})
