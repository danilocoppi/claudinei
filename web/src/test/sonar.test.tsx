import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

/** Setor 100 → Grupo 10 → Alpha (esperando). Beta ocioso na raiz. */
beforeEach(() => {
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '🅰️', groupId: 10 },
      { id: 2, name: 'Beta', path: '/b', color: '#fff', icon: '🅱️' },
    ],
    groups: [{ id: 10, name: 'Backend', sectorId: 100 }],
    sectors: [{ id: 100, name: 'Produto' }],
    schedules: [],
    sessions: { s1: sess('s1', 1, 'needs_attention'), s2: sess('s2', 2, 'idle') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const cardOf = (name: string) =>
  screen.getAllByTestId('term-card').find((c) => within(c).queryByText(name))!
const headerOf = (name: string, cls: string) =>
  (screen.getByText(name).closest(cls) as HTMLElement)

/**
 * O véu âmbar era discreto demais: com meia dúzia de terminais na lista, um
 * contorno fino não chama ninguém. O sonar pulsa até alguém olhar.
 */
describe('o sonar de quem espera você', () => {
  it('pulsa no cartão do terminal que espera', () => {
    render(<Sidebar />)
    expect(cardOf('Alpha').querySelector('.sonar')).toBeTruthy()
  })

  it('quem não espera não pulsa', () => {
    render(<Sidebar />)
    expect(cardOf('Beta').querySelector('.sonar')).toBeNull()
  })

  /** Dois anéis defasados: um anel só piscaria com intervalo morto no meio. */
  it('são dois anéis, para o pulso não ter buraco', () => {
    render(<Sidebar />)
    expect(cardOf('Alpha').querySelectorAll('.sonar i')).toHaveLength(2)
  })

  /**
   * A escalada: com o grupo fechado, o cartão não existe na tela. O chamado sobe
   * para quem está visível, senão o estado se esconde exatamente onde ninguém olha.
   */
  it('grupo fechado assume o pulso do terminal escondido', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Backend'))
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(headerOf('Backend', '.term-group__header').querySelector('.sonar')).toBeTruthy()
  })

  /** Grupo aberto não repete o chamado: quem pulsa é o cartão, que está à vista. */
  it('grupo aberto deixa o pulso com o cartão', () => {
    render(<Sidebar />)
    expect(headerOf('Backend', '.term-group__header').querySelector('.sonar')).toBeNull()
    expect(cardOf('Alpha').querySelector('.sonar')).toBeTruthy()
  })

  it('setor fechado assume o pulso do que está lá dentro', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Produto'))
    expect(screen.queryByText('Backend')).toBeNull()
    expect(headerOf('Produto', '.term-sector__header').querySelector('.sonar')).toBeTruthy()
  })
})

describe('o desenho do pulso', () => {
  it('o anel cresce e some, em vez de piscar', () => {
    const bloco = css.slice(css.indexOf('@keyframes sonar'))
    expect(bloco.slice(0, 220)).toMatch(/box-shadow[^;]*0 0 0 0/)
    expect(bloco.slice(0, 220)).toMatch(/opacity: *0/)
  })

  /**
   * Parado, o chamado não pode sumir: quem desliga animação continua precisando
   * ver quem espera.
   */
  it('sem movimento, o anel fica aceso em vez de sumir', () => {
    const forcado = css.slice(css.indexOf('[data-motion="reduced"]'))
    expect(forcado).toMatch(/\.sonar i/)
    expect(css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '').toMatch(/sonar/)
  })
})
