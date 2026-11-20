import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within, act } from '@testing-library/react'
import { EngineTabs } from '../components/EngineTabs'
import { useStore } from '../store'
import * as api from '../api'
import type { EngineMeta, Project, SessionInfo, SessionStatus } from '../types'

const meta = (id: string, label: string, extra: Partial<EngineMeta> = {}): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [], ...extra,
})
const CLAUDE = meta('claude', 'Claude Code')
const CODEX = meta('codex', 'Codex')
const KIMI = meta('kimi', 'Kimi Code')
const OPENCODE = meta('opencode', 'OpenCode')

const project = (engines: string[]): Project =>
  ({ id: 1, name: 'Terminal', path: '/tmp/t', color: '#000', icon: 'x', engines })

const sess = (localId: string, engine: string, status: SessionStatus): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine })

const setup = (engines: string[], catalog: EngineMeta[] = [CLAUDE, CODEX, KIMI, OPENCODE]) => {
  useStore.setState({
    engines: catalog,
    enginesLoaded: true,
    projects: [project(engines)],
    sessions: { c1: sess('c1', 'claude', 'idle') },
  })
}

const tabLabels = () => screen.getAllByRole('tab').map((el) => el.querySelector('.engine-tab__label')?.textContent)
const addButton = () => screen.queryByRole('button', { name: /acrescentar engine/i })
const openMenu = () => {
  fireEvent.click(addButton()!)
  return document.querySelector('.sess-pop') as HTMLElement
}

