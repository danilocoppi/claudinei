import { describe, it, expect } from 'vitest'
import { groupActions, groupSummary } from '../chat/grouping'
import type { ChatItem } from '../types'

const tool = (name = 'Bash'): ChatItem => ({ kind: 'tool_call', id: `t${Math.random()}`, name, input: {} })
const think = (): ChatItem => ({ kind: 'thinking', text: 'hmm' })
const user = (): ChatItem => ({ kind: 'user_text', text: 'oi' })
const assistant = (): ChatItem => ({ kind: 'assistant_text', text: 'pronto' })

describe('groupActions', () => {
  it('sequência de 3+ ações seguida de outra coisa vira UM grupo', () => {
    const items = [user(), tool(), tool(), think(), assistant()]
    const nodes = groupActions(items, false)
    expect(nodes.map((n) => n.kind)).toEqual(['item', 'group', 'item'])
    const g = nodes[1] as Extract<ReturnType<typeof groupActions>[number], { kind: 'group' }>
    expect(g.items.map((x) => x.index)).toEqual([1, 2, 3])
    expect(g.start).toBe(1)
  })

  it('sequência curta (2) não agrupa', () => {
    const items = [tool(), tool(), assistant()]
    expect(groupActions(items, false).every((n) => n.kind === 'item')).toBe(true)
  })

  it('trabalhando: a ÚLTIMA ação fica fora do grupo (fácil de ver)', () => {
    const items = [user(), tool(), tool(), tool(), tool()]
    const nodes = groupActions(items, true)
    expect(nodes.map((n) => n.kind)).toEqual(['item', 'group', 'item'])
    const g = nodes[1] as Extract<ReturnType<typeof groupActions>[number], { kind: 'group' }>
    expect(g.items.map((x) => x.index)).toEqual([1, 2, 3])
    expect((nodes[2] as { index: number }).index).toBe(4)
  })

  it('turno encerrado: a cauda de ações agrupa INTEIRA', () => {
    const items = [user(), tool(), tool(), tool(), tool()]
    const nodes = groupActions(items, false)
    expect(nodes.map((n) => n.kind)).toEqual(['item', 'group'])
    const g = nodes[1] as Extract<ReturnType<typeof groupActions>[number], { kind: 'group' }>
    expect(g.items.map((x) => x.index)).toEqual([1, 2, 3, 4])
  })

  it('trabalhando com só 3 na cauda: dobrável seria 2 (< 3) — não agrupa', () => {
    const items = [tool(), tool(), tool()]
    expect(groupActions(items, true).every((n) => n.kind === 'item')).toBe(true)
  })

  it('não-ação no meio separa as sequências', () => {
    const items = [tool(), tool(), tool(), assistant(), tool(), tool(), tool(), assistant()]
    const nodes = groupActions(items, false)
    expect(nodes.map((n) => n.kind)).toEqual(['group', 'item', 'group', 'item'])
  })

  it('show_page não entra no grupo de ações; três Read seguidos ao redor continuam agrupando', () => {
    for (const name of ['mcp__hermes__show_page', 'hermes/show_page', 'hermes_show_page', 'show_page']) {
      const items = [user(), tool('Read'), tool('Read'), tool('Read'), tool(name), tool('Read'), tool('Read'), tool('Read'), assistant()]
      const nodes = groupActions(items, false)
      expect(nodes.map((n) => n.kind)).toEqual(['item', 'group', 'item', 'group', 'item'])
      expect(nodes[2]).toMatchObject({ kind: 'item', index: 4 })
      const groups = nodes.filter((n) => n.kind === 'group') as Extract<ReturnType<typeof groupActions>[number], { kind: 'group' }>[]
      expect(groups.map((g) => g.items.map((x) => x.index))).toEqual([[1, 2, 3], [5, 6, 7]])
    }
    // Nome parecido continua sendo ação comum.
    const nodes = groupActions([tool('Read'), tool('mcp__x__show_pages'), tool('Read'), assistant()], false)
    expect(nodes.map((n) => n.kind)).toEqual(['group', 'item'])
  })
})

describe('groupSummary', () => {
  it('conta por nome na ordem de aparição', () => {
    expect(groupSummary([tool('Bash'), tool('Read'), tool('Bash')])).toBe('Bash ×2 · Read')
  })
  it('thinking entra como Thinking e nomes MCP são encurtados', () => {
    expect(groupSummary([think(), tool('mcp__playwright__browser_click')])).toBe('Thinking · browser_click')
  })
  it('mais de 4 nomes distintos vira reticências', () => {
    const s = groupSummary([tool('A'), tool('B'), tool('C'), tool('D'), tool('E')])
    expect(s).toBe('A · B · C · D · …')
  })
})
