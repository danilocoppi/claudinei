import { describe, it, expect, vi } from 'vitest'
import { attachTurns, occurrenceOf } from '../undo/attachTurns'
import { turnKey, type TurnDto } from '../../../shared/undo'

// A turnKey espiada (mesmo comportamento) para contar quantas vezes o attachTurns a chama.
vi.mock('../../../shared/undo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/undo')>()
  return { ...actual, turnKey: vi.fn(actual.turnKey) }
})
import type { ChatItem } from '../types'

let nextId = 1
const turn = (key: string | null, over: Partial<TurnDto> = {}): TurnDto => ({
  id: nextId++, localId: 'L', projectId: 1, engine: 'claude', origin: key === null ? 'engine' : 'operator',
  key: key === null ? null : turnKey(key), midTurn: false, state: 'ok', limited: false, endKind: 'result',
  summary: null, lastRun: null, startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})
const user = (text: string): ChatItem => ({ kind: 'user_text', text })
const reply = (text: string): ChatItem => ({ kind: 'assistant_text', text })
const tool = (id: string): ChatItem => ({ kind: 'tool_call', id, name: 'Bash', input: { command: 'ls' } })

/** As posições como [id do turno, itemIndex, afterIndex], na ordem devolvida. */
const placed = (items: ChatItem[], turns: TurnDto[]) =>
  attachTurns(items, turns).map(p => [p.turn.id, p.itemIndex, p.afterIndex])

