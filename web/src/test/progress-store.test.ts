import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, progressKey } from '../store'
import type { Progress } from '../types'

/**
 * Acompanhamento de tarefas longas na interface: um estado por terminal
 * (projeto + motor), atualizado pelo WebSocket, e a coluna lembra se estava aberta.
 */
const andamento = (title: string): Progress => ({
  title, now: { title: 'agora' }, tasks: [{ name: 'a', status: 'in_progress' }], waiting: [], updatedAt: '2026-11-18T10:00:00.000Z',
})

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ progress: {} })
})

describe('estado do acompanhamento', () => {
  it('mensagem progress guarda por projeto e motor', () => {
    useStore.getState().applyWsMessage({ type: 'progress', projectId: 1, engine: 'claude', progress: andamento('do Claude') })
    useStore.getState().applyWsMessage({ type: 'progress', projectId: 1, engine: 'codex', progress: andamento('do Codex') })
    const p = useStore.getState().progress
    expect(p[progressKey(1, 'claude')]?.title).toBe('do Claude')
    expect(p[progressKey(1, 'codex')]?.title).toBe('do Codex')
    expect(progressKey(1, 'claude')).toBe('1:claude')
  })

  it('progress null apaga', () => {
    useStore.getState().setProgress(1, 'claude', andamento('x'))
    useStore.getState().applyWsMessage({ type: 'progress', projectId: 1, engine: 'claude', progress: null })
    expect(useStore.getState().progress[progressKey(1, 'claude')]).toBeNull()
  })

  it('abrir/fechar a coluna persiste', () => {
    useStore.setState({ progressOpen: false })
    useStore.getState().toggleProgress()
    expect(useStore.getState().progressOpen).toBe(true)
    expect(localStorage.getItem('claudinei:progressOpen')).toBe('1')
    useStore.getState().toggleProgress()
    expect(localStorage.getItem('claudinei:progressOpen')).toBe('0')
  })
  // Conexão que volta (notebook acordando): o que chegou enquanto estava fora
  // se perdeu; a coluna tem de reler, não seguir mostrando o estado velho.
  it('reconectar zera o acompanhamento e pede releitura', () => {
    useStore.getState().setProgress(1, 'claude', andamento('velho'))
    const antes = useStore.getState().progressEpoch
    useStore.getState().resyncOnReconnect()
    expect(useStore.getState().progress).toEqual({})
    expect(useStore.getState().progressEpoch).toBe(antes + 1)
  })
})
