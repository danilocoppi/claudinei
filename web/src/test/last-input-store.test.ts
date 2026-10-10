import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { useStore } from '../store'

const status = (extra: object) => ({ type: 'session_status', localId: 'l1', projectId: 1, status: 'idle', engineSessionId: 'c1', engine: 'claude', ...extra })

beforeEach(() => {
  useStore.setState({ sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, activeLocalId: undefined })
})

/** A última vez que você mexeu no terminal: ordena a coluna de rostinhos. */
describe('lastInputAt no store', () => {
  it('session_input atualiza a sessão conhecida e ignora a desconhecida', () => {
    const { applyWsMessage } = useStore.getState()
    applyWsMessage(status({}))
    applyWsMessage({ type: 'session_input', localId: 'l1', projectId: 1, lastInputAt: '2026-10-09T12:00:00.000Z' })
    applyWsMessage({ type: 'session_input', localId: 'outra', projectId: 1, lastInputAt: '2026-10-09T12:00:00.000Z' })
    expect(useStore.getState().sessions['l1'].lastInputAt).toBe('2026-10-09T12:00:00.000Z')
    expect(useStore.getState().sessions['outra']).toBeUndefined()
  })

  it('session_status com o campo atualiza; sem o campo mantém o anterior', () => {
    const { applyWsMessage } = useStore.getState()
    applyWsMessage(status({ lastInputAt: '2026-10-09T12:00:00.000Z' }))
    applyWsMessage(status({ status: 'working' }))
    expect(useStore.getState().sessions['l1'].lastInputAt).toBe('2026-10-09T12:00:00.000Z')
    applyWsMessage(status({ lastInputAt: '2026-10-09T12:05:00.000Z' }))
    expect(useStore.getState().sessions['l1'].lastInputAt).toBe('2026-10-09T12:05:00.000Z')
  })

  it('sessions_snapshot traz o campo (reload / outro aparelho)', () => {
    useStore.getState().applyWsMessage({ type: 'sessions_snapshot', sessions: [
      { localId: 'l1', projectId: 1, status: 'idle', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude', lastInputAt: '2026-10-09T12:00:00.000Z' },
    ] })
    expect(useStore.getState().sessions['l1'].lastInputAt).toBe('2026-10-09T12:00:00.000Z')
  })
})
