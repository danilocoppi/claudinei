# Comando único (empacotamento) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodar o Claudinei como um processo numa única porta (Fastify serve o SPA + API), com flags `--host/--port` (default 127.0.0.1:9105), first-run automático do Parakeet e uma guarda que impede exposição na rede sem auth.

**Architecture:** Ver spec `docs/superpowers/specs/2026-07-12-single-command-packaging-design.md`. Task 1 = config (host + port 9105 + parseCliArgs) e guarda de exposição, com wiring no index. Task 2 = servir o SPA (@fastify/static + fallback) + o `bin/claudinei.mjs` (first-run Parakeet) + portas do Vite.

**Tech Stack:** Fastify 5 + TS strict ESM (`.js` nos imports); Vitest; +`@fastify/static`.

## Global Constraints

- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD; `npm test` em `server/` + `web/`; `npx tsc --noEmit` verdes ao fim de cada task.
- Sem compat de nomes antigos; portas: **9105** app, **9100** vite-dev.
- Comentários em PT (padrão do repo).

---

### Task 1: host/port por flag+env (9105) + guarda de exposição

**Files:**
- Modify: `server/src/config.ts` (default port 9105; `host` via `CLAUDINEI_HOST`; `parseCliArgs`)
- Create: `server/src/expose-guard.ts`
- Modify: `server/src/index.ts` (aplica flags + guarda antes do listen)
- Test: `server/test/config.test.ts` (parseCliArgs + host/port), `server/test/expose-guard.test.ts` (novo)

**Interfaces:**
- Produces:
  - `parseCliArgs(argv: string[]): { host?: string; port?: number; insecure?: boolean }`
  - `Config.host` já existe; default port passa a 9105.
  - `isLoopbackHost(host: string): boolean`
  - `assertExposureAllowed(host: string, opts: { insecure: boolean; authConfigured: boolean }): void`

- [ ] **Step 1: testes falhando**

Em `server/test/config.test.ts`, adicionar ao final:
```ts
import { parseCliArgs } from '../src/config.js'

describe('parseCliArgs', () => {
  it('reconhece --host/--port/--insecure (forma espaçada)', () => {
    expect(parseCliArgs(['--host', '0.0.0.0', '--port', '9200', '--insecure']))
      .toEqual({ host: '0.0.0.0', port: 9200, insecure: true })
  })
  it('reconhece a forma --x=v', () => {
    expect(parseCliArgs(['--host=1.2.3.4', '--port=8080'])).toEqual({ host: '1.2.3.4', port: 8080 })
  })
  it('ignora argumentos desconhecidos e vazio → {}', () => {
    expect(parseCliArgs(['run', '--foo', 'bar'])).toEqual({})
    expect(parseCliArgs([])).toEqual({})
  })
  it('--port não-numérico é ignorado', () => {
    expect(parseCliArgs(['--port', 'abc'])).toEqual({})
  })
})
```
E no `describe('loadConfig', …)` trocar/garantir:
```ts
  it('default port é 9105 e host 127.0.0.1', () => {
    const c = loadConfig({})
    expect(c.port).toBe(9105)
    expect(c.host).toBe('127.0.0.1')
  })
  it('CLAUDINEI_HOST/CLAUDINEI_PORT respeitados', () => {
    const c = loadConfig({ CLAUDINEI_HOST: '0.0.0.0', CLAUDINEI_PORT: '9200' })
    expect(c.host).toBe('0.0.0.0'); expect(c.port).toBe(9200)
  })
```
(Ajuste o teste antigo que esperava 4832, se existir.)

Create `server/test/expose-guard.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isLoopbackHost, assertExposureAllowed } from '../src/expose-guard.js'

describe('isLoopbackHost', () => {
  it('reconhece loopback', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(h)).toBe(true)
  })
  it('IP de rede não é loopback', () => {
    for (const h of ['0.0.0.0', '192.168.0.10']) expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('assertExposureAllowed', () => {
  it('loopback nunca bloqueia (mesmo sem auth/insecure)', () => {
    expect(() => assertExposureAllowed('127.0.0.1', { insecure: false, authConfigured: false })).not.toThrow()
  })
  it('não-loopback sem auth e sem insecure → lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: false, authConfigured: false })).toThrow(/insecure|autentic/i)
  })
  it('não-loopback com --insecure → não lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: true, authConfigured: false })).not.toThrow()
  })
  it('não-loopback com auth configurada → não lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: false, authConfigured: true })).not.toThrow()
  })
})
```

