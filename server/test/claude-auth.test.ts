import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')

const open = () => {
  const s = new ClaudeSession({
    projectPath: mkdtempSync(join(tmpdir(), 'auth-')),
    claudeBin: process.execPath,
    extraArgsOverride: [FAKE_CLAUDE],
  } as SessionOptions)
  s.start()
  return s
}

let session: ClaudeSession | undefined
afterEach(async () => { await session?.stop(); session = undefined })

/**
 * Quando o OAuth do Claude expira, a CLI passa a responder com o código
 * `auth_expired` ("Your session has expired. Please run /login…") e a sessão vira
 * uma sequência de erros sem explicação. O protocolo tem o fluxo de login por
 * control_request — o mesmo que a TUI usa —, então dá para reautenticar sem sair
 * da web.
 */
describe('reautenticação do Claude pela sessão', () => {
  it('startAuth devolve as URLs do fluxo OAuth', async () => {
    session = open()
    const r = await session.startAuth()
    expect(r.automaticUrl).toContain('oauth/authorize')
    expect(r.manualUrl).toContain('oauth/authorize')
  })

  it('completeAuth aceita o código e conclui', async () => {
    session = open()
    await session.startAuth()
    await expect(session.completeAuth('codigo-bom')).resolves.toBeUndefined()
  })

  it('código inválido falha com a mensagem da CLI', async () => {
    session = open()
    await session.startAuth()
    await expect(session.completeAuth('ruim')).rejects.toThrow(/inválido/)
  })
})

/**
 * A credencial é UMA só para todas as sessões Claude: quando expira, todas
 * quebram juntas. Sem marcar isso, o operador vê apenas uma sequência de erros
 * genéricos e descobre a causa uma sessão de cada vez.
 */
describe('detecção de sessão expirada', () => {
  const feed = (s: ClaudeSession, obj: object) =>
    (s as unknown as { handleEvent: (e: unknown) => void }).handleEvent(obj)

  const errEvent = (text: string) => ({
    kind: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    raw: { isApiErrorMessage: true },
  })

  it('marca authExpired ao ver a mensagem da CLI', () => {
    session = open()
    expect(session.authExpired).toBe(false)
    feed(session, errEvent('API Error: Your session has expired. Please run /login to sign in again.'))
    expect(session.authExpired).toBe(true)
  })

  it('erro comum de API NÃO marca expiração', () => {
    session = open()
    feed(session, errEvent('API Error: 529 Overloaded. This is a server-side issue'))
    expect(session.authExpired).toBe(false)
  })

  it('avisa os clientes quando detecta', () => {
    session = open()
    let avisou = false
    session.on('status', () => { avisou = true })
    feed(session, errEvent('API Error: Your session has expired. Please run /login to sign in again.'))
    expect(avisou).toBe(true)
  })

  it('reautenticar com sucesso limpa a marca', async () => {
    session = open()
    feed(session, errEvent('API Error: Your session has expired. Please run /login'))
    expect(session.authExpired).toBe(true)
    await session.startAuth()
    await session.completeAuth('codigo-bom')
    expect(session.authExpired).toBe(false)
  })
})
