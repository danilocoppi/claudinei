import { describe, it, expect } from 'vitest'
import { encodeCwd, transcriptPath, readTranscript, latestTranscriptId } from '../src/history.js'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('encodeCwd', () => {
  it('replica o formato do Claude Code', () => {
    expect(encodeCwd('/home/coppi/Projects/Termaster')).toBe('-home-coppi-Projects-Termaster')
    expect(encodeCwd('/tmp/a_b.c')).toBe('-tmp-a-b-c')
  })
})

describe('readTranscript', () => {
  it('lê e classifica linhas do JSONL, ignorando lixo', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    const projPath = '/tmp/meu-proj'
    const dir = join(cfgDir, 'projects', encodeCwd(projPath))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sid-1.jsonl'), [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"oi"}]}}',
      'linha corrompida não-json',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"olá!"}]}}',
      '',
    ].join('\n'))
    const events = readTranscript(cfgDir, projPath, 'sid-1')
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant'])
  })

  it('arquivo inexistente retorna []', () => {
    expect(readTranscript('/nao/existe', '/x', 'sid')).toEqual([])
  })
})

describe('latestTranscriptId', () => {
  it('retorna o id do transcript mais recente (por mtime), ignorando não-jsonl', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    const projPath = '/tmp/meu-proj'
    const dir = join(cfgDir, 'projects', encodeCwd(projPath))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'antigo.jsonl'), '{}')
    writeFileSync(join(dir, 'recente.jsonl'), '{}')
    writeFileSync(join(dir, 'nota.txt'), 'não sou transcript')
    // mtimes determinísticos: antigo < recente
    utimesSync(join(dir, 'antigo.jsonl'), new Date(1000000), new Date(1000000))
    utimesSync(join(dir, 'recente.jsonl'), new Date(2000000), new Date(2000000))
    expect(latestTranscriptId(cfgDir, projPath)).toBe('recente')
  })

  it('pasta sem transcripts (ou inexistente) retorna null', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    expect(latestTranscriptId(cfgDir, '/tmp/sem-nada')).toBeNull()
    expect(latestTranscriptId('/nao/existe', '/x')).toBeNull()
  })
})
