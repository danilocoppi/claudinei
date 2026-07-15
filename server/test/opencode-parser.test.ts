import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyOpenCodeLine, createOpenCodeTurnParser } from '../src/engine/opencode/opencode-parser.js'
import type { AgentEvent } from '../src/engine/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures/opencode', n), 'utf8').split('\n').filter(Boolean)

describe('classifyOpenCodeLine', () => {
  it('text → assistant text', () => {
    const evs = classifyOpenCodeLine('{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"PONG"}}')
    expect(evs[0].kind).toBe('assistant')
    expect((evs[0] as any).message.content).toEqual([{ type: 'text', text: 'PONG' }])
  })
  it('tool_use → assistant tool_use + user tool_result (is_error por exit)', () => {
    const ok = classifyOpenCodeLine('{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi","metadata":{"exit":0}}}}')
    expect(ok).toHaveLength(2)
    expect((ok[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'echo hi' } })
    expect((ok[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: false })
    const bad = classifyOpenCodeLine('{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"c2","state":{"status":"error","input":{},"output":"boom","metadata":{"exit":1}}}}')
    expect((bad[1] as any).message.content[0].is_error).toBe(true)
  })
  it('step_start/step_finish → sem eventos de chat', () => {
    expect(classifyOpenCodeLine('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}')).toEqual([])
    expect(classifyOpenCodeLine('{"type":"step_finish","sessionID":"ses_1","tokens":{"total":8,"input":5,"output":3,"reasoning":0}}')).toEqual([])
  })
  it('JSON inválido → parse_error', () => {
    expect(classifyOpenCodeLine('{nope')[0].kind).toBe('parse_error')
  })
})

describe('createOpenCodeTurnParser', () => {
  it('emite init no 1º sessionID; finish() traz resultText do último text + tokens', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e), 'opencode/deepseek-v4-flash-free')
    for (const line of fixture('turn-simple.jsonl')) p.feed(line + '\n')
    const init = events.find((e) => e.kind === 'init') as any
    expect(init).toBeTruthy()
    expect(init.sessionId).toMatch(/^ses_/)
    const result = p.finish() as any
    expect(result.kind).toBe('result')
    expect(result.resultText).toBe('PONG')
    expect(result.tokens).toMatchObject({ total: 8048 })
  })
  it('fixture com tool classifica sem lançar e o result não é erro', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e))
    for (const line of fixture('turn-tool.jsonl')) p.feed(line + '\n')
    expect(events.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('tool_use'))).toBe(true)
    expect((p.finish() as any).isError).toBe(false)
  })
  it('evento error faz finish() retornar isError:true com mensagem do erro', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e))
    for (const line of fixture('turn-error.jsonl')) p.feed(line + '\n')
    const result = p.finish() as any
    expect(result.kind).toBe('result')
    expect(result.isError).toBe(true)
    expect(result.resultText).toBe('No payment method on file')
  })
  it('buffering NDJSON partido entre chunks: junta pedaços e emite evento único', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e))
    // Quebra uma linha JSON em dois chunks
    p.feed('{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"AB')
    p.feed('C"}}\n')
    // Emite step_finish para completar o turno
    p.feed('{"type":"step_finish","sessionID":"ses_1","tokens":{"total":10}}\n')
    const textEvents = events.filter((e) => e.kind === 'assistant')
    // Deve ter emitido um único evento de texto com "ABC"
    expect(textEvents).toHaveLength(1)
    expect((textEvents[0] as any).message.content[0].text).toBe('ABC')
    const result = p.finish() as any
    expect(result.resultText).toBe('ABC')
  })
})
