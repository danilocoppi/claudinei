import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, verifyPasswordAsync } from '../src/auth/passwords.js'

describe('passwords (scrypt)', () => {
  it('hash e verify fecham o ciclo', () => {
    const stored = hashPassword('s3nha!')
    expect(stored.startsWith('scrypt:')).toBe(true)
    expect(verifyPassword('s3nha!', stored)).toBe(true)
    expect(verifyPassword('errada', stored)).toBe(false)
  })

  it('salts aleatórios: mesmo plaintext gera hashes diferentes', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  it('formato inválido nunca verifica (nem lança)', () => {
    expect(verifyPassword('x', 'lixo')).toBe(false)
    expect(verifyPassword('x', 'scrypt:aa')).toBe(false)
    expect(verifyPassword('x', 'bcrypt:aaaa:bbbb')).toBe(false)
    expect(verifyPassword('x', 'scrypt:!!!:???')).toBe(false)
  })
})

describe('passwords (scrypt) — async (caminho de login, não bloqueia o event loop)', () => {
  it('hash sync + verifyAsync fecham o ciclo', async () => {
    const stored = hashPassword('s3nha!')
    await expect(verifyPasswordAsync('s3nha!', stored)).resolves.toBe(true)
  })

  it('senha errada resolve false', async () => {
    const stored = hashPassword('s3nha!')
    await expect(verifyPasswordAsync('errada', stored)).resolves.toBe(false)
  })

  it('formato inválido resolve false, sem rejeitar', async () => {
    await expect(verifyPasswordAsync('x', 'lixo')).resolves.toBe(false)
    await expect(verifyPasswordAsync('x', 'scrypt:aa')).resolves.toBe(false)
    await expect(verifyPasswordAsync('x', 'bcrypt:aaaa:bbbb')).resolves.toBe(false)
    await expect(verifyPasswordAsync('x', 'scrypt:!!!:???')).resolves.toBe(false)
  })
})
