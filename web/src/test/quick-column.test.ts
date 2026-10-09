import { describe, it, expect } from 'vitest'
import { quickColumnItems } from '../quickColumn'
import type { Project, SessionInfo, SessionStatus } from '../types'

const proj = (id: number): Project => ({ id, name: `T${id}`, path: `/t${id}`, color: '#fff', icon: '📁' })
const sess = (localId: string, projectId: number, status: SessionStatus, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...extra })
const at = (min: number) => `2026-10-09T12:${String(min).padStart(2, '0')}:00.000Z`
const ids = (items: { project: Project }[]) => items.map((i) => i.project.id)
const porId = (...lista: SessionInfo[]) => Object.fromEntries(lista.map((s) => [s.localId, s]))

describe('quickColumnItems: quem aparece na coluna de rostinhos, e em que ordem', () => {
  it('só terminais ligados: sem sessão, parados e encerrados ficam de fora', () => {
    const projetos = [proj(1), proj(2), proj(3), proj(4)]
    const sessoes = porId(sess('a', 2, 'stopped'), sess('b', 3, 'dead'), sess('c', 4, 'starting'))
    expect(ids(quickColumnItems(projetos, sessoes))).toEqual([4])
  })

  it('quem pede ação vem antes, mesmo mexido há mais tempo', () => {
    const projetos = [proj(1), proj(2), proj(3), proj(4)]
    const sessoes = porId(
      sess('a', 1, 'idle', { lastInputAt: at(50) }),
      sess('b', 2, 'needs_attention', { lastInputAt: at(1) }),
      sess('c', 3, 'working', { lastInputAt: at(2), pendingQuestion: { toolUseId: 't', questions: [] } }),
      sess('d', 4, 'in_terminal', { lastInputAt: at(3), terminalActivity: 'waiting' }),
    )
    expect(ids(quickColumnItems(projetos, sessoes))).toEqual([4, 3, 2, 1])
  })

  it('o resto vai do que você mexeu por último ao mais antigo; nunca mexidos no fim, na ordem da lista', () => {
    const projetos = [proj(1), proj(2), proj(3), proj(4), proj(5)]
    const sessoes = porId(
      sess('a', 1, 'idle'),
      sess('b', 2, 'working', { lastInputAt: at(10) }),
      sess('c', 3, 'idle', { lastInputAt: at(30) }),
      sess('d', 4, 'starting', { lastInputAt: null }),
      sess('e', 5, 'in_terminal', { lastInputAt: at(20) }),
    )
    expect(ids(quickColumnItems(projetos, sessoes))).toEqual([3, 5, 2, 1, 4])
  })

  it('com duas engines ligadas, vale a mexida mais recente e qualquer uma esperando', () => {
    const projetos = [proj(1), proj(2)]
    const sessoes = porId(
      sess('a1', 1, 'idle', { lastInputAt: at(5) }),
      sess('a2', 1, 'in_terminal', { engine: 'codex', lastInputAt: at(40) }),
      sess('a3', 1, 'stopped', { engine: 'kimi', lastInputAt: at(59) }), // parada não conta
      sess('b1', 2, 'idle', { lastInputAt: at(30) }),
    )
    const itens = quickColumnItems(projetos, sessoes)
    expect(ids(itens)).toEqual([1, 2])
    expect(itens[0].waiting).toBe(false)

    sessoes.a1 = sess('a1', 1, 'needs_attention', { lastInputAt: at(5) })
    sessoes.b1 = sess('b1', 2, 'idle', { lastInputAt: at(50) })
    const depois = quickColumnItems(projetos, sessoes)
    expect(ids(depois)).toEqual([1, 2])
    expect(depois[0].waiting).toBe(true)
  })

  it('cada item traz a sessão principal, que decide o rosto e o que abrir', () => {
    const sessoes = porId(sess('a1', 1, 'idle'), sess('a2', 1, 'working', { engine: 'codex' }))
    expect(quickColumnItems([proj(1)], sessoes)[0].session.localId).toBe('a2')
  })
})
