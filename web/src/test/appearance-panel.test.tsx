import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { AppearancePanel } from '../components/AppearancePanel'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}

const html = () => document.documentElement

const stubFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(
  async (_url, init) => new Response(
    JSON.stringify(init?.method === 'PUT'
      ? { appearance: JSON.parse(String(init.body)).appearance }
      : { appearance: DEFAULT_APPEARANCE }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))

beforeEach(() => {
  useStore.setState({
    projects: [], groups: [], sectors: [], schedules: [], sessions: {},
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  useStore.getState().applyAppearance(DEFAULT_APPEARANCE)
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('acesso ao painel', () => {
  it('a sidebar tem o botão de aparência', () => {
    stubFetch()
    render(<Sidebar />)
    expect(screen.getByTitle(/aparência/i)).toBeTruthy()
  })

  /**
   * O painel PRECISA sair da sidebar. Ela tem `backdrop-filter`, e isso cria bloco
   * de contenção: um `position: fixed` lá dentro deixa de se ancorar na janela e
   * fica preso na coluna — foi exatamente o que aconteceu. Os outros modais do app
   * escapam pelo mesmo caminho (portal para o body).
   */
  it('o painel nasce fora da sidebar, no body', () => {
    stubFetch()
    const { container } = render(<Sidebar />)
    fireEvent.click(screen.getByTitle(/aparência/i))
    const panel = screen.getByTestId('appearance-panel')
    expect(container.querySelector('.sidebar')?.contains(panel)).toBe(false)
    expect(panel.closest('.modal-overlay')?.parentElement).toBe(document.body)
  })
})

describe('preview ao vivo', () => {
  /**
   * O preview é o app inteiro atrás do modal: aplicar de verdade enquanto se mexe
   * mostra mais que qualquer amostra dentro do painel.
   */
  it('escolher um tema aplica na hora, antes de salvar', () => {
    const spy = stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    expect(html().dataset.theme).toBe('light-fun')
    expect(spy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(false)
  })

  it('cada controle aplica na hora', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('ap-font-ui'), { target: { value: 'serif' } })
    expect(html().style.getPropertyValue('--font-ui')).toContain('Georgia')

    fireEvent.click(screen.getByTestId('width-800'))
    expect(html().style.getPropertyValue('--chat-max')).toBe('800px')

    fireEvent.click(screen.getByTestId('glass-off'))
    expect(html().style.getPropertyValue('--glass-blur')).toBe('0px')
  })

  /** Preview ao vivo sem volta atrás vira armadilha. */
  it('fechar sem salvar devolve tudo como estava', () => {
    stubFetch()
    const onClose = vi.fn()
    render(<AppearancePanel onClose={onClose} />)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    fireEvent.click(screen.getByText(/cancelar/i))
    expect(html().dataset.theme).toBe('dark-fun')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('guardar', () => {
  it('salvar manda a aparência ao servidor e fecha', async () => {
    const spy = stubFetch()
    const onClose = vi.fn()
    render(<AppearancePanel onClose={onClose} />)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    fireEvent.click(screen.getByText(/salvar/i))
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PUT')
      expect(call).toBeTruthy()
      expect(JSON.parse(String((call![1] as RequestInit).body)).appearance.theme).toBe('light-fun')
    })
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  /**
   * Reverter o visual porque a rede caiu seria pior que o problema: a escolha
   * continua valendo na tela e o painel avisa que não deu para guardar.
   */
  it('falha ao guardar mantém o visual e avisa', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (init?.method === 'PUT') throw new Error('rede fora')
      return new Response(JSON.stringify({ appearance: DEFAULT_APPEARANCE }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    fireEvent.click(screen.getByText(/salvar/i))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(html().dataset.theme).toBe('light-fun')
  })

  it('restaurar padrões volta tudo ao original', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    fireEvent.click(screen.getByTestId('glass-off'))
    fireEvent.click(screen.getByText(/restaurar/i))
    expect(html().dataset.theme).toBe('dark-fun')
    expect(html().style.getPropertyValue('--glass-blur')).toBe('')
  })
})

describe('largura do chat', () => {
  /** A coluna estreita precisa parecer uma folha, não um texto solto no vazio. */
  it('largura limitada marca o modo folha; cheia não', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('width-800'))
    expect(html().dataset.chatWidth).toBe('800')
    fireEvent.click(screen.getByTestId('width-full'))
    expect(html().dataset.chatWidth).toBe('full')
  })
})

describe('as amostras de tema', () => {
  /** Nome de tema não diz nada: a amostra mostra o fundo, a superfície e o acento. */
  it('cada tema aparece como amostra com as cores dele, não só o nome', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    const sample = screen.getByTestId('theme-light-fun')
    expect(within(sample).getByText('Light Fun')).toBeTruthy()
    expect(sample.querySelectorAll('.ap-swatch__dot').length).toBeGreaterThanOrEqual(2)
  })

  it('marca qual está escolhido', () => {
    stubFetch()
    render(<AppearancePanel onClose={() => {}} />)
    expect(screen.getByTestId('theme-dark-fun').className).toMatch(/\bon\b/)
    fireEvent.click(screen.getByTestId('theme-light-fun'))
    expect(screen.getByTestId('theme-light-fun').className).toMatch(/\bon\b/)
    expect(screen.getByTestId('theme-dark-fun').className).not.toMatch(/\bon\b/)
  })
})
