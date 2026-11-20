import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { WorkingStrip } from '../components/WorkingStrip'
import { useStore } from '../store'
import type { SessionInfo } from '../types'

/**
 * Quantas vezes a faixa renderiza. Um `Profiler` não serve aqui: posto dentro de
 * um pai que re-renderiza, ele dispara a cada render do pai mesmo quando o filho
 * `memo` não roda (o commit sai com ~0 ms, mas sai). A faixa chama
 * `useTranslation` em todo render dela, e nada mais neste teste chama — então a
 * contagem dessas chamadas é a contagem de renders da faixa.
 */
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-i18next', async (importOriginal) => {
  const orig = await importOriginal<typeof import('react-i18next')>()
  return {
    ...orig,
    useTranslation: ((...args: Parameters<typeof orig.useTranslation>) => {
      renders.count++
      return orig.useTranslation(...args)
    }) as typeof orig.useTranslation,
  }
})

const session = (projectId: number, status: SessionInfo['status'], extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: `s${projectId}`, projectId, status, engine: 'claude', engineSessionId: 'c', updatedAt: 'x', ...extra })

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' },
      { id: 2, name: 'Beta', path: '/b', color: '#fff', icon: '📁' },
    ],
    sessions: { s1: session(1, 'working'), s2: session(2, 'idle') },
    triage: {}, unread: { s2: 3 }, chat: {}, engines: [],
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const setSession = (s: SessionInfo) =>
  act(() => { useStore.setState({ sessions: { ...useStore.getState().sessions, [s.localId]: s } }) })

describe('a faixa Trabalhando dentro de um pai que re-renderiza', () => {
  it('o pai re-renderiza a cada status, a faixa (memo) não', () => {
    // Como a lateral: o pai assina as sessões e re-renderiza a cada evento.
    let hostRenders = 0
    const Host = () => {
      useStore((s) => s.sessions)
      hostRenders++
      return <WorkingStrip />
    }
    render(<Host />)
    expect(screen.getAllByTestId('working-row')).toHaveLength(1)
    renders.count = 0
    hostRenders = 0

    setSession(session(2, 'idle', { updatedAt: 'y' }))
    setSession(session(2, 'needs_attention'))
    setSession(session(2, 'idle'))
    expect(hostRenders).toBe(3)
    expect(renders.count).toBe(0)

    // Prova de que a contagem mede: mudar quem está na faixa renderiza a faixa.
    setSession(session(1, 'working', { compactingSince: 1 }))
    expect(renders.count).toBeGreaterThan(0)
  })
})

describe('o seletor da faixa', () => {
  /**
   * `Object.values(sessions)` passa pelo `ownKeys` do Proxy: cada passagem pelas
   * sessões fica contada. Uma escrita que não troca `sessions` nem `triage` (o
   * streaming do chat, um não-lido) não pode refazer a conta.
   */
  it('não refaz a conta numa escrita que não toca sessões nem triagem', () => {
    let passes = 0
    const counted = (sessions: Record<string, SessionInfo>) =>
      new Proxy(sessions, { ownKeys: (t) => { passes++; return Reflect.ownKeys(t) } })
    useStore.setState({ sessions: counted({ s1: session(1, 'working'), s2: session(2, 'idle') }) })
    render(<WorkingStrip />)
    passes = 0

    act(() => { useStore.setState({ unread: { s2: 0 } }) })
    act(() => { useStore.setState({ chat: { s1: [] } as never }) })
    act(() => { useStore.setState({ streaming: { s1: 'abc' } as never }) })
    expect(passes).toBe(0)

    // Sessões novas (outra referência) refazem a conta, e a triagem também.
    act(() => { useStore.setState({ sessions: counted({ s1: session(1, 'working'), s2: session(2, 'working') }) }) })
    expect(passes).toBeGreaterThan(0)
    expect(screen.getAllByTestId('working-row')).toHaveLength(2)
    passes = 0
    act(() => { useStore.setState({ triage: { 2: { projectId: 2, pinned: false, settled: false, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() } } }) })
    expect(passes).toBeGreaterThan(0)
    expect(screen.getAllByTestId('working-row')).toHaveLength(1)
  })
})
