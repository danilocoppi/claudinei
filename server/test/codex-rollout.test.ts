import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionsRoot, findRollout, parseRollout, latestThreadForCwd } from '../src/engine/codex/rollout.js'

/** Cria `<root>/YYYY/MM/DD/rollout-<stamp>-<threadId>.jsonl` com as linhas dadas (uma por objeto). */
function writeRollout(root: string, threadId: string, dateParts: [string, string, string], lines: unknown[]) {
  const [y, m, d] = dateParts
  const dir = join(root, y, m, d)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${y}-${m}-${d}T00-00-00-${threadId}.jsonl`)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

function sessionMeta(id: string, cwd: string) {
  return { type: 'session_meta', payload: { id, cwd, timestamp: '2026-01-01T00:00:00.000Z', originator: 'codex-tui' } }
}

function userMessage(text: string) {
  return { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
}

function assistantMessage(text: string) {
  return { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }
}

function reasoning(summaryText: string) {
  return { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: summaryText }], content: null } }
}

function functionCall() {
  return { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'call_1' } }
}

describe('sessionsRoot', () => {
  const originalCodexHome = process.env.CODEX_HOME

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
  })

  it('respeita CODEX_HOME quando setado', () => {
    process.env.CODEX_HOME = '/tmp/fake-codex-home'
    expect(sessionsRoot()).toBe(join('/tmp/fake-codex-home', 'sessions'))
  })

  it('cai no default ~/.codex/sessions quando CODEX_HOME não está setado', () => {
    delete process.env.CODEX_HOME
    expect(sessionsRoot().endsWith(join('.codex', 'sessions'))).toBe(true)
  })
})

describe('findRollout / parseRollout / latestThreadForCwd', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('findRollout acha o arquivo na árvore YYYY/MM/DD pelo threadId', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    const threadId = '019e5960-d46b-7ba0-9678-fcca7b2bcae1'
    const file = writeRollout(root, threadId, ['2026', '05', '24'], [sessionMeta(threadId, '/tmp/proj')])

    expect(findRollout(root, threadId)).toBe(file)
  })

  it('findRollout devolve null quando o threadId não existe', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    writeRollout(root, 'other-thread', ['2026', '05', '24'], [sessionMeta('other-thread', '/tmp/proj')])

    expect(findRollout(root, 'nao-existe')).toBeNull()
  })

  it('findRollout devolve null quando o diretório root não existe', () => {
    expect(findRollout(join(tmpdir(), 'codex-sessions-inexistente'), 'qualquer')).toBeNull()
  })

  it('parseRollout normaliza message (user/assistant) e reasoning em AgentEvent', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    const threadId = 'thread-parse'
    const file = writeRollout(root, threadId, ['2026', '01', '01'], [
      sessionMeta(threadId, '/tmp/proj'),
      userMessage('oi codex'),
      reasoning('pensando...'),
      assistantMessage('PONG'),
    ])

    const events = parseRollout(file)
    expect(events).toHaveLength(3)

    expect(events[0].kind).toBe('user')
    expect((events[0] as any).message).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'oi codex' }] })

    expect(events[1].kind).toBe('assistant')
    expect((events[1] as any).message).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', thinking: 'pensando...' }] })

    expect(events[2].kind).toBe('assistant')
    expect((events[2] as any).message).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'PONG' }] })
  })

  it('parseRollout ignora function_call e não lança em linha corrompida', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    const threadId = 'thread-garbage'
    const dir = join(root, '2026', '01', '02')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-01-02T00-00-00-${threadId}.jsonl`)
    const raw = [
      JSON.stringify(sessionMeta(threadId, '/tmp/proj')),
      JSON.stringify(functionCall()),
      '{isso nao e json valido',
      JSON.stringify(assistantMessage('depois do lixo')),
    ].join('\n') + '\n'
    writeFileSync(file, raw)

    expect(() => parseRollout(file)).not.toThrow()
    const events = parseRollout(file)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('assistant')
    expect((events[0] as any).message.content[0]).toMatchObject({ type: 'text', text: 'depois do lixo' })
  })

  it('parseRollout devolve [] quando o arquivo não existe', () => {
    expect(parseRollout(join(tmpdir(), 'nao-existe-de-jeito-nenhum.jsonl'))).toEqual([])
  })

  it('latestThreadForCwd devolve o thread_id do rollout cujo cwd bate', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    writeRollout(root, 'thread-a', ['2026', '01', '01'], [sessionMeta('thread-a', '/tmp/alfa')])
    writeRollout(root, 'thread-b', ['2026', '01', '02'], [sessionMeta('thread-b', '/tmp/beta')])

    expect(latestThreadForCwd(root, '/tmp/beta')).toBe('thread-b')
    expect(latestThreadForCwd(root, '/tmp/alfa')).toBe('thread-a')
  })

  it('latestThreadForCwd devolve null quando nenhum cwd bate ou o dir não existe', () => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
    writeRollout(root, 'thread-a', ['2026', '01', '01'], [sessionMeta('thread-a', '/tmp/alfa')])

    expect(latestThreadForCwd(root, '/tmp/gama')).toBeNull()
    expect(latestThreadForCwd(join(tmpdir(), 'codex-sessions-inexistente'), '/tmp/alfa')).toBeNull()
  })
})
