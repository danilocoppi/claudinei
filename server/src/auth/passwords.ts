// Hash de senha com scrypt do node:crypto — zero dependências nativas novas
// (restrição do binário único). Formato armazenado: scrypt:<saltB64>:<hashB64>.
import { scrypt, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1 } as const
const KEYLEN = 32

export function hashPassword(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, KEYLEN, SCRYPT)
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64')
    const expected = Buffer.from(parts[2], 'base64')
    if (expected.length !== KEYLEN) return false
    return timingSafeEqual(scryptSync(plain, salt, KEYLEN, SCRYPT), expected)
  } catch {
    return false
  }
}

function scryptAsync(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, KEYLEN, SCRYPT, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

// Equivalente assíncrono de verifyPassword — usado no caminho público de
// login (POST /api/auth/login), que é alcançável sem autenticação e por
// isso é um alvo de flood de rede. A versão sync do scrypt bloqueia o event
// loop por ~30-60ms; sob flood isso congela o servidor para todos os
// usuários. Esta versão libera o loop enquanto o scrypt roda na threadpool.
export async function verifyPasswordAsync(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64')
    const expected = Buffer.from(parts[2], 'base64')
    if (expected.length !== KEYLEN) return false
    const derived = await scryptAsync(plain, salt)
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// Hash fixo, computado uma vez no load do módulo. Usado para equalizar o
// tempo de resposta do login quando o username não existe — sem isso, o
// caminho "user não encontrado" retorna ~30x mais rápido que o caminho
// "senha errada" (que roda scrypt), permitindo enumerar usernames por timing.
const DUMMY_HASH = hashPassword('claudinei-dummy-password')

export function fakeVerify(plain: string): boolean {
  return verifyPassword(plain, DUMMY_HASH)
}

export async function fakeVerifyAsync(plain: string): Promise<boolean> {
  return verifyPasswordAsync(plain, DUMMY_HASH)
}
