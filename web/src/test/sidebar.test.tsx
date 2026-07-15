import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo } from '../types'

const sess = (localId: string, projectId: number, status: SessionInfo['status'], engine = 'claude'): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine })

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: '✳',
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'], efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'], slashSource: 'protocol', slashCommands: [],
}
const CODEX: EngineMeta = {
  id: 'codex', label: 'Codex', icon: '◆',
  models: ['', 'gpt-5.6-sol'], efforts: ['low', 'medium', 'high', 'xhigh'], permissions: [],
  slashSource: 'curated', slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
}

beforeEach(() => {
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '🅰️' },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '🅱️' },
    ],
    sessions: { s1: sess('s1', 1, 'stopped') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined,
    engines: [CLAUDE, CODEX],
    groups: [],
  })
  localStorage.removeItem('claudinei:collapsedGroups')
})
afterEach(() => cleanup())

describe('Sidebar Terminais', () => {
  it('lista TODOS os projetos (com e sem sessão) e o card de interação', () => {
    render(<Sidebar />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText(/Interação entre terminais/i)).toBeTruthy()
    expect(screen.getByText('Mural')).toBeTruthy()
    expect(screen.getByText('Tarefas')).toBeTruthy()
    expect(screen.getByText('Terminais')).toBeTruthy()
  })

  it('sessão stopped mostra Reviver, que abre o seletor de engine em vez de reviver direto', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Reviver'))
    // não chama /revive sozinho — pergunta qual engine antes
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
  })

  it('escolher a engine no seletor de Reviver chama POST /revive (ou start) daquela engine e abre a sessão', async () => {
    // resposta nova a cada chamada: o body de Response só pode ser lido uma vez, e o
    // UsageCard da sidebar também chama fetch (usage) — uma instância compartilhada
    // quebraria a segunda leitura.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u === '/api/sessions/s1/revive') {
        return new Response(JSON.stringify({ localId: 's1', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x', engine: 'claude' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Reviver'))
    fireEvent.click(screen.getByText('Claude Code'))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/sessions/s1/revive', expect.objectContaining({ method: 'POST' })))
    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('s1'))
    spy.mockRestore()
  })

  it('projeto sem sessão mostra Iniciar (abre o StartSessionModal)', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Iniciar sessão'))
    expect(screen.getByText(/Nova sessão/)).toBeTruthy()
  })

  it('ⓘ ao lado de Interação abre o modal do Board & Tasks e fecha no botão', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Board & Tasks — colaboração entre agentes'))
    expect(screen.getByText(/quadro de avisos/)).toBeTruthy()          // seção Board
    expect(screen.getByText(/delegação com fila/)).toBeTruthy()        // seção Tasks
    expect(screen.getByText(/dispatch_task\(project, task\)/)).toBeTruthy() // ferramenta citada
    fireEvent.click(screen.getByText('OK'))
    expect(screen.queryByText(/quadro de avisos/)).toBeNull()
  })

  it('⚙ abre o menu de opções; Editar abre o modal em modo edição', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getAllByTitle('Opções')[0])
    fireEvent.click(screen.getByText('Editar'))
    expect(screen.getByText('Editar terminal')).toBeTruthy()
  })

  it('⚙ → Excluir abre a confirmação de exclusão', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getAllByTitle('Opções')[0])
    fireEvent.click(screen.getByText('Excluir')) // item do menu
    // o ConfirmDialog mostra o botão de confirmar "Excluir <nome>"
    expect(screen.getByText(/Excluir Alpha\?/)).toBeTruthy()
  })

  it('"+ Terminal" abre o modal de criação', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Terminal'))
    expect(screen.getByText('Novo projeto')).toBeTruthy()
  })

  it('drop de card em card persiste a nova ordem via PUT /api/sidebar-order', async () => {
    const reordered = [
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '🅱️', groupId: null, sortOrder: 0 },
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '🅰️', groupId: null, sortOrder: 1 },
    ]
    const bodies: any[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'PUT' && String(url).includes('/api/sidebar-order')) {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ projects: reordered, groups: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    render(<Sidebar />)
    const cards = screen.getAllByTestId('term-card')
    fireEvent.dragStart(cards[0])   // Alpha…
    fireEvent.dragOver(cards[1])
    fireEvent.drop(cards[1])        // …solto sobre Beta (vizinho de baixo) → troca
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0].entries).toEqual([{ kind: 'project', id: 2 }, { kind: 'project', id: 1 }])
    await vi.waitFor(() => expect(useStore.getState().projects.map((p) => p.id)).toEqual([2, 1]))
    spy.mockRestore()
  })

  it('sessão viva vence uma stopped mais "recente" na escolha do card (tie-break por vida)', () => {
    useStore.setState({
      sessions: {
        old: { ...sess('old', 1, 'stopped'), updatedAt: '2026-07-10 20:00:00' },
        nova: { ...sess('nova', 1, 'working'), updatedAt: '' }, // chegou via session_status, sem updatedAt
      },
    })
    render(<Sidebar />)
    expect(screen.getByText('trabalhando')).toBeTruthy() // card mostra a viva
    expect(screen.queryByTitle('Reviver')).toBeNull() // não oferece Reviver
  })

  describe('badge de engine no term-card (SP-C Task 4)', () => {
    it('mostra o ícone da engine da sessão — distingue 1 Claude + 1 Codex em projetos diferentes', () => {
      useStore.setState({
        sessions: {
          s1: sess('s1', 1, 'idle', 'claude'),
          s2: sess('s2', 2, 'idle', 'codex'),
        },
      })
      render(<Sidebar />)
      const cards = screen.getAllByTestId('term-card')
      const alphaCard = cards.find((c) => c.textContent?.includes('Alpha'))!
      const betaCard = cards.find((c) => c.textContent?.includes('Beta'))!
      expect(alphaCard.querySelector('.engine-badge')?.textContent).toBe('✳')
      expect(betaCard.querySelector('.engine-badge')?.textContent).toBe('◆')
    })

    it('sem sessão, o card não mostra badge de engine', () => {
      useStore.setState({ sessions: {} })
      render(<Sidebar />)
      for (const card of screen.getAllByTestId('term-card')) {
        expect(card.querySelector('.engine-badge')).toBeNull()
      }
    })
  })

  describe('gate de admin (isAdmin)', () => {
    const usageResponse = () =>
      new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', label: null, percent: 10, severity: 'ok', resetsAt: '2026-07-20T00:00:00Z' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    it('não-admin: sem "+ Terminal", sem UsageCard e sem ⚙ nos cards', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => usageResponse())
      useStore.setState({ me: { setupRequired: false, id: 1, username: 'u', isAdmin: false } })
      const { container } = render(<Sidebar />)
      expect(screen.queryByText('+ Terminal')).toBeNull()
      expect(container.querySelector('.usage-card')).toBeNull()
      expect(container.querySelectorAll('.term-card__action--reveal').length).toBe(0)
      // dá tempo pro efeito do UsageCard rodar (não deveria nem montar) sem deixar a asserção falsa-positiva
      await new Promise((r) => setTimeout(r, 0))
      expect(container.querySelector('.usage-card')).toBeNull()
      spy.mockRestore()
    })

    it('admin: mostra "+ Terminal", UsageCard e ⚙ nos cards', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => usageResponse())
      useStore.setState({ me: { setupRequired: false, id: 1, username: 'u', isAdmin: true } })
      const { container } = render(<Sidebar />)
      expect(screen.getByText('+ Terminal')).toBeTruthy()
      await vi.waitFor(() => expect(container.querySelector('.usage-card')).toBeTruthy())
      expect(container.querySelectorAll('.term-card__action--reveal').length).toBeGreaterThan(0)
      spy.mockRestore()
    })
  })
})

