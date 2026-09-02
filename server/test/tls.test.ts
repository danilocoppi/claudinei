import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTlsOptions } from '../src/tls.js'
import { parseCliArgs } from '../src/config.js'

/**
 * HTTPS é OPCIONAL: quem roda em localhost não deveria ser obrigado a lidar com
 * certificado. Ligar é dar os dois arquivos — por env (prático no systemd) ou por
 * flag. Sem eles, o servidor sobe em HTTP como sempre.
 */
let dir: string
let cert: string
let key: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-'))
  cert = join(dir, 'cert.pem')
  key = join(dir, 'key.pem')
  // Certificado real (auto-assinado): o teste de integração precisa que o Node
  // aceite de verdade, não que "pareça" um PEM.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' })
})

describe('carregar os certificados', () => {
  it('sem nada configurado: HTTP, como sempre foi', () => {
    expect(loadTlsOptions({})).toBeNull()
  })

  it('com os dois arquivos: devolve o material para o Fastify', () => {
    const opts = loadTlsOptions({ cert, key })
    expect(opts).not.toBeNull()
    expect(opts!.cert.length).toBeGreaterThan(0)
    expect(opts!.key.length).toBeGreaterThan(0)
  })

  /**
   * Meio-configurado é engano, não intenção: subir em HTTP calado deixaria alguém
   * achando que expôs com TLS quando não expôs.
   */
  it('só um dos dois é erro, e diz qual falta', () => {
    expect(() => loadTlsOptions({ cert })).toThrow(/key/i)
    expect(() => loadTlsOptions({ key })).toThrow(/cert/i)
  })

  it('arquivo que não existe é erro com o caminho no texto', () => {
    expect(() => loadTlsOptions({ cert: '/nao/existe.pem', key }))
      .toThrow(/\/nao\/existe\.pem/)
  })

  /** Arquivo ilegível (permissão, diretório) também não pode virar HTTP calado. */
  it('arquivo inválido não degrada para HTTP', () => {
    expect(() => loadTlsOptions({ cert: dir, key })).toThrow()
  })
})

describe('as flags de linha de comando', () => {
  it('--tls-cert e --tls-key, com e sem =', () => {
    expect(parseCliArgs(['--tls-cert', '/c.pem', '--tls-key', '/k.pem']))
      .toMatchObject({ tlsCert: '/c.pem', tlsKey: '/k.pem' })
    expect(parseCliArgs(['--tls-cert=/c.pem', '--tls-key=/k.pem']))
      .toMatchObject({ tlsCert: '/c.pem', tlsKey: '/k.pem' })
  })

  it('sem as flags, nada de TLS', () => {
    expect(parseCliArgs(['--port', '9105']).tlsCert).toBeUndefined()
  })
})

/**
 * O servidor sobe mesmo em HTTPS e responde — com o certificado de verdade
 * gerado acima. Sem isto, o teste provaria só que sabemos ler dois arquivos.
 */
describe('o servidor em HTTPS', () => {
  it('atende uma requisição TLS de ponta a ponta', async () => {
    const { buildApp } = await import('../src/app.js')
    const { openDb } = await import('../src/db.js')
    const { loadConfig } = await import('../src/config.js')
    const { createSessionManager } = await import('../src/claude/manager.js')
    const db = openDb(':memory:')
    const app = await buildApp({
      config: loadConfig({}), db,
      manager: createSessionManager({ db, broadcast: () => {} }),
      https: loadTlsOptions({ cert, key })!,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }

    const https = await import('node:https')
    const { readFileSync } = await import('node:fs')
    const corpo = await new Promise<string>((resolve, reject) => {
      // O próprio certificado auto-assinado entra como CA confiável, em vez de
      // `rejectUnauthorized: false`: assim o teste VERIFICA a cadeia de verdade
      // (é o que prova que o handshake está correto) em vez de ignorá-la.
      // `servername` porque o CN é localhost e a conexão vai por IP.
      https.get({
        host: '127.0.0.1', port, path: '/api/health',
        ca: readFileSync(cert), servername: 'localhost',
      }, (res) => {
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => resolve(d))
      }).on('error', reject)
    })
    expect(JSON.parse(corpo)).toEqual({ ok: true })
    await app.close()
  })
})
