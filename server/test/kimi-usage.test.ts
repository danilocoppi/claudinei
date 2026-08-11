import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKimiUsageService } from '../src/engine/kimi/kimi-usage.js'

// Corpo real do GET /usages (recortado): cota principal + janela de 5h.
const BODY = {
  usage: { limit: '100', used: '90', remaining: '10', resetTime: '2026-08-02T02:41:07.923941Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '1', remaining: '99', resetTime: '2026-07-31T12:41:07.923941Z' },
  }],
  parallel: { limit: '30' },
}

// Diretório sem nenhum home: mantém os testes herméticos agora que o serviço
// também varre ~/.claudinei/kimi-homes em busca de um token válido.
const VAZIO = mkdtempSync(join(tmpdir(), 'kimi-sem-homes-'))
const NOW = Date.parse('2026-07-31T12:13:00Z')
let credsPath: string

const writeCreds = (creds: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-creds-'))
  mkdirSync(join(dir, 'credentials'), { recursive: true })
  credsPath = join(dir, 'credentials', 'kimi-code.json')
  writeFileSync(credsPath, JSON.stringify(creds))
  return credsPath
}

const okFetch = (body: unknown = BODY, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

const validCreds = { access_token: 'tok', expires_at: Math.floor(NOW / 1000) + 600 }

beforeEach(() => { writeCreds(validCreds) })
afterEach(() => { delete process.env.KIMI_CODE_BASE_URL })

describe('limites de plano do Kimi', () => {
  it('normaliza a cota principal como semanal e a janela de 300min como sessão', async () => {
    const svc = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn: okFetch(), now: () => NOW })
    const limits = await svc.getLimits()

    expect(limits).toHaveLength(2)
    expect(limits[0]).toMatchObject({
      kind: 'kimi_weekly', group: 'weekly', label: null,
      percent: 90, severity: 'danger', resetsAt: '2026-08-02T02:41:07.923941Z', provider: 'kimi',
    })
    // 300 min = 5h → o mesmo grupo 'session' que o cálculo de ritmo já entende
    expect(limits[1]).toMatchObject({ kind: 'kimi_5h', group: 'session', percent: 1, severity: 'normal', provider: 'kimi' })
  })

  it('token expirado não gera requisição (a CLI é quem renova)', async () => {
    let called = 0
    const fetchFn = (async () => { called++; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    writeCreds({ access_token: 'tok', expires_at: Math.floor(NOW / 1000) - 1 })
    const svc = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn, now: () => NOW })
    await expect(svc.getLimits()).resolves.toEqual([])
    expect(called).toBe(0)
  })

  it('sem credencial, HTTP ruim ou corpo inesperado → [] (o card só perde as barras)', async () => {
    const semArquivo = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: '/nao/existe.json', fetchFn: okFetch(), now: () => NOW })
    await expect(semArquivo.getLimits()).resolves.toEqual([])

    const http401 = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn: okFetch({}, 401), now: () => NOW })
    await expect(http401.getLimits()).resolves.toEqual([])

    const lixo = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn: okFetch({ usage: { limit: '0', used: 'x' } }), now: () => NOW })
    await expect(lixo.getLimits()).resolves.toEqual([])
  })

  it('cacheia por 60s e volta a buscar depois', async () => {
    let calls = 0
    const fetchFn = (async () => { calls++; return new Response(JSON.stringify(BODY), { status: 200 }) }) as unknown as typeof fetch
    let now = NOW
    const svc = createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn, now: () => now })
    await svc.getLimits(); await svc.getLimits()
    expect(calls).toBe(1)
    now += 61_000
    await svc.getLimits()
    expect(calls).toBe(2)
  })

  it('respeita KIMI_CODE_BASE_URL (self-hosted/proxy) no endpoint', async () => {
    process.env.KIMI_CODE_BASE_URL = 'https://proxy.local/v1/'
    let urlUsada = ''
    const fetchFn = (async (url: string) => { urlUsada = String(url); return new Response(JSON.stringify(BODY), { status: 200 }) }) as unknown as typeof fetch
    await createKimiUsageService({ homesRoot: VAZIO, credentialsPath: credsPath, fetchFn, now: () => NOW }).getLimits()
    expect(urlUsada).toBe('https://proxy.local/v1/usages')
  })
})

/**
 * O token do Kimi não vive em ~/.kimi-code quando as sessões rodam pelo Claudinei:
 * cada projeto tem seu próprio home (~/.claudinei/kimi-homes/<hash>) e é lá que a
 * CLI grava as credenciais. Olhando só o home do usuário, o readFileSync falhava, o
 * catch engolia e as barras do Kimi sumiam sem explicação.
 */
describe('credenciais nos homes por projeto', () => {
  const NOW2 = Date.parse('2026-08-11T10:00:00Z')
  let root: string

  const home = (name: string, creds: object) => {
    const dir = join(root, name, 'credentials')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'kimi-code.json'), JSON.stringify(creds))
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kimi-homes-')) })

  it('acha o token nos homes por projeto e busca os limites', async () => {
    home('aaa', { access_token: 'TOK-VALIDO', expires_at: NOW2 / 1000 + 600 })
    let authUsed = ''
    const svc = createKimiUsageService({
      homesRoot: root,
      credentialsPath: join(root, 'inexistente.json'),
      now: () => NOW2,
      fetchFn: (async (_u: string, init: { headers: Record<string, string> }) => {
        authUsed = init.headers.Authorization
        return { ok: true, json: async () => BODY }
      }) as never,
    })
    const limits = await svc.getLimits()
    expect(authUsed).toBe('Bearer TOK-VALIDO')
    expect(limits.length).toBeGreaterThan(0)
  })

  it('ignora home com token vencido e usa o válido', async () => {
    home('velho', { access_token: 'TOK-VENCIDO', expires_at: NOW2 / 1000 - 3600 })
    home('novo', { access_token: 'TOK-BOM', expires_at: NOW2 / 1000 + 900 })
    let authUsed = ''
    const svc = createKimiUsageService({
      homesRoot: root,
      credentialsPath: join(root, 'inexistente.json'),
      now: () => NOW2,
      fetchFn: (async (_u: string, init: { headers: Record<string, string> }) => {
        authUsed = init.headers.Authorization
        return { ok: true, json: async () => BODY }
      }) as never,
    })
    await svc.getLimits()
    expect(authUsed).toBe('Bearer TOK-BOM')
  })

  it('todos vencidos → sem barras (não inventa dado)', async () => {
    home('a', { access_token: 'X', expires_at: NOW2 / 1000 - 10 })
    const svc = createKimiUsageService({
      homesRoot: root,
      credentialsPath: join(root, 'inexistente.json'),
      now: () => NOW2,
      fetchFn: (async () => ({ ok: true, json: async () => BODY })) as never,
    })
    expect(await svc.getLimits()).toEqual([])
  })
})
