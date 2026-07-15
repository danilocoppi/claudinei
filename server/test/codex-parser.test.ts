import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyCodexLine, createCodexTurnParser } from '../src/engine/codex/codex-parser.js'
import type { AgentEvent } from '../src/engine/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/codex', name), 'utf8').split('\n').filter(Boolean)

describe('classifyCodexLine', () => {
  it('thread.started → init com sessionId', () => {
    const evs = classifyCodexLine('{"type":"thread.started","thread_id":"T1"}', 'gpt-5.6-sol')
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'init', sessionId: 'T1', model: 'gpt-5.6-sol', slashCommands: [] })
  })

  it('agent_message → assistant text', () => {
    const evs = classifyCodexLine('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"PONG"}}')
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('assistant')
    const m = (evs[0] as any).message
    expect(m.content).toEqual([{ type: 'text', text: 'PONG' }])
  })

  it('command_execution → assistant tool_use + user tool_result (is_error por exit_code)', () => {
    const ok = classifyCodexLine('{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"echo hi","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}')
    expect(ok).toHaveLength(2)
    expect(ok[0].kind).toBe('assistant')
    expect((ok[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 'i1', name: 'shell', input: { command: 'echo hi' } })
    expect(ok[1].kind).toBe('user')
    expect((ok[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'i1', is_error: false })

    const bad = classifyCodexLine('{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"completed"}}')
    expect((bad[1] as any).message.content[0].is_error).toBe(true)
  })

  it('turn.completed → result', () => {
    const evs = classifyCodexLine('{"type":"turn.completed","usage":{"output_tokens":6}}')
    expect(evs[0]).toMatchObject({ kind: 'result', isError: false })
  })

  it('turn.completed com usage → result.tokens populado (total = in+out+reasoning)', () => {
    const evs = classifyCodexLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":6,"reasoning_output_tokens":2}}')
    expect(evs[0]).toMatchObject({
      kind: 'result',
      tokens: { input: 10, cachedInput: 3, output: 6, reasoning: 2, total: 18 },
    })
  })

  it('turn.completed sem usage → tokens undefined', () => {
    const evs = classifyCodexLine('{"type":"turn.completed"}')
    expect((evs[0] as any).tokens).toBeUndefined()
  })

  it('turn.failed → tokens undefined', () => {
    const evs = classifyCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')
    expect((evs[0] as any).tokens).toBeUndefined()
  })

  it('turn.failed → result erro', () => {
    const evs = classifyCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')
    expect(evs[0]).toMatchObject({ kind: 'result', isError: true })
    expect((evs[0] as any).resultText).toContain('boom')
  })

  it('item.started e linha desconhecida → nada de chat (0 eventos ou raw)', () => {
    expect(classifyCodexLine('{"type":"item.started","item":{"id":"i1","type":"command_execution"}}')).toEqual([])
    const unknown = classifyCodexLine('{"type":"something.new","x":1}')
    expect(unknown.every((e) => e.kind === 'raw')).toBe(true)
  })

  it('fixtures reais do de-risk classificam sem lançar', () => {
    for (const name of ['turn-simple.jsonl', 'turn-command.jsonl']) {
      for (const line of fixture(name)) {
        expect(() => classifyCodexLine(line)).not.toThrow()
      }
    }
    // o turno simples tem pelo menos 1 init e 1 result
    const simple = fixture('turn-simple.jsonl').flatMap((l) => classifyCodexLine(l))
    expect(simple.some((e) => e.kind === 'init')).toBe(true)
    expect(simple.some((e) => e.kind === 'result')).toBe(true)
  })
})

describe('createCodexTurnParser', () => {
  it('preenche resultText do result com o último agent_message do turno', () => {
    const events: AgentEvent[] = []
    const parser = createCodexTurnParser((e) => events.push(e))
    parser('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hello world"}}\n')
    parser('{"type":"turn.completed","usage":{"output_tokens":6}}\n')

    const result = events.find((e) => e.kind === 'result')
    expect(result).toMatchObject({ kind: 'result', isError: false, resultText: 'hello world' })
  })

  it('não sobrescreve o resultText de um turn.failed que já traz mensagem de erro', () => {
    const events: AgentEvent[] = []
    const parser = createCodexTurnParser((e) => events.push(e))
    parser('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"hello world"}}\n')
    parser('{"type":"turn.failed","error":{"message":"boom"}}\n')

    const result = events.find((e) => e.kind === 'result')
    expect(result).toMatchObject({ kind: 'result', isError: true, resultText: 'boom' })
  })

  it('fixture real turn-simple.jsonl: result carrega o texto de agent_message "PONG"', () => {
    const events: AgentEvent[] = []
    const parser = createCodexTurnParser((e) => events.push(e))
    for (const line of fixture('turn-simple.jsonl')) parser(line + '\n')

    const result = events.find((e) => e.kind === 'result')
    expect(result).toMatchObject({ kind: 'result', resultText: 'PONG' })
  })
})