describe('attachTurns', () => {
  it('casa do mais novo ao mais velho com textos repetidos', () => {
    const items = [user('continue'), reply('a'), user('continue'), reply('b'), user('continue'), reply('c')]
    // Só dois turnos gravados com "continue": os dois mais recentes.
    const t1 = turn('continue')
    const t2 = turn('  continue \n')
    expect(placed(items, [t1, t2])).toEqual([[t1.id, 2, 3], [t2.id, 4, 5]])
  })

  it('linha depois do último item do bloco', () => {
    const items = [user('faça X'), reply('ok'), tool('t1'), reply('feito'), user('faça Y'), tool('t2')]
    const a = turn('faça X')
    const b = turn('faça Y')
    expect(placed(items, [a, b])).toEqual([[a.id, 0, 3], [b.id, 4, 5]])
  })

  it('a nota grudada na mensagem seguinte fecha o bloco anterior', () => {
    const items: ChatItem[] = [
      user('faça X'), reply('ok'),
      { kind: 'claudinei_message', reason: 'files_reverted', text: 'nota' }, user('faça Y'),
    ]
    const a = turn('faça X')
    const b = turn('faça Y')
    expect(placed(items, [a, b])).toEqual([[a.id, 0, 1], [b.id, 3, 3]])
  })

  it('turno engine vai depois do anterior', () => {
    const items = [user('faça X'), reply('ok'), reply('acordei sozinho'), user('faça Y'), reply('y')]
    const a = turn('faça X')
    const e = turn(null)
    const b = turn('faça Y')
    expect(placed(items, [a, e, b])).toEqual([[a.id, 0, 2], [e.id, null, 2], [b.id, 3, 4]])
  })

  it('turno não casado sem anterior casado vai para o começo', () => {
    const items = [user('faça Y'), reply('y')]
    const velho = turn('fora da página')
    const b = turn('faça Y')
    expect(placed(items, [velho, b])).toEqual([[velho.id, null, -1], [b.id, 0, 1]])
  })

  it('task_message e scheduled_message casam pela chave do corpo', () => {
    const items: ChatItem[] = [
      { kind: 'task_message', from: 'Outro', text: 'rode os testes' }, reply('ok'),
      { kind: 'scheduled_message', name: 'Diário', run: 3, text: 'resuma o dia' }, reply('feito'),
      { kind: 'claudinei_message', reason: 'goal_start', text: 'New goal: x. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.', criterion: 'x' },
    ]
    const a = turn('[Task from Outro]: rode os testes', { origin: 'task' })
    const b = turn('[Agendamento: Diário #3]: resuma o dia', { origin: 'schedule' })
    const c = turn('[Claudinei: goal start]: New goal: x. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.', { origin: 'goal' })
    expect(placed(items, [a, b, c])).toEqual([[a.id, 0, 1], [b.id, 2, 3], [c.id, 4, 4]])
  })

  it('corpo de tarefa e agendamento que começa com colchete: a chave é a do servidor com o envelope', () => {
    const items: ChatItem[] = [
      { kind: 'task_message', from: 'X', text: '[WIP] foo' }, reply('ok'),
      { kind: 'scheduled_message', name: 'Diário', run: 2, text: '[docs](http://x) leia' }, reply('lido'),
      { kind: 'claudinei_message', reason: 'task_result', text: '[nota] resultado', tasks: [] },
    ]
    const a = turn('[Task from X]: [WIP] foo', { origin: 'task' })
    const b = turn('[Agendamento: Diário #2]: [docs](http://x) leia', { origin: 'schedule' })
    const c = turn('[Claudinei: task result]: [nota] resultado', { origin: 'claudinei' })
    expect(a.key).toBe('[WIP] foo')
    expect(b.key).toBe('[docs](http://x) leia')
    expect(placed(items, [a, b, c])).toEqual([[a.id, 0, 1], [b.id, 2, 3], [c.id, 4, 4]])
    expect(occurrenceOf(items, 0).key).toBe('[WIP] foo')
    expect(occurrenceOf(items, 2).key).toBe('[docs](http://x) leia')
  })

  it('o texto digitado com colchete segue a chave do servidor (sem envelope a pôr)', () => {
    const items = [user('[WIP] foo'), reply('ok')]
    const a = turn('[WIP] foo')
    expect(a.key).toBe('foo')
    expect(placed(items, [a])).toEqual([[a.id, 0, 1]])
    expect(occurrenceOf(items, 0)).toEqual({ key: 'foo', occurrence: 0 })
  })

  it('não refaz as chaves dos itens que já viu', () => {
    const items = [user('continue'), reply('a'), user('faça Y'), tool('t'), user('continue')]
    const turns = [turn('continue'), turn('faça Y'), turn('continue')]
    const spy = vi.mocked(turnKey)
    spy.mockClear()
    const first = placed(items, turns)
    const calls = spy.mock.calls.length
    expect(calls).toBe(3)
    // Mesma lista, ou a lista com um item novo no fim: só o novo é calculado.
    expect(placed(items, turns)).toEqual(first)
    expect(spy.mock.calls.length).toBe(calls)
    placed([...items, user('mais uma')], turns)
    expect(spy.mock.calls.length).toBe(calls + 1)
    occurrenceOf(items, 0)
    expect(spy.mock.calls.length).toBe(calls + 1)
  })

  it('muitos textos repetidos: casa igual à busca do mais novo ao mais velho', () => {
    const items: ChatItem[] = []
    for (let i = 0; i < 40; i++) items.push(user(i % 3 === 0 ? 'continue' : `msg ${i % 5}`), reply(String(i)))
    const turns = items.filter((_, i) => i % 2 === 0 && i % 7 !== 0).map(it => turn((it as { text: string }).text))
    // Referência: a busca linear de antes, do mais novo ao mais velho.
    const expected: Array<number | null> = []
    let limit = items.length
    for (let k = turns.length - 1; k >= 0; k--) {
      let hit: number | null = null
      for (let i = limit - 1; i >= 0; i--) {
        if (items[i].kind === 'user_text' && turnKey((items[i] as { text: string }).text) === turns[k].key) { hit = i; limit = i; break }
      }
      expected[k] = hit
    }
    expect(attachTurns(items, turns).map(p => p.itemIndex)).toEqual(expected)
  })

  it('item sem turno não ganha linha', () => {
    const items = [user('digitado antes do Claudinei gravar turnos'), reply('a'), user('faça Y'), reply('b')]
    const b = turn('faça Y')
    expect(placed(items, [b])).toEqual([[b.id, 2, 3]])
  })

  it('mensagem de subagente ou da engine não é do operador, e interactive não vai no chat', () => {
    const items: ChatItem[] = [
      user('faça X'),
      { kind: 'user_text', text: 'faça X', fromSubagent: true, parentId: 'p' },
      { kind: 'user_text', text: 'skill', fromEngine: true },
      reply('ok'),
    ]
    const a = turn('faça X')
    const i = turn('faça X', { origin: 'interactive' })
    expect(placed(items, [a, i])).toEqual([[a.id, 0, 3]])
  })

  it('ordena os turnos pelo id mesmo se vierem fora de ordem', () => {
    const items = [user('x'), reply('1'), user('x'), reply('2')]
    const a = turn('x')
    const b = turn('x')
    expect(placed(items, [b, a])).toEqual([[a.id, 0, 1], [b.id, 2, 3]])
  })
})

describe('occurrenceOf', () => {
  it('occurrenceOf conta de trás para frente', () => {
    const items: ChatItem[] = [
      user('continue'), reply('a'),
      { kind: 'task_message', from: 'Outro', text: 'continue' }, reply('b'),
      user('outra'), user('continue'),
      { kind: 'user_text', text: 'continue', fromSubagent: true, parentId: 'p' },
    ]
    expect(occurrenceOf(items, 5)).toEqual({ key: 'continue', occurrence: 0 })
    expect(occurrenceOf(items, 2)).toEqual({ key: 'continue', occurrence: 1 })
    expect(occurrenceOf(items, 0)).toEqual({ key: 'continue', occurrence: 2 })
    expect(occurrenceOf(items, 4)).toEqual({ key: 'outra', occurrence: 0 })
  })
})
