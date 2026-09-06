import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
const session = { localId: 'codex', engine: 'codex', projectId: 1, status: 'idle' as const, engineSessionId: 'thread', updatedAt: '' }
beforeEach(() => useStore.setState({ sessions: { codex: session }, chat: {}, unread: {} }))
describe('contexto Codex por WebSocket', () => {
  it('telemetria atualiza a sessão sem criar mensagens, e invalidação limpa os valores', () => {
    const apply = useStore.getState().applyWsMessage
    apply({ type: 'session_event', localId: 'codex', event: { kind: 'context', contextTokens: 120000, contextWindow: 400000 } })
    expect(useStore.getState().sessions.codex).toMatchObject({ contextTokens: 120000, contextWindow: 400000 })
    expect(useStore.getState().chat.codex).toBeUndefined()
    apply({ type: 'session_event', localId: 'codex', event: { kind: 'context' } })
    expect(useStore.getState().sessions.codex.contextTokens).toBeUndefined()
    expect(useStore.getState().sessions.codex.contextWindow).toBeUndefined()
  })
  it('snapshot restaura medidor e compactação após reconectar', () => {
    const apply = useStore.getState().applyWsMessage
    apply({ type: 'sessions_snapshot', sessions: [{ ...session, contextTokens: 300000, contextWindow: 400000, compactingSince: 123 }] })
    expect(useStore.getState().sessions.codex).toMatchObject({ contextTokens: 300000, compactingSince: 123 })
    apply({ type: 'session_status', ...session, status: 'needs_attention', contextTokens: 30000, contextWindow: 400000 })
    expect(useStore.getState().sessions.codex).toMatchObject({ contextTokens: 30000, contextWindow: 400000 })
    expect(useStore.getState().sessions.codex.compactingSince).toBeUndefined()
  })
})
