import { describe, it, expect } from 'vitest'
import { classifyKimiLine, createKimiTurnParser, parseToolArgs } from '../src/engine/kimi/kimi-parser.js'
import type { AgentEvent } from '../src/engine/types.js'

describe('classifyKimiLine', () => {
  it('assistant com content → texto', () => {
    const [e] = classifyKimiLine('{"role":"assistant","content":"PONG"}')
    expect(e.kind).toBe('assistant')
    expect((e as any).message.content[0]).toEqual({ type: 'text', text: 'PONG' })
  })

  it('tool_calls → tool_use com arguments (string JSON) desserializado', () => {
    const [e] = classifyKimiLine('{"role":"assistant","tool_calls":[{"type":"function","id":"t1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}')
    expect((e as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
  })

  it('role tool → tool_result casado pelo tool_call_id', () => {
    const [e] = classifyKimiLine('{"role":"tool","tool_call_id":"t1","content":"alvo.txt"}')
    expect(e.kind).toBe('user')
    expect((e as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'alvo.txt', is_error: false })
  })

  it('meta session.resume_hint → init com o sessionId', () => {
    const [e] = classifyKimiLine('{"role":"meta","type":"session.resume_hint","session_id":"session_ab"}')
    expect(e).toMatchObject({ kind: 'init', sessionId: 'session_ab' })
  })

  it('linha vazia é ignorada e lixo vira parse_error (não lança)', () => {
    expect(classifyKimiLine('   ')).toEqual([])
    expect(classifyKimiLine('{nao é json')[0].kind).toBe('parse_error')
  })

  it('parseToolArgs tolera objeto, string inválida e vazio', () => {
    expect(parseToolArgs({ a: 1 })).toEqual({ a: 1 })
    expect(parseToolArgs('')).toEqual({})
    expect(parseToolArgs('nao-json')).toEqual({ raw: 'nao-json' })
  })
})

describe('createKimiTurnParser', () => {
  it('junta chunks partidos no meio da linha', () => {
    const events: AgentEvent[] = []
    const p = createKimiTurnParser((e) => events.push(e))
    p.feed('{"role":"assist')
    p.feed('ant","content":"oi"}\n')
    expect(events).toHaveLength(1)
    expect((events[0] as any).message.content[0].text).toBe('oi')
  })

  it('lastText() guarda o último texto do assistente (vira o resultText do turno)', () => {
    const p = createKimiTurnParser(() => {})
    p.feed('{"role":"assistant","content":"primeiro"}\n{"role":"assistant","content":"ultimo"}\n')
    expect(p.lastText()).toBe('ultimo')
  })
})
