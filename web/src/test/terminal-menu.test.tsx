import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}

/** `localApps` diz o que a máquina oferece; o resto responde vazio. */
const stubFetch = (localApps: Record<string, boolean> = { folder: true, vscode: true, terminal: true }) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const body = String(url).includes('/api/local-apps') ? localApps : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/home/u/projetos/alpha', color: '#fff', icon: '🅰️', groupId: 10 }],
    groups: [{ id: 10, name: 'Backend' }, { id: 20, name: 'Infra' }],
    sectors: [{ id: 100, name: 'Produto' }],
    schedules: [], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const openMenu = async () => {
  render(<Sidebar />)
  // o cabeçalho do grupo também tem um ⚙ "Opções": o escopo evita o empate
  const card = await screen.findByTestId('term-card')
  fireEvent.click(within(card).getByTitle('Opções'))
  return within(document.querySelector('.sess-pop') as HTMLElement)
}

describe('ações locais no menu do terminal', () => {
  it('oferece abrir pasta, VS Code e terminal quando a máquina tem os três', async () => {
    stubFetch()
    const pop = await openMenu()
    await vi.waitFor(() => expect(pop.getByText(/abrir pasta/i)).toBeTruthy())
    expect(pop.getByText(/vs code/i)).toBeTruthy()
    expect(pop.getByText(/abrir terminal/i)).toBeTruthy()
  })

  /**
   * Quem decide é o SERVIDOR: ele sabe se a requisição é local E se o binário
   * existe. Um item que não vai funcionar é pior que item nenhum — e sem ele não
   * há erro a explicar.
   */
  it('esconde o que a máquina não oferece', async () => {
    stubFetch({ folder: true, vscode: false, terminal: false })
    const pop = await openMenu()
    await vi.waitFor(() => expect(pop.getByText(/abrir pasta/i)).toBeTruthy())
    expect(pop.queryByText(/vs code/i)).toBeNull()
    expect(pop.queryByText(/abrir terminal/i)).toBeNull()
  })

  it('fora do localhost o servidor nega tudo, e nenhum item aparece', async () => {
    stubFetch({ folder: false, vscode: false, terminal: false })
    const pop = await openMenu()
    await vi.waitFor(() => expect(pop.getByText(/copiar caminho/i)).toBeTruthy())
    expect(pop.queryByText(/abrir pasta/i)).toBeNull()
  })

  it('clicar manda a AÇÃO, não um comando', async () => {
    const spy = stubFetch()
    const pop = await openMenu()
    await vi.waitFor(() => expect(pop.getByText(/abrir pasta/i)).toBeTruthy())
    fireEvent.click(pop.getByText(/abrir pasta/i))
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([u]) => String(u).includes('/projects/1/open'))
      expect(call).toBeTruthy()
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ action: 'folder' })
    })
  })

  /** Copiar não depende de máquina nenhuma: vale sempre. */
  it('copiar caminho aparece mesmo sem nada instalado', async () => {
    stubFetch({ folder: false, vscode: false, terminal: false })
    const pop = await openMenu()
    expect(pop.getByText(/copiar caminho/i)).toBeTruthy()
  })

  it('copiar caminho põe o caminho do projeto na área de transferência', async () => {
    stubFetch()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const pop = await openMenu()
    fireEvent.click(pop.getByText(/copiar caminho/i))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('/home/u/projetos/alpha'))
  })
})

describe('grupo e setor viram dropdown', () => {
  it('um select para grupo e outro para setor, em vez de listas', async () => {
    stubFetch()
    const pop = await openMenu()
    const group = pop.getByTestId('menu-group') as HTMLSelectElement
    const sector = pop.getByTestId('menu-sector') as HTMLSelectElement
    expect(group.value).toBe('10')                       // o grupo atual vem selecionado
    expect(within(group).getByText('Infra')).toBeTruthy()
    expect(sector.value).toBe('')                        // sem setor
  })

  it('escolher um grupo move o terminal', async () => {
    const spy = stubFetch()
    const pop = await openMenu()
    fireEvent.change(pop.getByTestId('menu-group'), { target: { value: '20' } })
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/projects/1/group', expect.objectContaining({ method: 'PATCH' })))
  })

  it('a opção vazia tira do grupo', async () => {
    const spy = stubFetch()
    const pop = await openMenu()
    fireEvent.change(pop.getByTestId('menu-group'), { target: { value: '' } })
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([u]) => String(u).includes('/projects/1/group'))
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ groupId: null })
    })
  })

  it('o atalho de criar grupo continua ali', async () => {
    stubFetch()
    const pop = await openMenu()
    expect(pop.getByPlaceholderText(/novo grupo/i)).toBeTruthy()
  })
})
