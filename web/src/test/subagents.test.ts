import { describe, it, expect } from 'vitest'
import { runningSubagents } from '../subagents'
import type { ChatItem } from '../types'

const agentCall = (id: string, description: string, opts: { result?: string; name?: string; type?: string } = {}): ChatItem => ({
  kind: 'tool_call',
  id,
  name: opts.name ?? 'Agent',
  input: { description, subagent_type: opts.type ?? 'general-purpose', prompt: `prompt de ${description}` },
  ...(opts.result ? { result: opts.result } : {}),
})

const subTool = (parentId: string, name: string): ChatItem =>
  ({ kind: 'tool_call', id: `${parentId}-${name}`, name, input: {}, fromSubagent: true, parentId })

const subText = (parentId: string, text: string): ChatItem =>
  ({ kind: 'assistant_text', text, fromSubagent: true, parentId })

describe('runningSubagents', () => {
  it('lista o subagente cujo Agent ainda não tem resultado', () => {
    const out = runningSubagents([agentCall('t1', 'Mapear ALPHA')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 't1', description: 'Mapear ALPHA', type: 'general-purpose' })
    expect(out[0].prompt).toBe('prompt de Mapear ALPHA')
  })

  it('não lista o subagente que já terminou (tool_result chegou)', () => {
    expect(runningSubagents([agentCall('t1', 'x', { result: 'pronto' })])).toEqual([])
  })

  it('reconhece o nome legado Task', () => {
    const out = runningSubagents([agentCall('t1', 'y', { name: 'Task' })])
    expect(out).toHaveLength(1)
  })

  it('ignora tool_calls que não são subagente', () => {
    const bash: ChatItem = { kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'ls' } }
    expect(runningSubagents([bash])).toEqual([])
  })

  it('atribui a atividade ao subagente certo quando há dois em paralelo', () => {
    const out = runningSubagents([
      agentCall('t1', 'Primeiro'),
      agentCall('t2', 'Segundo'),
      subTool('t1', 'Read'),
      subTool('t2', 'Grep'),
      subTool('t1', 'Edit'),
    ])
    expect(out.map((s) => s.id)).toEqual(['t1', 't2'])
    expect(out[0].activity.map((a) => (a.kind === 'tool_call' ? a.name : ''))).toEqual(['Read', 'Edit'])
    expect(out[1].activity.map((a) => (a.kind === 'tool_call' ? a.name : ''))).toEqual(['Grep'])
  })

  it('inclui texto do subagente na atividade', () => {
    const out = runningSubagents([agentCall('t1', 'x'), subText('t1', 'analisando')])
    expect(out[0].activity).toHaveLength(1)
  })

  it('não confunde atividade de um subagente já concluído', () => {
    const out = runningSubagents([
      agentCall('t1', 'vivo'),
      agentCall('t2', 'morto', { result: 'ok' }),
      subTool('t2', 'Read'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].activity).toEqual([])
  })

  it('devolve lista vazia sem nenhum subagente', () => {
    expect(runningSubagents([{ kind: 'assistant_text', text: 'oi' }])).toEqual([])
  })

  it('tolera input sem description/subagent_type', () => {
    const bare: ChatItem = { kind: 'tool_call', id: 't9', name: 'Agent', input: {} }
    const out = runningSubagents([bare])
    expect(out).toHaveLength(1)
    expect(out[0].description).toBe('')
    expect(out[0].type).toBe('')
  })
})