- [ ] **Step 2: rodar (falha)** — `cd server && npm test -- config expose-guard` → FAIL.

- [ ] **Step 3: implementar**

Em `server/src/config.ts`:
1. Default port: `const port = env.CLAUDINEI_PORT ? Number(env.CLAUDINEI_PORT) : 9105`.
2. Host: no objeto retornado, `host: env.CLAUDINEI_HOST ?? '127.0.0.1'` (substitui o literal atual).
3. Adicionar:
```ts
/** Parser mínimo de flags de CLI (host/port/insecure). Puro e testável. */
export function parseCliArgs(argv: string[]): { host?: string; port?: number; insecure?: boolean } {
  const out: { host?: string; port?: number; insecure?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = (inline: string) => {
      const eq = a.indexOf('=')
      return eq >= 0 ? a.slice(eq + 1) : argv[++i]
    }
    if (a === '--insecure') out.insecure = true
    else if (a === '--host' || a.startsWith('--host=')) { const v = val('host'); if (v) out.host = v }
    else if (a === '--port' || a.startsWith('--port=')) { const n = Number(val('port')); if (Number.isInteger(n)) out.port = n }
  }
  return out
}
```

Create `server/src/expose-guard.ts`:
```ts
/** Guarda de exposição: só bloqueia quando o host é acessível pela rede e não há auth. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

export function assertExposureAllowed(
  host: string,
  opts: { insecure: boolean; authConfigured: boolean },
): void {
  if (isLoopbackHost(host) || opts.authConfigured || opts.insecure) return
  throw new Error(
    'Recusando expor na rede sem autenticação: as sessões rodam com --dangerously-skip-permissions ' +
    'e há terminal com shell real, então isso daria a qualquer um na rede controle total da sua máquina. ' +
    'A autenticação chega no próximo incremento. Para forçar mesmo assim (rede confiável, por sua conta e ' +
    'risco), suba com --insecure.',
  )
}
```

Em `server/src/index.ts` (após `migrateLegacyDataDir()` / antes ou junto do loadConfig):
```ts
import { loadConfig, migrateLegacyDataDir, parseCliArgs } from './config.js'
import { assertExposureAllowed } from './expose-guard.js'
...
const cli = parseCliArgs(process.argv.slice(2))
const config = loadConfig()
const host = cli.host ?? config.host
const port = cli.port ?? config.port
try {
  assertExposureAllowed(host, { insecure: !!cli.insecure, authConfigured: false })
} catch (err) {
  console.error(String((err as Error).message))
  process.exit(1)
}
```
E o listen passa a usar `host`/`port` (não `config.host/config.port`):
```ts
await app.listen({ port, host })
console.log(`Claudinei em http://${host}:${port}` + (cli.insecure && !isLoopbackHostImport(host) ? '  ⚠ EXPOSTO SEM AUTH' : ''))
```
(Importe `isLoopbackHost` para o aviso; ou simplifique para logar o aviso sempre que `cli.insecure`.)

- [ ] **Step 4: rodar (passa)** — `npm test` inteiro (server) + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/expose-guard.ts server/src/index.ts server/test/config.test.ts server/test/expose-guard.test.ts
git commit -m "feat(pkg): host/port por flag+env (default 9105) e guarda de exposição sem auth

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: servir o SPA + bin `claudinei` (first-run Parakeet) + portas do Vite

**Files:**
- Modify: `server/package.json` (dep `@fastify/static`)
- Create: `server/src/static.ts`
- Modify: `server/src/app.ts` (registrar static — via deps opcional `webDist`)
- Modify: `server/src/index.ts` (passar `webDist` calculado)
- Create: `bin/claudinei.mjs` (raiz)
- Modify: `package.json` (raiz: `bin`, `start`)
- Modify: `web/vite.config.ts` (porta 9100 + proxy → 9105)
- Test: `server/test/static.test.ts` (novo)

**Interfaces:**
- Consumes: `assertExposureAllowed` da Task 1 (nada direto; só coexiste).
- Produces: `registerStatic(app, webDist: string): Promise<void>`; `AppDeps.webDist?: string`.

- [ ] **Step 1: dep**

Em `server/`: `npm install @fastify/static`.

- [ ] **Step 2: teste falhando**

Create `server/test/static.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerStatic } from '../src/static.js'

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Claudinei</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  return dir
}

let app: FastifyInstance
afterEach(() => app?.close())

