import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kimiHomeFor } from '../src/engine/kimi/kimi-home.js'
import { latestSessionId, sessionDirOf, readHistory, parseWire, readLastTurnTokens } from '../src/engine/kimi/kimi-history.js'

const PROJ = '/tmp/proj-hist'
const OTHER = '/tmp/proj-outro'
const envBackup = process.env.CLAUDINEI_KIMI_HOMES

let home: string
let indexLines: string[]

/** Monta um data root fake: índice + wire.jsonl da sessão. */
function seed(sessionId: string, workDir: string, wireLines: unknown[]): string {
  const dir = join(home, 'sessions', 'wd', sessionId)
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), wireLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  indexLines.push(JSON.stringify({ sessionId, sessionDir: dir, workDir }))
  writeFileSync(join(home, 'session_index.jsonl'), indexLines.join('\n') + '\n')
  return dir
}

beforeEach(() => {
  process.env.CLAUDINEI_KIMI_HOMES = mkdtempSync(join(tmpdir(), 'kimi-homes-'))
  home = kimiHomeFor(PROJ)
  indexLines = []
  mkdirSync(home, { recursive: true })
})
afterEach(() => {
  if (envBackup === undefined) delete process.env.CLAUDINEI_KIMI_HOMES
  else process.env.CLAUDINEI_KIMI_HOMES = envBackup
})

describe('índice de sessões', () => {
  it('latestSessionId devolve a última conversa DESTA pasta', () => {
    seed('session_1', PROJ, [])
    seed('session_2', OTHER, [])
    seed('session_3', PROJ, [])
    expect(latestSessionId(PROJ)).toBe('session_3')
  })

  it('sem índice (ou sem sessão da pasta) → null', () => {
    expect(latestSessionId(PROJ)).toBeNull()
    seed('session_x', OTHER, [])
    expect(latestSessionId(PROJ)).toBeNull()
  })

  it('linha corrompida no índice não derruba a leitura', () => {
    seed('session_ok', PROJ, [])
    writeFileSync(join(home, 'session_index.jsonl'), '{quebrado\n' + JSON.stringify({ sessionId: 'session_ok', sessionDir: '/d', workDir: PROJ }) + '\n')
    expect(latestSessionId(PROJ)).toBe('session_ok')
  })

  it('sessionDirOf resolve o diretório da sessão', () => {
    const dir = seed('session_9', PROJ, [])
    expect(sessionDirOf(PROJ, 'session_9')).toBe(dir)
    expect(sessionDirOf(PROJ, 'session_inexistente')).toBeNull()
  })
})

describe('readHistory (wire.jsonl)', () => {
  it('normaliza prompt do usuário, texto, thinking, tool call e resultado', async () => {
    seed('session_h', PROJ, [
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'oi kimi' }], origin: { kind: 'user' } },
      // duplicata do prompt + system-reminder: NÃO devem aparecer no chat
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'oi kimi' }] } },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>lixo</system-reminder>' }] } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'pensando' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'vou listar' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 't1', name: 'Bash', args: { command: 'ls' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't1', result: { output: 'a.txt' } } },
      { type: 'context.append_loop_event', event: { type: 'step.end', usage: { output: 10 } } },
    ])
    const events = await readHistory(PROJ, 'session_h')
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'user'])
    expect((events[0] as any).message.content[0].text).toBe('oi kimi')
    expect((events[1] as any).message.content[0]).toMatchObject({ type: 'thinking', thinking: 'pensando' })
    expect((events[3] as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect((events[4] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false })
  })

  it('tool.result com isError marca o bloco como erro', async () => {
    seed('session_e', PROJ, [
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't9', result: { output: 'falhou', isError: true } } },
    ])
    const [e] = await readHistory(PROJ, 'session_e')
    expect((e as any).message.content[0].is_error).toBe(true)
  })

  it('sessão inexistente e arquivo ausente → []', async () => {
    await expect(readHistory(PROJ, 'session_nada')).resolves.toEqual([])
    await expect(parseWire('/nao/existe/wire.jsonl')).resolves.toEqual([])
  })

  it('linha corrompida no wire é pulada sem lançar', async () => {
    const dir = seed('session_c', PROJ, [])
    writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'),
      '{lixo\n' + JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'ok' } } }) + '\n')
    const events = await readHistory(PROJ, 'session_c')
    expect(events).toHaveLength(1)
    expect((events[0] as any).message.content[0].text).toBe('ok')
  })
})

describe('tokens do turno (wire.jsonl)', () => {
  const stepEnd = (usage: unknown) => ({ type: 'context.append_loop_event', event: { type: 'step.end', usage } })

  it('soma os step.end do ÚLTIMO turno (o anterior não entra)', async () => {
    seed('session_tok', PROJ, [
      { type: 'turn.prompt', input: [{ type: 'text', text: 'turno 1' }], origin: { kind: 'user' } },
      stepEnd({ inputOther: 1000, output: 50, inputCacheRead: 20000, inputCacheCreation: 0 }),
      { type: 'turn.prompt', input: [{ type: 'text', text: 'turno 2' }], origin: { kind: 'user' } },
      stepEnd({ inputOther: 300, output: 20, inputCacheRead: 5000, inputCacheCreation: 100 }),
      stepEnd({ inputOther: 200, output: 30, inputCacheRead: 1000, inputCacheCreation: 0 }),
    ])
    const tk = await readLastTurnTokens(PROJ, 'session_tok')
    expect(tk).toEqual({
      input: 600,          // 300+100 + 200
      cachedInput: 6000,   // 5000 + 1000
      output: 50,          // 20 + 30
      reasoning: 0,
      total: 650,          // entrada + saída (cache lido fora, como no Codex)
    })
  })

  it('sem step.end (ou sessão inexistente) → undefined, não zero', async () => {
    seed('session_sem', PROJ, [{ type: 'turn.prompt', input: [], origin: { kind: 'user' } }])
    await expect(readLastTurnTokens(PROJ, 'session_sem')).resolves.toBeUndefined()
    await expect(readLastTurnTokens(PROJ, 'session_fantasma')).resolves.toBeUndefined()
  })
})
