import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binAvailable } from '../src/engine/available.js'

describe('binAvailable', () => {
  it('caminho absoluto executável → true; inexistente → false', () => {
    expect(binAvailable(process.execPath)).toBe(true) // o próprio node
    expect(binAvailable('/nao/existe/engine')).toBe(false)
  })
  it('nome nu é procurado no PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bins-'))
    writeFileSync(join(dir, 'minha-engine'), '#!/bin/sh\n')
    chmodSync(join(dir, 'minha-engine'), 0o755)
    expect(binAvailable('minha-engine', { PATH: dir } as NodeJS.ProcessEnv)).toBe(true)
    expect(binAvailable('outra-engine', { PATH: dir } as NodeJS.ProcessEnv)).toBe(false)
  })
  it('existente mas NÃO executável → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bins-'))
    writeFileSync(join(dir, 'quase'), 'x')
    chmodSync(join(dir, 'quase'), 0o644)
    expect(binAvailable('quase', { PATH: dir } as NodeJS.ProcessEnv)).toBe(false)
  })
  it('PATH vazio/bin vazio → false, sem lançar', () => {
    expect(binAvailable('claude', { PATH: '' } as NodeJS.ProcessEnv)).toBe(false)
    expect(binAvailable('', {} as NodeJS.ProcessEnv)).toBe(false)
  })
})
