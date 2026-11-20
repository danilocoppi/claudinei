import { describe, it, expect } from 'vitest'
import { readClaudeLine, createCodexParser, hourOf } from '../src/usage-index/readers.js'

// Linhas montadas aqui com os campos reais dos históricos; o texto é fictício.
const claudeLine = (over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-20T05:42:10.123Z',
    cwd: '/p/a',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'texto fictício' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 },
      ...msg,
    },
    ...over,
  })

const turnContext = (cwd: string, model: string, timestamp = '2026-11-20T06:00:00.000Z'): string =>
  JSON.stringify({ timestamp, type: 'turn_context', payload: { cwd, model, approval_policy: 'never' } })

const usage = (over: Record<string, number> = {}) => ({
  input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 3, total_tokens: 107, ...over,
})

const tokenCount = (last: Record<string, number>, total: Record<string, number>, timestamp = '2026-11-20T06:01:00.000Z'): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last }, rate_limits: null },
  })

describe('readClaudeLine', () => {
  it('Claude: linha assistant vira uma linha de uso com a chave id+requestId', () => {
    const hit = readClaudeLine(claudeLine())
    expect(hit).not.toBeNull()
    expect(hit!.key).toBe('msg_1:req_1')
    expect(hit!.row.engine).toBe('claude')
    expect(hit!.row.model).toBe('claude-opus-5-5')
    expect(hit!.row.cwd).toBe('/p/a')
    expect(hit!.row.input).toBe(10)
    expect(hit!.row.cacheRead).toBe(200)
    expect(hit!.row.cacheWrite).toBe(30)
    expect(hit!.row.output).toBe(5)
    expect(hit!.row.reasoning).toBe(0)
    expect(hit!.row.hour).toBe('2026-11-20T05')
  })

  it('Claude: sem requestId a chave é só o id', () => {
    const hit = readClaudeLine(claudeLine({ requestId: undefined }))
    expect(hit!.key).toBe('msg_1')
  })

  it('Claude: isApiErrorMessage e <synthetic> não contam', () => {
    expect(readClaudeLine(claudeLine({ isApiErrorMessage: true }))).toBeNull()
    expect(readClaudeLine(claudeLine({}, { model: '<synthetic>' }))).toBeNull()
  })

  it('Claude: linha user, linha malformada e JSON cortado devolvem null sem lançar', () => {
    const user = JSON.stringify({ type: 'user', timestamp: '2026-11-20T05:00:00Z', message: { role: 'user', content: 'oi' } })
    expect(readClaudeLine(user)).toBeNull()
    expect(readClaudeLine('isto não é json "type":"assistant"')).toBeNull()
    const cheia = claudeLine()
    expect(readClaudeLine(cheia.slice(0, cheia.length - 20))).toBeNull()
    expect(readClaudeLine('')).toBeNull()
    expect(readClaudeLine('{"type":"assistant"}')).toBeNull()
    expect(readClaudeLine('{"type":"assistant","message":null}')).toBeNull()
  })

  it('Claude: sem message.id, sem usage ou sem horário válido devolve null', () => {
    expect(readClaudeLine(claudeLine({}, { id: undefined }))).toBeNull()
    expect(readClaudeLine(claudeLine({}, { usage: undefined }))).toBeNull()
    expect(readClaudeLine(claudeLine({ timestamp: undefined }))).toBeNull()
    expect(readClaudeLine(claudeLine({ timestamp: 'ontem' }))).toBeNull()
  })

  it('Claude: números ausentes, negativos ou não numéricos viram 0', () => {
    const hit = readClaudeLine(claudeLine({}, { usage: { input_tokens: -4, output_tokens: 'x', cache_read_input_tokens: null } }))
    expect(hit!.row).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    for (const v of [hit!.row.input, hit!.row.output, hit!.row.cacheRead, hit!.row.cacheWrite, hit!.row.reasoning]) {
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('Claude: sem cwd a pasta é vazia', () => {
    expect(readClaudeLine(claudeLine({ cwd: undefined }))!.row.cwd).toBe('')
  })
})

describe('createCodexParser', () => {
  it('Codex: token_count usa o modelo e a pasta do último turn_context', () => {
    const p = createCodexParser(null)
    expect(p.feed(turnContext('/p/velha', 'gpt-5.4'))).toBeNull()
    expect(p.feed(turnContext('/p/codex', 'gpt-5.5'))).toBeNull()
    const row = p.feed(tokenCount(usage(), usage()))
    expect(row).not.toBeNull()
    expect(row!.engine).toBe('codex')
    expect(row!.model).toBe('gpt-5.5')
    expect(row!.cwd).toBe('/p/codex')
    expect(row!.hour).toBe('2026-11-20T06')
  })

  it('Codex: entrada sem o cache', () => {
    const p = createCodexParser(null)
    p.feed(turnContext('/p/codex', 'gpt-5.5'))
    const last = usage({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 9, output_tokens: 7, reasoning_output_tokens: 3 })
    const row = p.feed(tokenCount(last, last))
    expect(row!.input).toBe(40)
    expect(row!.cacheRead).toBe(60)
    expect(row!.cacheWrite).toBe(9)
    expect(row!.output).toBe(7)
    expect(row!.reasoning).toBe(3)
  })

  it('Codex: total acumulado repetido é ignorado', () => {
    const p = createCodexParser(null)
    p.feed(turnContext('/p/codex', 'gpt-5.5'))
    expect(p.feed(tokenCount(usage(), usage({ total_tokens: 107 })))).not.toBeNull()
    expect(p.feed(tokenCount(usage(), usage({ total_tokens: 107 }), '2026-11-20T06:02:00.000Z'))).toBeNull()
    // Total novo volta a contar.
    expect(p.feed(tokenCount(usage(), usage({ input_tokens: 200, total_tokens: 214 })))).not.toBeNull()
  })

  it('Codex: o estado sobrevive entre leituras', () => {
    const p = createCodexParser(null)
    p.feed(turnContext('/p/codex', 'gpt-5.5'))
    const total = usage({ total_tokens: 500 })
    expect(p.feed(tokenCount(usage(), total))).not.toBeNull()

    const q = createCodexParser(p.state())
    // O mesmo total, lido depois de retomar, continua repetido.
    expect(q.feed(tokenCount(usage(), total))).toBeNull()
    const row = q.feed(tokenCount(usage(), usage({ total_tokens: 900 })))
    expect(row!.model).toBe('gpt-5.5')
    expect(row!.cwd).toBe('/p/codex')
  })

  it('Codex: token_count sem turn_context antes vira modelo \'desconhecido\' e pasta \'\'', () => {
    const row = createCodexParser(null).feed(tokenCount(usage(), usage()))
    expect(row!.model).toBe('desconhecido')
    expect(row!.cwd).toBe('')
  })

  it('Codex: info nulo, sem last_token_usage ou sem horário não conta', () => {
    const p = createCodexParser(null)
    const semInfo = JSON.stringify({ timestamp: '2026-11-20T06:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })
    expect(p.feed(semInfo)).toBeNull()
    const semLast = JSON.stringify({ timestamp: '2026-11-20T06:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage() } } })
    expect(p.feed(semLast)).toBeNull()
    expect(p.feed(tokenCount(usage(), usage(), 'sem hora'))).toBeNull()
  })

  it('Codex: linha malformada no meio é pulada e o resto continua contando', () => {
    const p = createCodexParser(null)
    p.feed(turnContext('/p/codex', 'gpt-5.5'))
    expect(p.feed('{"type":"event_msg","payload":{"type":"token_count","info":{')).toBeNull()
    expect(p.feed('lixo "turn_context"')).toBeNull()
    const row = p.feed(tokenCount(usage(), usage()))
    expect(row!.model).toBe('gpt-5.5')
    expect(row!.cwd).toBe('/p/codex')
  })

  it('Codex: números inválidos viram 0 e a entrada nunca fica negativa', () => {
    const p = createCodexParser(null)
    const last = { input_tokens: 10, cached_input_tokens: 60, output_tokens: -1, reasoning_output_tokens: Number.NaN } as Record<string, number>
    const row = p.feed(tokenCount(last, usage()))
    expect(row).toMatchObject({ input: 0, cacheRead: 60, cacheWrite: 0, output: 0, reasoning: 0 })
  })

  it('Codex: estado salvo corrompido começa do zero', () => {
    const p = createCodexParser('{isto não é json')
    const row = p.feed(tokenCount(usage(), usage()))
    expect(row!.model).toBe('desconhecido')
  })

  it('Codex: linhas que não são turn_context nem token_count são ignoradas', () => {
    const p = createCodexParser(null)
    const msg = JSON.stringify({ timestamp: '2026-11-20T06:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fictício' }] } })
    expect(p.feed(msg)).toBeNull()
  })
})

describe('hourOf', () => {
  it('devolve a hora em UTC', () => {
    expect(hourOf('2026-11-20T05:42:10.123Z')).toBe('2026-11-20T05')
    expect(hourOf('2026-11-20T01:30:00-03:00')).toBe('2026-11-20T04')
  })

  it('horário inválido devolve null', () => {
    expect(hourOf('')).toBeNull()
    expect(hourOf('ontem')).toBeNull()
    expect(hourOf(undefined as unknown as string)).toBeNull()
  })
})
