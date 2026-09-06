import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { useStore } from '../store'
import { notifyQuestion } from '../notifications'
import type { PendingQuestion } from '../types'

const PENDING: PendingQuestion = { toolUseId: 'toolu_q_1', questions: [
  { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'Cor azul' }] },
] }
const status = (extra: object) => ({ type: 'session_status', localId: 'l1', projectId: 1, status: 'working', engineSessionId: 'c1', engine: 'claude', ...extra })

beforeEach(() => {
  useStore.setState({ projects: [{ id: 1, name: 'Alpha', path: '/tmp', color: '#fff', icon: '📁' }], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, activeLocalId: undefined, view: 'dashboard', board: [], tasks: [], sessionEffort: {} })
  vi.mocked(notifyQuestion).mockClear()
})

describe('pergunta pendente no store', () => {
  it('session_status com pendingQuestion guarda a pergunta e notifica UMA vez (não a cada rebroadcast)', () => {
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    expect(useStore.getState().sessions['l1'].pendingQuestion).toEqual(PENDING)
    expect(notifyQuestion).toHaveBeenCalledTimes(1)
    expect(notifyQuestion).toHaveBeenCalledWith('Alpha')
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    expect(notifyQuestion).toHaveBeenCalledTimes(1)
  })

  it('session_status SEM pendingQuestion limpa: ausente significa "nenhuma", não "mantém a anterior"', () => {
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    useStore.getState().applyWsMessage(status({ status: 'needs_attention' }))
    expect(useStore.getState().sessions['l1'].pendingQuestion).toBeUndefined()
  })

  it('sessions_snapshot traz a pendência (reload / outra aba)', () => {
    useStore.getState().applyWsMessage({ type: 'sessions_snapshot', sessions: [
      { localId: 'l1', projectId: 1, status: 'working', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude', pendingQuestion: PENDING },
    ] })
    expect(useStore.getState().sessions['l1'].pendingQuestion?.toolUseId).toBe('toolu_q_1')
  })
})
