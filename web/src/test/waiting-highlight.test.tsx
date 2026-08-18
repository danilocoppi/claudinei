import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { isWaitingForYou } from '../engineSession'
import type { EngineMeta, Project, SessionInfo } from '../types'

// fileURLToPath direto: o jsdom substitui o construtor global de URL (ver emoji-font.test.ts).
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}

const proj = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, color: '#f0f', icon: '📁', ...extra })

const sess = (
  localId: string, projectId: number, status: SessionInfo['status'],
  terminalActivity?: SessionInfo['terminalActivity'],
): SessionInfo => ({ localId, projectId, status, terminalActivity, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

const cardOf = (name: string) =>
  screen.getAllByTestId('term-card').find((c) => within(c).queryByText(name))!

beforeEach(() => {
  useStore.setState({
    projects: [proj(1, 'Alpha'), proj(2, 'Beta')],
    groups: [], sectors: [],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined, engines: [CLAUDE],
  })
  localStorage.removeItem('claudinei:collapsedGroups')
  localStorage.removeItem('claudinei:collapsedSectors')
  localStorage.removeItem('claudinei:activeOnly')
})
afterEach(() => cleanup())

/**
 * "Esperando você" é o único estado em que o gargalo é o operador — todos os
 * outros são problema da máquina. Vale por dois caminhos: needs_attention no
 * chat e a heurística do TUI (in_terminal + waiting), que mostram o mesmo âmbar.
 */
describe('isWaitingForYou', () => {
  it('vale para needs_attention e para o TUI parado esperando', () => {
    expect(isWaitingForYou(sess('s', 1, 'needs_attention'))).toBe(true)
    expect(isWaitingForYou(sess('s', 1, 'in_terminal', 'waiting'))).toBe(true)
  })

  it('não vale para quem está trabalhando, ocioso ou parado', () => {
    expect(isWaitingForYou(sess('s', 1, 'working'))).toBe(false)
    expect(isWaitingForYou(sess('s', 1, 'in_terminal', 'working'))).toBe(false)
    expect(isWaitingForYou(sess('s', 1, 'in_terminal'))).toBe(false)
    expect(isWaitingForYou(sess('s', 1, 'idle'))).toBe(false)
    expect(isWaitingForYou(sess('s', 1, 'stopped'))).toBe(false)
  })
})

describe('destaque do cartão que espera', () => {
  it('marca o cartão do terminal que espera e deixa os outros em paz', () => {
    useStore.setState({ sessions: { a: sess('a', 1, 'needs_attention'), b: sess('b', 2, 'working') } })
    render(<Sidebar />)
    expect(cardOf('Alpha').className).toMatch(/\bwaiting\b/)
    expect(cardOf('Beta').className).not.toMatch(/\bwaiting\b/)
  })

  it('marca também pelo TUI parado esperando (in_terminal + waiting)', () => {
    useStore.setState({ sessions: { a: sess('a', 1, 'in_terminal', 'waiting') } })
    render(<Sidebar />)
    expect(cardOf('Alpha').className).toMatch(/\bwaiting\b/)
  })

  /**
   * Um projeto pode ter Claude e Codex ao mesmo tempo. Se QUALQUER engine espera,
   * o cartão precisa chamar — olhar só a sessão "principal" perderia o caso, porque
   * in_terminal+waiting tem prioridade menor que working na escolha da principal.
   */
  it('marca quando UMA das engines espera, mesmo com outra trabalhando', () => {
    useStore.setState({ sessions: { a: sess('a', 1, 'working'), a2: sess('a2', 1, 'in_terminal', 'waiting') } })
    render(<Sidebar />)
    expect(cardOf('Alpha').className).toMatch(/\bwaiting\b/)
  })
})

/**
 * O pior caso do estado: dentro de um grupo/setor COLAPSADO o terminal some da
 * lista e sobra uma bolinha de 7px — que o CSS ainda por cima manda sem brilho.
 * Fechado, o cabeçalho precisa herdar o chamado; aberto, o próprio cartão já grita.
 */
describe('propagação para grupo e setor colapsados', () => {
  const withGroup = () => useStore.setState({
    projects: [proj(1, 'Alpha', { groupId: 10 })],
    groups: [{ id: 10, name: 'Backend' }],
    sessions: { a: sess('a', 1, 'needs_attention') },
  })

  it('o cabeçalho do grupo fechado herda o chamado; aberto, não', () => {
    withGroup()
    render(<Sidebar />)
    const header = () => screen.getByTestId('term-group').querySelector('.term-group__header')!
    expect(header().className).not.toMatch(/\bwaiting\b/)  // aberto: o cartão já mostra
    fireEvent.click(screen.getByText('Backend'))
    expect(header().className).toMatch(/\bwaiting\b/)
  })

  it('o setor fechado herda o chamado de um terminal dentro de um grupo dele', () => {
    useStore.setState({
      projects: [proj(1, 'Alpha', { groupId: 10 })],
      groups: [{ id: 10, name: 'Backend', sectorId: 100 }],
      sectors: [{ id: 100, name: 'Produto' }],
      sessions: { a: sess('a', 1, 'needs_attention') },
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Produto'))
    expect(screen.getByTestId('term-sector').querySelector('.term-sector__header')!.className).toMatch(/\bwaiting\b/)
  })

  it('grupo fechado sem ninguém esperando fica quieto', () => {
    withGroup()
    useStore.setState({ sessions: { a: sess('a', 1, 'working') } })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Backend'))
    expect(screen.getByTestId('term-group').querySelector('.term-group__header')!.className).not.toMatch(/\bwaiting\b/)
  })
})

/**
 * O ping vive só no CSS, e o jsdom não aplica folha de estilo — então é o texto
 * do CSS que responde por ele, como já se faz com o ⋮ e a fonte de emoji.
 */
describe('ping âmbar no CSS', () => {
  it('a bolinha que espera emite um anel, e não reusa o pulso do "trabalhando"', () => {
    expect(css).toMatch(/@keyframes ping/)
    const rule = css.match(/\.status-needs_attention::after\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule, 'a bolinha âmbar precisa do anel em ::after').toMatch(/animation:\s*ping/)
    // o pulso de 1,2s é a linguagem do "trabalhando"; o chamado precisa ser mais lento
    const dur = Number(rule.match(/animation:\s*ping\s+([\d.]+)s/)?.[1] ?? 0)
    expect(dur).toBeGreaterThan(1.2)
  })

  it('o anel sobrevive nas mini-bolinhas de cabeçalho fechado (que perdem o box-shadow)', () => {
    // o brilho some por box-shadow; o anel é ::after, então precisa continuar valendo
    expect(css).toMatch(/\.term-group__dots \.status-dot\s*\{[^}]*box-shadow:\s*none/)
    expect(css).not.toMatch(/\.term-group__dots \.status-needs_attention::after\s*\{[^}]*(display:\s*none|content:\s*none)/)
  })

  it('respeita prefers-reduced-motion sem apagar o estado', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/animation:\s*none/)
    // sem movimento o anel fica estático (não sumido): o estado não pode depender só da animação
    expect(block).toMatch(/\.status-needs_attention::after/)
    expect(block).not.toMatch(/\.term-card\.waiting\s*\{[^}]*background:\s*none/)
  })
})
