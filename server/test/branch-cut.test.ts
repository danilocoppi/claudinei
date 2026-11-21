import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeCut, codexCut, cutFor, openCodeLastMessageId, type ExecLike } from '../src/branch/cut.js'
import { readTranscriptPage, transcriptPath } from '../src/history.js'
import { readLinesBefore } from '../src/tail.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures', 'branch')
const CLAUDE_FIX = join(FIX, 'claude-transcript.jsonl')
const CODEX_FIX = join(FIX, 'codex-rollout.jsonl')

const PROJETO = '/tmp/projeto-ramificar'
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
const CODEX_ID = '019f0000-0000-7000-8000-00000000c0de'

// Os uuid do transcript à mão, na ordem das linhas.
const U = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`
const T1 = '019f0000-0000-7000-8000-0000000000t1'
const T2 = '019f0000-0000-7000-8000-0000000000t2'

// Nunca o ~/.claude, ~/.codex nem a CLI do OpenCode reais: tudo aponta para tmp.
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDINEI_OPENCODE_BIN'] as const
let envAntes: Record<string, string | undefined>
let tmp: string

beforeEach(() => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'branch-cut-'))
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
  process.env.CODEX_HOME = join(tmp, 'codex')
  process.env.CLAUDINEI_OPENCODE_BIN = join(tmp, 'nao-existe-opencode')
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** Põe o transcript da fixture onde o Claude o guardaria, sob o CLAUDE_CONFIG_DIR temporário. */
function instalarTranscript(): string {
  const destino = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, PROJETO, CLAUDE_ID)
  mkdirSync(dirname(destino), { recursive: true })
  copyFileSync(CLAUDE_FIX, destino)
  return destino
}

/** Põe o rollout da fixture na árvore YYYY/MM/DD do CODEX_HOME temporário. */
function instalarRollout(): string {
  const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', '20')
  mkdirSync(dir, { recursive: true })
  const destino = join(dir, `rollout-2026-11-20T10-00-00-${CODEX_ID}.jsonl`)
  copyFileSync(CODEX_FIX, destino)
  return destino
}

describe('claudeCut', () => {
  it('claude ocioso: corte é o uuid da última entrada com uuid, at é o timestamp dela', async () => {
    // As linhas finais `attachment` (tem uuid, mas não é user/assistant/system),
    // `api-request`, `last-prompt` e `mode` (sem uuid) ficam de fora.
    const r = await claudeCut(CLAUDE_FIX, {})
    expect(r).not.toBeNull()
    expect(r!.cut).toBe(U(6))
    expect(r!.at).toBe('2026-11-20T10:05:11.000Z')
  })

  it('claude trabalhando: entradas com timestamp >= turnStartedAt ficam de fora', async () => {
    // O segundo turno começou às 10:05:00: a pergunta dele e tudo depois ficam de fora.
    const r = await claudeCut(CLAUDE_FIX, { turnStartedAt: Date.parse('2026-11-20T10:05:00.000Z') })
    expect(r!.cut).toBe(U(3))
    expect(r!.at).toBe('2026-11-20T10:00:06.000Z')
  })

  it('claude trabalhando no primeiro turno: null', async () => {
    const r = await claudeCut(CLAUDE_FIX, { turnStartedAt: Date.parse('2026-11-20T10:00:00.000Z') })
    expect(r).toBeNull()
  })

  it('claude sem transcript: null', async () => {
    expect(await claudeCut(join(tmp, 'sumiu.jsonl'), {})).toBeNull()
  })

  it('previewBefore inclui a linha do corte', async () => {
    instalarTranscript()
    const dir = process.env.CLAUDE_CONFIG_DIR!
    for (const turnStartedAt of [undefined, Date.parse('2026-11-20T10:05:00.000Z')]) {
      const r = await claudeCut(transcriptPath(dir, PROJETO, CLAUDE_ID), { turnStartedAt })
      const page = await readTranscriptPage(dir, PROJETO, CLAUDE_ID, { before: r!.previewBefore!, minItems: 300 })
      const ultimo = page.events.at(-1) as { raw?: { uuid?: string } }
      expect(ultimo.raw?.uuid).toBe(r!.cut)
    }
  })

  it('a janela cresce até achar a entrada', async () => {
    // ~5 MB sem uuid depois do corte: a primeira janela (4 MB) não o alcança.
    const file = join(tmp, 'longo.jsonl')
    const linha = JSON.stringify({ type: 'mode', mode: 'normal', pad: 'x'.repeat(1000) }) + '\n'
    writeFileSync(file, readFileSync(CLAUDE_FIX, 'utf8') + linha.repeat(5000))
    const r = await claudeCut(file, {})
    expect(r!.cut).toBe(U(6))
    // E o previewBefore aponta para o fim da linha do corte, não para a cauda.
    const { lines } = await readLinesBefore(file, r!.previewBefore!, 64 * 1024)
    expect(JSON.parse(lines.at(-1)!.text).uuid).toBe(U(6))
  })
})

describe('codexCut', () => {
  it('codex: turn_id do último task_complete; turno sem task_complete não conta', async () => {
    const r = await codexCut(CODEX_FIX)
    expect(r!.cut).toBe(T2)
    expect(r!.at).toBe('2026-11-20T10:05:10.000Z')
    // previewBefore inclui a linha do task_complete e nada do turno em curso.
    const { lines } = await readLinesBefore(CODEX_FIX, r!.previewBefore!, 1024 * 1024)
    expect(JSON.parse(lines.at(-1)!.text).payload.turn_id).toBe(T2)
    expect(lines.some((l) => l.text.includes('em curso'))).toBe(false)
  })

  it('codex sem nenhum task_complete: null', async () => {
    const file = join(tmp, 'rollout-sem-turno.jsonl')
    const linhas = readFileSync(CODEX_FIX, 'utf8').split('\n')
    // Só o session_meta e o primeiro turno, sem o task_complete dele.
    writeFileSync(file, linhas.slice(0, 4).join('\n') + '\n')
    expect(await codexCut(file)).toBeNull()
  })
})

describe('openCodeLastMessageId', () => {
  it('openCodeLastMessageId lê messages.at(-1).info.id do export', async () => {
    const chamadas: Array<[string, string[]]> = []
    const run: ExecLike = async (file, args) => {
      chamadas.push([file, args])
      return {
        stdout: JSON.stringify({
          info: { id: 'ses_ABC' },
          messages: [
            { info: { id: 'msg_1', role: 'user' }, parts: [] },
            { info: { id: 'msg_2', role: 'assistant' }, parts: [] },
          ],
        }),
      }
    }
    expect(await openCodeLastMessageId(PROJETO, 'ses_ABC', run)).toBe('msg_2')
    expect(chamadas).toEqual([[process.env.CLAUDINEI_OPENCODE_BIN, ['export', 'ses_ABC']]])
  })

  it('export vazio, inválido ou com erro: null', async () => {
    expect(await openCodeLastMessageId(PROJETO, 'ses_A', async () => ({ stdout: '{"messages":[]}' }))).toBeNull()
    expect(await openCodeLastMessageId(PROJETO, 'ses_A', async () => ({ stdout: 'não é json' }))).toBeNull()
    expect(await openCodeLastMessageId(PROJETO, 'ses_A', async () => { throw new Error('saiu com 1') })).toBeNull()
  })
})

describe('cutFor', () => {
  /** Um `opencode` falso: imprime um export fixo e anota cada chamada. */
  function fakeOpenCode(): string {
    const exportJson = join(tmp, 'export.json')
    writeFileSync(exportJson, JSON.stringify({
      info: { id: 'ses_ABC' },
      messages: [
        { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'oi' }] },
        { info: { id: 'msg_2', role: 'assistant' }, parts: [{ type: 'text', text: 'olá' }, { type: 'text', text: 'tudo bem?' }] },
      ],
    }))
    const log = join(tmp, 'opencode-chamadas.log')
    const bin = join(tmp, 'fake-opencode.sh')
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\ncat '${exportJson}'\n`)
    chmodSync(bin, 0o755)
    process.env.CLAUDINEI_OPENCODE_BIN = bin
    return log
  }

  it('cutFor opencode trabalhando: cut null', async () => {
    const log = fakeOpenCode()
    const r = await cutFor('opencode', PROJETO, 'ses_ABC', { working: true })
    expect(r).toEqual({ cut: null, at: null, previewBefore: null })
    // Trabalhando não há o que perguntar ao OpenCode.
    expect(existsSync(log)).toBe(false)
  })

  it('cutFor opencode ocioso: id da última mensagem e nº de eventos do histórico', async () => {
    fakeOpenCode()
    const r = await cutFor('opencode', PROJETO, 'ses_ABC', { working: false })
    expect(r).toEqual({ cut: 'msg_2', at: null, previewBefore: 3 })
  })

  it('cutFor kimi: null', async () => {
    expect(await cutFor('kimi', PROJETO, 'qualquer', { working: false })).toBeNull()
    expect(await cutFor('kimi', PROJETO, 'qualquer', { working: true })).toBeNull()
  })

  it('cutFor claude: acha o transcript e só usa o turnStartedAt quando trabalhando', async () => {
    instalarTranscript()
    const inicio = Date.parse('2026-11-20T10:05:00.000Z')
    expect((await cutFor('claude', PROJETO, CLAUDE_ID, { working: false, turnStartedAt: inicio }))!.cut).toBe(U(6))
    expect((await cutFor('claude', PROJETO, CLAUDE_ID, { working: true, turnStartedAt: inicio }))!.cut).toBe(U(3))
    expect(await cutFor('claude', PROJETO, '22222222-2222-4222-8222-222222222222', { working: false })).toBeNull()
  })

  it('cutFor codex: acha o rollout e ignora working', async () => {
    instalarRollout()
    expect((await cutFor('codex', PROJETO, CODEX_ID, { working: true, turnStartedAt: Date.now() }))!.cut).toBe(T2)
    expect((await cutFor('codex', PROJETO, CODEX_ID, { working: false }))!.cut).toBe(T2)
    expect(await cutFor('codex', PROJETO, '019f0000-0000-7000-8000-00000000dead', { working: false })).toBeNull()
  })
})