describe('registerStatic', () => {
  beforeEach(() => { app = Fastify() })

  it('GET / serve o index.html', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Claudinei')
  })

  it('GET de uma rota SPA (não-api) devolve index.html (fallback)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/qualquer/rota' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Claudinei')
  })

  it('GET de asset real é servido', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log')
  })

  it('/api/inexistente NÃO vira index.html (404 normal)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/api/nao-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Claudinei')
  })

  it('/ws/x também 404 (não index.html)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/ws/x' })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: rodar (falha)** e **implementar**

Create `server/src/static.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'

/**
 * Serve o SPA buildado (web/dist) na raiz, com fallback SPA: qualquer rota que
 * não seja /api/* nem /ws/* devolve index.html (o roteamento é do React).
 */
export async function registerStatic(app: FastifyInstance, webDist: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDist, wildcard: false })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}
```

Em `server/src/app.ts`: adicionar `webDist?: string` a `AppDeps` e, ANTES do `return app`:
```ts
  if (deps.webDist) await registerStatic(app, deps.webDist)
```
(import no topo; registrar por ÚLTIMO garante que as rotas /api já existem antes do notFoundHandler.)

Em `server/src/index.ts`: calcular o dist e passar:
```ts
import { existsSync } from 'node:fs'
...
const webDist = join(__dirname, '..', '..', 'web', 'dist')
const app = await buildApp({ config, db, manager, wsHub, terminalManager, speech, usage,
  webDist: existsSync(webDist) ? webDist : undefined,
  onOrchestratorReady: (d) => { drain = d } })
```
(Confirme o caminho relativo real de `web/dist` a partir de onde `index.ts` roda via tsx.)

- [ ] **Step 4: bin + scripts + vite**

Create `bin/claudinei.mjs` (raiz, executável):
```js
#!/usr/bin/env node
// Comando único: garante o web/dist e o Parakeet, então sobe o servidor.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDist = join(root, 'web', 'dist')
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('web/dist não encontrado. Rode primeiro:  npm run build -w web')
  process.exit(1)
}

// first-run do Parakeet (modelo em ~/.claudinei/speech). Falha de rede não impede subir.
const speechDir = process.env.CLAUDINEI_SPEECH ?? join(homedir(), '.claudinei', 'speech')
const model = join(speechDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'tokens.txt')
if (!existsSync(model)) {
  console.log('⬇ preparando a transcrição de voz (Parakeet, ~630MB — só desta vez)…')
  const r = spawnSync(process.execPath, [join(root, 'server', 'scripts', 'setup-speech.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) console.warn('⚠ setup de voz falhou (sem rede?). O app sobe; o 🎤 avisa se faltar o modelo.')
}

// sobe o servidor via tsx, repassando as flags (--host/--port/--insecure)
const child = spawn('npx', ['tsx', join(root, 'server', 'src', 'index.ts'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
```

Em `package.json` (raiz): adicionar
```json
  "bin": { "claudinei": "bin/claudinei.mjs" },
```
e em `scripts`: `"start": "node bin/claudinei.mjs"`.

Em `web/vite.config.ts`:
```ts
  server: {
    port: 9100,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:9105',
      '/ws': { target: 'ws://127.0.0.1:9105', ws: true },
    },
  },
```

- [ ] **Step 5: verde total** — `cd server && npm test` + `npx tsc --noEmit`; `cd web && npm test` + `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json package-lock.json server/src/static.ts server/src/app.ts server/src/index.ts bin/claudinei.mjs package.json web/vite.config.ts server/test/static.test.ts
git commit -m "feat(pkg): servir o SPA na mesma porta + bin claudinei (first-run Parakeet) + portas 9105/9100

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Smoke (controlador)
- `npm run build -w web` → `node bin/claudinei.mjs` → abrir `http://127.0.0.1:9105` (UI servida pelo backend, sem Vite).
- `node bin/claudinei.mjs --host 0.0.0.0` → recusa com a orientação.
- `node bin/claudinei.mjs --host 0.0.0.0 --insecure` → sobe com aviso; acessível por IP da LAN.
- `npm run dev` (dev) → Vite 9100 proxyando 9105, tudo normal.

## Self-Review (autor)
- Spec coberto: porta 9105 + host flag/env (T1), guarda de exposição (T1), SPA na mesma porta com fallback correto /api/ws (T2), bin com first-run Parakeet + guard de web/dist (T2), vite 9100→9105 (T2). ✔
- Placeholders: nenhum; os "confirme o caminho de web/dist" são verificações reais deixadas ao implementador (o path exato depende de como o tsx resolve __dirname). ✔
- Consistência: `parseCliArgs`/`assertExposureAllowed`/`registerStatic`/`webDist` batem entre tasks e testes. ✔
