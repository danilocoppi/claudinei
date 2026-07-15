import { describe, it, expect } from 'vitest'
import { classifyLine, createLineParser } from '../src/claude/parser.js'
import type { ClaudeEvent } from '../src/claude/events.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'stream-basico.jsonl'), 'utf8')

describe('classifyLine', () => {
  it('classifica init com sessionId', () => {
    const line = FIXTURE.split('\n')[0]
    const evt = classifyLine(line)
    expect(evt).toMatchObject({ kind: 'init', sessionId: 'b50b8b04-08a5-4bb8-ac60-a054cd7ae390' })
  })

  it('classifica result com custo e texto', () => {
    const line = FIXTURE.trim().split('\n').at(-1)!
    const evt = classifyLine(line)
    expect(evt).toMatchObject({ kind: 'result', isError: false, resultText: 'OK', costUsd: 0.0199 })
  })

  it('tipo desconhecido vira raw sem quebrar', () => {
    const evt = classifyLine('{"type":"algo_novo_da_versao_9","x":1}')
    expect(evt?.kind).toBe('raw')
  })

  it('linha inválida vira parse_error', () => {
    expect(classifyLine('isto não é json')?.kind).toBe('parse_error')
  })

  it('linha vazia retorna null', () => {
    expect(classifyLine('  ')).toBeNull()
  })

  it('fixture completa: nenhuma linha quebra e todas classificam', () => {
    const events = FIXTURE.trim().split('\n').map(classifyLine)
    expect(events.every((e) => e !== null)).toBe(true)
    expect(events.some((e) => e!.kind === 'parse_error')).toBe(false)
  })

  it('JSON válido não-objeto (null, número, string) vira raw sem lançar', () => {
    expect(classifyLine('null')?.kind).toBe('raw')
    expect(classifyLine('42')?.kind).toBe('raw')
    expect(classifyLine('"texto"')?.kind).toBe('raw')
  })

  it('fixture real capturada: nenhuma linha vira parse_error', () => {
    const realPath = join(__dirname, 'fixtures', 'stream-real.jsonl')
    if (!existsSync(realPath)) return // captura ainda não rodou nesta máquina
    const events = readFileSync(realPath, 'utf8').trim().split('\n').map(classifyLine)
    expect(events.every((e) => e !== null)).toBe(true)
    expect(events.some((e) => e!.kind === 'parse_error')).toBe(false)
  })

  it('stream_event com content_block_delta text_delta vira kind stream com o texto', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ol' } },
    })
    const evt = classifyLine(line)
    expect(evt).toMatchObject({ kind: 'stream', text: 'ol' })
  })

  it('stream_event content_block_start vira raw (ignorado)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    })
    expect(classifyLine(line)?.kind).toBe('raw')
  })

  it('stream_event content_block_stop vira raw (ignorado)', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    expect(classifyLine(line)?.kind).toBe('raw')
  })

  it('stream_event message_start vira raw (ignorado)', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } })
    expect(classifyLine(line)?.kind).toBe('raw')
  })

  it('init expõe slashCommands do raw', () => {
    const evt = classifyLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'opus', slash_commands: ['compact', 'cost', 'exit'] }))
    expect(evt).toMatchObject({ kind: 'init', sessionId: 's1', model: 'opus', slashCommands: ['compact', 'cost', 'exit'] })
  })

  it('init sem slash_commands vira lista vazia', () => {
    const evt = classifyLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2', model: 'opus' }))
    expect((evt as any).slashCommands).toEqual([])
  })
})

describe('createLineParser', () => {
  it('junta chunks parciais e divide por linha', () => {
    const got: ClaudeEvent[] = []
    const feed = createLineParser((e) => got.push(e))
    const l1 = '{"type":"result","subtype":"success","is_error":false,"result":"a","total_cost_usd":0}'
    const l2 = '{"type":"assistant","message":{"role":"assistant","content":[]}}'
    feed(l1.slice(0, 10))
    feed(l1.slice(10) + '\n' + l2 + '\n')
    expect(got.map((e) => e.kind)).toEqual(['result', 'assistant'])
  })
})
