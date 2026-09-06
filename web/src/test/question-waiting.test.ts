import { describe, it, expect } from 'vitest'
import { isWaitingForYou, dotClassOf, displayStatusKey } from '../engineSession'
import { faceStateOf } from '../components/AgentFace'
import type { PendingQuestion, SessionInfo } from '../types'

const PENDING: PendingQuestion = { toolUseId: 't', questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [] }] }
const sess = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'working', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...over })

describe('pergunta pendente = esperando você', () => {
  it('âmbar, rótulo próprio e cara de atenção — mesmo com a sessão em working', () => {
    const s = sess({ pendingQuestion: PENDING })
    expect(isWaitingForYou(s)).toBe(true)
    expect(dotClassOf(s)).toBe('status-dot status-needs_attention')
    expect(displayStatusKey(s)).toBe('question')
    expect(faceStateOf(s)).toBe('attention')
  })

  it('working sem pergunta continua sendo trabalho, não espera', () => {
    const s = sess()
    expect(isWaitingForYou(s)).toBe(false)
    expect(dotClassOf(s)).toBe('status-dot status-working')
    expect(displayStatusKey(s)).toBe('working')
    expect(faceStateOf(s)).toBe('working')
  })
})
