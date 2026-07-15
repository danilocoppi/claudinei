// JWTs de usuário e de serviço (fast-jwt, HS256 com segredo local persistido).
// verify() devolve null em QUALQUER token inválido — o chamador nunca precisa
// de try/catch.
import { createSigner, createVerifier } from 'fast-jwt'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export const USER_TTL_MS = 7 * 24 * 3600 * 1000
const SERVICE_TTL_MS = 30 * 24 * 3600 * 1000

export interface TokenPayload {
  sub: string // String(userId) ou 'service'
  ver?: number // token_version do usuário na emissão (ausente no serviço)
  iat?: number // emitido em (epoch seconds) — fast-jwt inclui automaticamente
  exp?: number // expira em (epoch seconds) — fast-jwt inclui automaticamente
}

export function loadOrCreateSecret(path: string): Buffer {
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length === 32) return buf
    // Arquivo truncado/corrompido: não reusar um segredo fraco — gera outro.
    // Invalida sessões antigas, mas é preferível a um JWT secret <32 bytes.
  }
  const secret = randomBytes(32)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}

export function createTokenService(secret: Buffer) {
  const signUser = createSigner({ key: secret, expiresIn: USER_TTL_MS })
  const signService = createSigner({ key: secret, expiresIn: SERVICE_TTL_MS })
  const verifier = createVerifier({ key: secret })
  return {
    signUser: (userId: number, tokenVersion: number): string =>
      signUser({ sub: String(userId), ver: tokenVersion }),
    signService: (): string => signService({ sub: 'service' }),
    verify(token: string): TokenPayload | null {
      try {
        return verifier(token) as TokenPayload
      } catch {
        return null
      }
    },
  }
}

export type TokenService = ReturnType<typeof createTokenService>
