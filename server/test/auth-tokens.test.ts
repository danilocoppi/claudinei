import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTokenService, loadOrCreateSecret } from '../src/auth/tokens.js'

describe('loadOrCreateSecret', () => {
  it('cria 32 bytes com mode 0600 e reusa na segunda chamada', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'auth-')), 'jwt-secret')
    const s1 = loadOrCreateSecret(p)
    expect(s1.length).toBe(32)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(loadOrCreateSecret(p).equals(s1)).toBe(true)
    expect(readFileSync(p).equals(s1)).toBe(true)
  })

  it('substitui um segredo truncado/corrompido (≠ 32 bytes) por um novo de 32 bytes', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'auth-')), 'jwt-secret')
    writeFileSync(p, randomBytes(10), { mode: 0o600 }) // corrompido: só 10 bytes
    const s = loadOrCreateSecret(p)
    expect(s.length).toBe(32)
    expect(readFileSync(p).equals(s)).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})

describe('tokens (fast-jwt)', () => {
  const svc = createTokenService(randomBytes(32))

  it('assina e verifica token de usuário com sub/ver', () => {
    const t = svc.signUser(7, 3)
    const p = svc.verify(t)
    expect(p).toMatchObject({ sub: '7', ver: 3 })
  })

  it('assina e verifica token de serviço', () => {
    expect(svc.verify(svc.signService())).toMatchObject({ sub: 'service' })
  })

  it('rejeita token adulterado e de outro segredo (null, sem lançar)', () => {
    expect(svc.verify(svc.signUser(1, 0) + 'x')).toBeNull()
    const outro = createTokenService(randomBytes(32))
    expect(svc.verify(outro.signUser(1, 0))).toBeNull()
    expect(svc.verify('nem-é-jwt')).toBeNull()
  })
})