beforeEach(() => {
  useStore.setState({ projects: [], sessions: {}, terminalStates: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('EngineTabs — abas seguem a lista do terminal', () => {
  it("cabeçalho de terminal com lista ['claude'] mostra uma aba", () => {
    setup(['claude'])
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code'])
  })

  it('o + lista os escondidos com selo de não instalada', () => {
    setup(['claude'], [CLAUDE, CODEX, { ...KIMI, available: false }, OPENCODE])
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    const items = Array.from(menu.querySelectorAll('.sess-pop__item'))
    expect(items.map((el) => el.querySelector('.engine-add__label')?.textContent)).toEqual(['Codex', 'Kimi Code', 'OpenCode'])
    const kimi = items.find((el) => el.textContent?.includes('Kimi Code'))!
    expect(kimi.textContent).toContain('não instalada')
    const codex = items.find((el) => el.textContent?.includes('Codex'))!
    expect(codex.textContent).not.toContain('não instalada')
  })

  it('no +, o motor não instalado fica desabilitado e o clique não grava nada', () => {
    setup(['claude'], [CLAUDE, CODEX, { ...KIMI, available: false }, OPENCODE])
    const spy = vi.spyOn(api, 'setProjectEngines').mockResolvedValue(project(['claude', 'kimi']))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    const kimi = Array.from(menu.querySelectorAll('.sess-pop__item')).find((el) => el.textContent?.includes('Kimi Code'))!
    expect(kimi.className).toContain('sess-pop__item--disabled')
    fireEvent.click(kimi)
    expect(spy).not.toHaveBeenCalled()
    const codex = Array.from(menu.querySelectorAll('.sess-pop__item')).find((el) => el.textContent?.includes('Codex'))!
    expect(codex.className).not.toContain('sess-pop__item--disabled')
  })

  it('com todos os escondidos não instalados, o + aparece e os lista desabilitados', () => {
    setup(['claude'], [CLAUDE, { ...CODEX, available: false }, { ...KIMI, available: false }])
    const spy = vi.spyOn(api, 'setProjectEngines').mockResolvedValue(project(['claude', 'codex']))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(addButton()).not.toBeNull()
    const menu = openMenu()
    const items = Array.from(menu.querySelectorAll('.sess-pop__item'))
    expect(items.map((el) => el.querySelector('.engine-add__label')?.textContent)).toEqual(['Codex', 'Kimi Code'])
    for (const el of items) {
      expect(el.className).toContain('sess-pop__item--disabled')
      fireEvent.click(el)
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('escolher no + chama setProjectEngines com a lista mais o motor e a aba aparece', async () => {
    // "futuro" é um id que esta tela não conhece: precisa voltar ao servidor intacto.
    setup(['claude', 'futuro'])
    const spy = vi.spyOn(api, 'setProjectEngines')
      .mockResolvedValue(project(['claude', 'codex', 'futuro']))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    fireEvent.click(within(menu).getByText('Codex'))
    expect(spy).toHaveBeenCalledWith(1, ['claude', 'futuro', 'codex'])
    await vi.waitFor(() => expect(tabLabels()).toEqual(['Claude Code', 'Codex']))
    expect(useStore.getState().projects[0].engines).toEqual(['claude', 'codex', 'futuro'])
    expect(document.querySelector('.sess-pop')).toBeNull()
  })

  it('falha ao gravar a lista aparece no menu e não muda as abas', async () => {
    setup(['claude'])
    vi.spyOn(api, 'setProjectEngines').mockRejectedValue(new Error('Escolha pelo menos uma engine conhecida.'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    fireEvent.click(within(menu).getByText('Codex'))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Escolha pelo menos uma engine conhecida.'))
    expect(tabLabels()).toEqual(['Claude Code'])
    expect(useStore.getState().projects[0].engines).toEqual(['claude'])
  })

  it('sem escondidos, o + não aparece', () => {
    setup(['claude', 'codex', 'kimi', 'opencode'])
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code', 'Codex', 'Kimi Code', 'OpenCode'])
    expect(addButton()).toBeNull()
  })

  it('conversa aberta de motor escondido ganha aba', () => {
    setup(['claude'])
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'idle'), k1: sess('k1', 'kimi', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="k1" />)
    expect(tabLabels()).toEqual(['Claude Code', 'Kimi Code'])
  })

  it('motor escondido com aviso de interrompido ganha aba', () => {
    setup(['claude'])
    useStore.setState({
      terminalStates: {
        '1:codex': { projectId: 1, engine: 'codex', autostart: false, autoResume: false, interruption: { at: 'x', reason: 'off' }, autoResumeLimit: false, usageLimit: null },
      },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code', 'Codex'])
  })

  it('motor escondido com aviso de limite de uso ganha aba', () => {
    // O limite absorve a marca do reinício: o aviso aberto é o do limite, sem interrupção.
    setup(['claude'])
    useStore.setState({
      terminalStates: {
        '1:codex': { projectId: 1, engine: 'codex', autostart: false, autoResume: false, interruption: null, autoResumeLimit: false,
          usageLimit: { hitAt: 'x', resetsAt: null, action: 'none', origin: 'operator' } },
      },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code', 'Codex'])
  })
})

describe('EngineTabs — aviso de terminal sem motor instalado', () => {
  // Renderiza como o ChatView: o activeLocalId é sempre a sessão na tela, e a aba
  // dela fica mesmo parada e fora da lista.
  const notice = () => document.querySelector('.engine-tabs__none') as HTMLElement | null

  it('conversa encerrada de motor instalado fora da lista: a aba fica e o aviso aparece ao lado', () => {
    // O caso do ensaio: lista ['opencode'] sem o binário, chat aberto numa sessão
    // do Claude já encerrada.
    setup(['opencode'], [CLAUDE, CODEX, KIMI, { ...OPENCODE, available: false }])
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code'])
    expect(notice()).not.toBeNull()
    expect(notice()!.textContent).toContain('Nenhum motor desta lista está instalado')
    expect(within(notice()!).getByRole('button', { name: 'editar' })).toBeTruthy()
  })

  it('conversa encerrada de motor desinstalado da lista: a aba fica e o aviso aparece', () => {
    setup(['codex', 'kimi'], [CLAUDE, { ...CODEX, available: false }, { ...KIMI, available: false }])
    useStore.setState({ sessions: { x1: sess('x1', 'codex', 'dead') } })
    render(<EngineTabs projectId={1} activeLocalId="x1" />)
    expect(tabLabels()).toEqual(['Codex'])
    expect(notice()).not.toBeNull()
  })

  it('id da lista que o catálogo não conhece conta como não instalado', () => {
    setup(['futuro'], [CLAUDE, CODEX])
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(notice()).not.toBeNull()
  })

  it('sem aba nenhuma, o aviso ocupa o lugar das abas', () => {
    setup(['codex'], [CLAUDE, { ...CODEX, available: false }])
    useStore.setState({ sessions: {} })
    render(<EngineTabs projectId={1} activeLocalId="" />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(notice()).not.toBeNull()
  })

  it('editar abre o formulário do terminal', () => {
    setup(['opencode'], [CLAUDE, { ...OPENCODE, available: false }])
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(screen.queryByRole('heading', { name: 'Editar terminal' })).toBeNull()
    fireEvent.click(within(notice()!).getByRole('button', { name: 'editar' }))
    expect(screen.getByRole('heading', { name: 'Editar terminal' })).toBeTruthy()
    // O formulário é o da edição deste terminal, com o nome dele.
    expect((screen.getByDisplayValue('Terminal') as HTMLInputElement).value).toBe('Terminal')
  })

  it('com um motor instalado na lista, o aviso não aparece', () => {
    setup(['codex', 'kimi'], [CLAUDE, { ...CODEX, available: false }, KIMI])
    useStore.setState({ sessions: { x1: sess('x1', 'codex', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="x1" />)
    expect(tabLabels()).toEqual(['Codex', 'Kimi Code'])
    expect(notice()).toBeNull()
  })

  it('sessão viva de motor desinstalado mantém a aba e não mostra o aviso', () => {
    setup(['codex'], [CLAUDE, { ...CODEX, available: false }])
    useStore.setState({ sessions: { x1: sess('x1', 'codex', 'idle') } })
    render(<EngineTabs projectId={1} activeLocalId="x1" />)
    expect(tabLabels()).toEqual(['Codex'])
    expect(notice()).toBeNull()
  })

  it('sessão viva de motor fora da lista não mostra o aviso', () => {
    setup(['opencode'], [CLAUDE, { ...OPENCODE, available: false }])
    useStore.setState({ sessions: { c1: sess('c1', 'claude', 'working') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code'])
    expect(notice()).toBeNull()
  })

  it('com o catálogo embutido, antes da resposta do servidor, o aviso não aparece', () => {
    // O store nasce com o catálogo embutido (só Claude e Codex, sem `available`).
    // Um terminal com ['kimi'] parece sem motor instalado até o GET /api/engines
    // responder, ou para sempre se ele falhar: o aviso não pode piscar nem ficar.
    setup(['kimi'], useStore.getInitialState().engines)
    useStore.setState({ enginesLoaded: false, sessions: { c1: sess('c1', 'claude', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(tabLabels()).toEqual(['Claude Code'])
    expect(notice()).toBeNull()
  })

  it('com o catálogo do servidor e o kimi não instalado, o aviso aparece', () => {
    setup(['kimi'], [CLAUDE, CODEX, { ...KIMI, available: false }])
    useStore.setState({ enginesLoaded: false, sessions: { c1: sess('c1', 'claude', 'stopped') } })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(notice()).toBeNull()
    act(() => { useStore.getState().setEngines([CLAUDE, CODEX, { ...KIMI, available: false }]) })
    expect(notice()).not.toBeNull()
  })
})