describe('grupos de terminais', () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const setupGrouped = () => {
    useStore.setState({
      projects: [
        { id: 1, name: 'X Front', path: '/tmp/a', color: '#ff0000', icon: '🅰️', groupId: 10 },
        { id: 2, name: 'X Back', path: '/tmp/b', color: '#00ff00', icon: '🅱️', groupId: 10 },
        { id: 3, name: 'Solto', path: '/tmp/c', color: '#0000ff', icon: '📁', groupId: null },
      ],
      groups: [{ id: 10, name: 'Projeto X' }],
    })
  }

  it('renderiza o grupo com nome + contagem, filhos dentro e o solto fora', () => {
    setupGrouped()
    render(<Sidebar />)
    const group = screen.getByTestId('term-group')
    expect(group.textContent).toContain('Projeto X')
    expect(group.querySelector('.term-group__count')?.textContent).toBe('2')
    // filhos dentro do corpo do grupo
    const body = group.querySelector('.term-group__body')!
    expect(body.textContent).toContain('X Front')
    expect(body.textContent).toContain('X Back')
    // o solto fica fora do grupo
    expect(group.textContent).not.toContain('Solto')
    expect(screen.getByText('Solto')).toBeTruthy()
  })

  it('clicar no cabeçalho colapsa (some os filhos, mostra os dots) e persiste no localStorage', () => {
    setupGrouped()
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Projeto X'))
    const group = screen.getByTestId('term-group')
    expect(group.querySelector('.term-group__body')).toBeNull()
    expect(group.querySelectorAll('.term-group__dots .status-dot').length).toBe(2)
    expect(JSON.parse(localStorage.getItem('claudinei:collapsedGroups')!)).toEqual([10])
    // reabrir
    fireEvent.click(screen.getByText('Projeto X'))
    expect(screen.getByTestId('term-group').querySelector('.term-group__body')).toBeTruthy()
  })

  it('arrastar um card e soltar no grupo persiste a estrutura via PUT /api/sidebar-order', async () => {
    setupGrouped()
    const bodies: any[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (init?.method === 'PUT' && String(url).includes('/api/sidebar-order')) {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(jsonResponse({ projects: [], groups: [] }))
      }
      return Promise.resolve(jsonResponse([]))
    })
    render(<Sidebar />)
    const cards = screen.getAllByTestId('term-card')
    const solto = cards.find((c) => c.textContent?.includes('Solto'))!
    fireEvent.dragStart(solto)
    const group = screen.getByTestId('term-group')
    fireEvent.dragOver(group)
    fireEvent.drop(group)
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    // o Solto (id 3) entrou como ÚLTIMO filho do grupo 10
    const g = bodies[0].entries.find((e: any) => e.kind === 'group' && e.id === 10)
    expect(g.children).toEqual([1, 2, 3])
  })

  it('arrastar o GRUPO e soltar no terminal vizinho de baixo TROCA de lugar', async () => {
    setupGrouped()
    const bodies: any[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (init?.method === 'PUT' && String(url).includes('/api/sidebar-order')) {
        bodies.push(JSON.parse(String(init.body)))
        return Promise.resolve(jsonResponse({ projects: [], groups: [] }))
      }
      return Promise.resolve(jsonResponse([]))
    })
    render(<Sidebar />)
    const header = screen.getByTestId('term-group').querySelector('.term-group__header')!
    fireEvent.dragStart(header)
    const cards = screen.getAllByTestId('term-card')
    const solto = cards.find((c) => c.textContent?.includes('Solto'))!
    fireEvent.dragOver(solto)
    fireEvent.drop(solto)
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    // o grupo (que estava ACIMA) desce pra depois do Solto; filhos preservados
    expect(bodies[0].entries.map((e: any) => e.kind)).toEqual(['project', 'group'])
    expect(bodies[0].entries[0].id).toBe(3)
    expect(bodies[0].entries[1].children).toEqual([1, 2])
  })

  it('grupos e soltos intercalam pela ordem unificada (sortOrder)', () => {
    useStore.setState({
      projects: [
        { id: 1, name: 'Primeiro', path: '/tmp/a', color: '#f00', icon: '🅰️', groupId: null, sortOrder: 0 },
        { id: 2, name: 'Filho', path: '/tmp/b', color: '#0f0', icon: '🅱️', groupId: 10, sortOrder: 2 },
        { id: 3, name: 'Ultimo', path: '/tmp/c', color: '#00f', icon: '📁', groupId: null, sortOrder: 5 },
      ],
      groups: [{ id: 10, name: 'No Meio', sortOrder: 1 }],
    })
    render(<Sidebar />)
    const list = document.querySelector('.term-list')!
    const names = Array.from(list.querySelectorAll('[data-testid="term-card"], [data-testid="term-group"]'))
      .map((el) => (el.getAttribute('data-testid') === 'term-group' ? 'GRUPO' : el.textContent?.match(/Primeiro|Ultimo/)?.[0]))
      .filter((x) => x !== undefined)
    // o grupo (sortOrder 1) fica ENTRE Primeiro (0) e Ultimo (5); o Filho está dentro dele
    expect(names.slice(0, 3)).toEqual(['Primeiro', 'GRUPO', 'Ultimo'])
  })

  it('menu ⚙ do card tem a seção Grupo (lista + Sem grupo + input de novo grupo)', () => {
    setupGrouped()
    render(<Sidebar />)
    const cards = screen.getAllByTestId('term-card')
    const front = cards.find((c) => c.textContent?.includes('X Front'))!
    fireEvent.click(front.querySelector('.term-card__action--reveal')!)
    expect(screen.getByText('Grupo')).toBeTruthy()
    expect(screen.getAllByText('Projeto X').length).toBeGreaterThan(0) // opção no menu
    expect(screen.getByText('Sem grupo')).toBeTruthy() // X Front está num grupo → pode sair
    expect(screen.getByPlaceholderText('Nome do novo grupo…')).toBeTruthy()
  })

  it('grupo vazio aparece pra admin como alvo de drop (com dica)', () => {
    useStore.setState({
      projects: [{ id: 3, name: 'Solto', path: '/tmp/c', color: '#00f', icon: '📁', groupId: null }],
      groups: [{ id: 11, name: 'Vazio' }],
    })
    render(<Sidebar />)
    expect(screen.getByText('Vazio')).toBeTruthy()
    expect(screen.getByText('arraste terminais para cá')).toBeTruthy()
  })
})

describe('status agregado do projeto (multi-engine)', () => {
  it('Claude idle + Codex working → o card mostra TRABALHANDO (com o badge da engine ativa)', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️' }],
      sessions: {
        s1: sess('s1', 1, 'idle', 'claude'),
        s2: sess('s2', 1, 'working', 'codex'),
      },
    })
    render(<Sidebar />)
    const card = screen.getByTestId('term-card')
    expect(card.textContent).toContain('trabalhando')
    expect(card.textContent).not.toContain('ociosa')
  })

  it('needs_attention vence working (o que espera você é o mais urgente)', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️' }],
      sessions: {
        s1: sess('s1', 1, 'working', 'claude'),
        s2: sess('s2', 1, 'needs_attention', 'codex'),
      },
    })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').textContent).toContain('aguardando você')
  })

  it('badge soma os não-lidos de TODAS as engines do projeto', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️' }],
      sessions: {
        s1: sess('s1', 1, 'idle', 'claude'),
        s2: sess('s2', 1, 'working', 'codex'),
      },
      unread: { s1: 2, s2: 3 },
    })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').querySelector('.badge')?.textContent).toBe('5')
  })
})
