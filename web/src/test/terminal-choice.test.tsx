import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { AppearancePanel } from '../components/AppearancePanel'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'

/**
 * "x-terminal-emulator" é a alternativa que o próprio sistema aponta — a escolha
 * certa em tese. Numa máquina real ela resolvia para o terminator, que não era o
 * terminal do dono, e o clique parecia não fazer nada. Adivinhar melhor não
 * resolve: quem sabe qual terminal quer é quem está na frente dele.
 */
const OPCOES = [
  { id: 'x-terminal-emulator', label: 'Padrão do sistema' },
  { id: 'gnome-terminal', label: 'GNOME Terminal' },
  { id: 'kitty', label: 'kitty' },
]

let salvo: unknown
const stub = (options = OPCOES, chosen: string | null = null) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u.includes('/api/local-apps/terminals')) {
      if (init?.method === 'PUT') { salvo = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }) }
      return new Response(JSON.stringify({ options, chosen }), { status: 200 })
    }
    return new Response(JSON.stringify({ appearance: DEFAULT_APPEARANCE }), { status: 200 })
  })

beforeEach(() => {
  salvo = undefined
  useStore.setState({ appearance: DEFAULT_APPEARANCE, me: { setupRequired: false, id: 1, username: 'u', isAdmin: true } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrir = () => render(<AppearancePanel onClose={() => {}} />)

describe('escolher o terminal', () => {
  it('lista os terminais instalados na máquina do servidor', async () => {
    stub()
    abrir()
    const sel = await screen.findByTestId('ap-terminal')
    expect([...sel.querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['Padrão do sistema', 'GNOME Terminal', 'kitty'])
  })

  it('escolher grava na hora, sem esperar o Salvar do painel', async () => {
    stub()
    abrir()
    const sel = await screen.findByTestId('ap-terminal')
    fireEvent.change(sel, { target: { value: 'kitty' } })
    await waitFor(() => expect(salvo).toEqual({ terminal: 'kitty' }))
  })

  it('mostra o que já estava escolhido', async () => {
    stub(OPCOES, 'kitty')
    abrir()
    await waitFor(() => expect((screen.getByTestId('ap-terminal') as HTMLSelectElement).value).toBe('kitty'))
  })

  /**
   * Acessando de outro computador, o servidor devolve lista vazia — abrir terminal
   * ali abriria na máquina ERRADA. Uma seção vazia anunciando nada seria pior que
   * seção nenhuma.
   */
  it('sem terminal nenhum para oferecer, a seção não aparece', async () => {
    stub([])
    abrir()
    await waitFor(() => expect(screen.getByTestId('appearance-panel')).toBeTruthy())
    expect(screen.queryByTestId('ap-terminal')).toBeNull()
  })

  /** É configuração da MÁQUINA, não de quem entrou: o rótulo tem que dizer isso. */
  it('a seção diz que vale para a máquina do servidor', async () => {
    stub()
    abrir()
    await screen.findByTestId('ap-terminal')
    expect(screen.getByText(/nesta máquina/i)).toBeTruthy()
  })
})
