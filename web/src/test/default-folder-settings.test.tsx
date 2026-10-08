import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppearancePanel } from '../components/AppearancePanel'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Servidor com a pasta padrão em memória: o PUT muda o que o GET devolve. */
const servidor = (inicial: { path: string | null; effective: string; missing: boolean }) => {
  let atual = inicial
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u === '/api/settings/default-folder') {
      if (init?.method === 'PUT') {
        const path = JSON.parse(String(init.body)).path as string
        atual = path ? { path, effective: path, missing: false } : { path: null, effective: '/home/u', missing: false }
      }
      return json(atual)
    }
    if (u.includes('/api/fs/list')) return json({ path: '/home/u/Projects', parent: '/home/u', entries: [] })
    if (u.endsWith('/api/local-apps/terminals')) return json({ options: [], chosen: null })
    return json({ appearance: DEFAULT_APPEARANCE })
  })
}
const puts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls
  .filter(([u, i]) => String(u) === '/api/settings/default-folder' && (i as RequestInit)?.method === 'PUT')
  .map(([, i]) => JSON.parse(String((i as RequestInit).body)))

beforeEach(() => {
  useStore.setState({ appearance: DEFAULT_APPEARANCE, me: { setupRequired: false, id: 1, username: 'root', isAdmin: true } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('pasta padrão nas configurações', () => {
  it('mostra a pasta em uso e grava na hora a que for escolhida', async () => {
    const spy = servidor({ path: null, effective: '/home/u', missing: false })
    render(<AppearancePanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('/home/u')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Escolher pasta padrão' }))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    await waitFor(() => expect(screen.getByText('/home/u/Projects')).toBeTruthy())
    expect(puts(spy)).toEqual([{ path: '/home/u/Projects' }])
  })

  it('voltar para a pasta pessoal limpa a configuração', async () => {
    const spy = servidor({ path: '/home/u/Projects', effective: '/home/u/Projects', missing: false })
    render(<AppearancePanel onClose={() => {}} />)
    await waitFor(() => screen.getByText('/home/u/Projects'))
    fireEvent.click(screen.getByRole('button', { name: 'Usar a pasta pessoal' }))
    await waitFor(() => expect(screen.getByText('/home/u')).toBeTruthy())
    expect(puts(spy)).toEqual([{ path: '' }])
  })

  it('avisa quando a pasta guardada sumiu do disco', async () => {
    servidor({ path: '/home/u/sumiu', effective: '/home/u', missing: true })
    render(<AppearancePanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/não existe mais/)).toBeTruthy())
    expect(screen.getByText(/\/home\/u\/sumiu/)).toBeTruthy()
  })

  it('quem não é admin não vê a seção', async () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false } })
    const spy = servidor({ path: null, effective: '/home/u', missing: false })
    render(<AppearancePanel onClose={() => {}} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText('Pasta padrão')).toBeNull()
    expect(spy.mock.calls.some(([u]) => String(u) === '/api/settings/default-folder')).toBe(false)
  })
})
