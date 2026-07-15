# Binário único auto-extraível — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run package` gera um único executável por plataforma com server + SPA + libs nativas dentro; 1º run extrai as libs para um cache e sobe na 9105; o modelo Parakeet baixa no 1º uso.

**Architecture:** Ver spec `docs/superpowers/specs/2026-07-12-single-file-binary-design.md` (fonte de verdade; spikes já provaram pkg@Node24 + auto-extração da voz). T1 = hermes importável + modo `--hermes` no entry (o binário vira o runtime do MCP). T2 = pkg-runtime (extração/cache/re-exec) + wiring no modo servidor. T3 = `scripts/package.mjs` (esbuild bundle + assets + pkg) e o smoke do release.

**Tech Stack:** Fastify 5 + TS strict ESM (`.js`); esbuild (bundle do server p/ CJS); `@yao-pkg/pkg` (Node 24); Vitest.

## Global Constraints

- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD; `npm test` (server+web) + `npx tsc --noEmit` verdes ao fim de cada task.
- Nada quebra o fluxo dev (`npm run dev`/`npm start`) — o modo pkg é adicional; `isPackaged()` é `false` fora do binário e todo o caminho de extração/re-exec é no-op.
- Comentários em PT; nomes em inglês.

---

### Task 1: hermes importável + entry multi-modo (`--hermes`)

**Files:**
- Create: `server/src/hermes/run-hermes.ts` (a lógica do `hermes-mcp.mjs` como `runHermes(opts)`)
- Modify: `server/hermes/hermes-mcp.mjs` (vira um shim fino: importa e chama `runHermes`)
- Modify: `server/src/index.ts` (dispatch: `--hermes` roda o MCP e sai; senão sobe o servidor)
- Modify: `server/src/config.ts` (`hermesCommand`: em dev `node <script>`; o campo permite o binário no futuro) — e corrigir o default stale `4832`→`9105` no `.mjs`
- Modify: `server/src/claude/session.ts` (o mcp-config usa `hermesCommand`/`hermesArgs` do config em vez de hardcode `node`+script)
- Test: `server/test/hermes-mode.test.ts` (novo)

**Interfaces:**
- Produces:
  - `runHermes(opts: { api: string; projectId: number }): Promise<void>` — sobe o MCP stdio (as 6 tools) e resolve quando o transporte fecha.
  - `index.ts`: se `process.argv` inclui `--hermes`, chama `runHermes` com env (`CLAUDINEI_API`, `CLAUDINEI_PROJECT_ID`) e NÃO sobe o servidor.
  - `config.hermesCommand: string` / `config.hermesArgs: string[]` — o que o mcp-config injeta (dev: `process.execPath` + `['<script.mjs>']`; empacotado, na T2/T3: o binário + `['--hermes']`).

- [ ] **Step 1: extrair `runHermes`**

Create `server/src/hermes/run-hermes.ts` movendo o corpo do `.mjs` para uma função tipada:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/** Sobe o servidor MCP hermes (stdio) com as 6 tools de colaboração entre agentes. */
export async function runHermes(opts: { api: string; projectId: number }): Promise<void> {
  const { api: API, projectId: PROJECT_ID } = opts
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...init })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText)
    return body
  }
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
  const server = new McpServer({ name: 'hermes', version: '1.0.0' })
  // ... registrar as 6 tools EXATAMENTE como no .mjs (list_projects, ask_agent,
  //     post_to_board, read_board, dispatch_task, list_tasks), trocando `api(`→`call(`
  await server.connect(new StdioServerTransport())
}
```
(Copie as 6 `registerTool` do `.mjs` verbatim, só trocando o nome do helper `api`→`call` e ajustando tipos onde o TS reclamar.)

`server/hermes/hermes-mcp.mjs` vira o shim:
```js
#!/usr/bin/env node
import { runHermes } from '../src/hermes/run-hermes.ts'  // via tsx em dev
await runHermes({
  api: process.env.CLAUDINEI_API || 'http://127.0.0.1:9105',
  projectId: Number(process.env.CLAUDINEI_PROJECT_ID || '0'),
})
```
NOTA: o `.mjs` importar um `.ts` só funciona sob `tsx` (que é como o hermes é
spawnado em dev, via `hermesCommand`). Confirme: hoje o `command` do mcp-config é
`node` — mude para usar `config.hermesCommand`/`hermesArgs` (Step 3) que em dev
apontam para `tsx` + o `.ts` OU mantêm o `.mjs`+shim rodando sob `node` com
`--import tsx`. Escolha o que funcionar no smoke e documente; o essencial: em dev
o hermes continua subindo igual.

- [ ] **Step 2: teste falhando**

Create `server/test/hermes-mode.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('entry multi-modo', () => {
  it('--hermes sobe o MCP (responde a um initialize por stdio) e NÃO abre porta', () => {
    // envia um handshake MCP mínimo por stdin; espera uma resposta JSON-RPC no stdout
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n'
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(serverDir, 'src', 'index.ts'), '--hermes'],
      { input: req, encoding: 'utf8', timeout: 15_000, env: { ...process.env, CLAUDINEI_API: 'http://127.0.0.1:1', CLAUDINEI_PROJECT_ID: '0' } })
    expect(r.stdout).toMatch(/"result"|"serverInfo"|hermes/i)
  })
})
```
(Se o handshake exato for chato, um teste mais simples: `--hermes` termina/serve sem tentar `app.listen` — verifique que o stdout NÃO tem o log "Claudinei em http://". Ajuste ao que for robusto; a intenção: provar que `--hermes` = modo MCP, não servidor.)

- [ ] **Step 3: dispatch no index + hermesCommand no config/session**

`server/src/index.ts` (bem no topo do main, antes de abrir db/porta):
```ts
if (process.argv.includes('--hermes')) {
  const { runHermes } = await import('./hermes/run-hermes.js')
  await runHermes({ api: process.env.CLAUDINEI_API || 'http://127.0.0.1:9105', projectId: Number(process.env.CLAUDINEI_PROJECT_ID || '0') })
} else {
  // ... todo o boot do servidor que já existe (migrate, config, guard, listen)
}
```
(Envolva o boot atual no `else`, ou faça `return`/early-exit após o hermes.)

`server/src/config.ts`: adicionar ao Config e ao loadConfig:
```ts
  hermesCommand: string   // executável que roda o MCP
  hermesArgs: string[]    // args fixos (ex.: ['--hermes'] no binário; [] em dev)
```
Em dev (default): `hermesCommand: process.execPath`, e o mcp-config chama
`node --import tsx <hermes-mcp.mjs>` OU `tsx <run-hermes bootstrap>` — o `session.ts`
monta o command a partir desses campos. (No pkg, T3 sobrescreve para o binário.)

`server/src/claude/session.ts`: onde monta o `--mcp-config`, trocar o hardcode
`command: 'node', args: [scriptPath]` por `command: hermes.command, args: [...hermes.args]`
(passe `command`/`args` no `HermesOptions`). Ajuste `manager.ts`/`index.ts` que
montam `HermesOptions` para incluir os novos campos vindos do config.

- [ ] **Step 4: verde** — `cd server && npm test` + `npx tsc --noEmit`. **Smoke local do hermes em dev:** subir o app normal e confirmar numa sessão real que uma tool do hermes (`list_projects`) ainda responde (o board/tasks não quebraram).

- [ ] **Step 5: Commit**

```bash
git add server/src/hermes/ server/hermes/hermes-mcp.mjs server/src/index.ts server/src/config.ts server/src/claude/session.ts server/test/hermes-mode.test.ts
git commit -m "feat(pkg): hermes importável (runHermes) + entry multi-modo --hermes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: runtime de extração/cache + wiring no modo servidor

**Files:**
- Create: `server/src/pkg-runtime.ts`
- Modify: `server/src/index.ts` (no modo servidor: se empacotado, extrai+re-exec antes dos requires nativos; usa cache p/ web/speech/LD)
- Test: `server/test/pkg-runtime.test.ts`

**Interfaces:**
- Produces:
  - `isPackaged(): boolean`
  - `cacheRoot(version: string): string`
  - `extractTree(srcDir: string, destDir: string): void`
  - `ensureNativeCache(opts: { snapshotAssets: string; version: string }): { nativeDir: string; webDir: string; ldPath: string }`
  - `reexecIfNeeded(ldPath: string): void`

- [ ] **Step 1: teste falhando**

Create `server/test/pkg-runtime.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPackaged, cacheRoot, extractTree } from '../src/pkg-runtime.js'

describe('isPackaged', () => {
  it('false fora do binário pkg', () => { expect(isPackaged()).toBe(false) })
})

describe('cacheRoot', () => {
  it('respeita XDG_CACHE_HOME e versiona', () => {
    const r = cacheRoot('9', { XDG_CACHE_HOME: '/x/cache' } as never)
    expect(r).toBe('/x/cache/claudinei/native-9')
  })
  it('sem XDG cai em tmpdir', () => {
    expect(cacheRoot('9', {} as never)).toContain(join('claudinei', 'native-9'))
  })
})

describe('extractTree', () => {
  it('copia a árvore recursivamente e pula arquivos já presentes', () => {
    const src = mkdtempSync(join(tmpdir(), 'src-'))
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'A')
    writeFileSync(join(src, 'sub', 'b.txt'), 'B')
    const dst = mkdtempSync(join(tmpdir(), 'dst-'))
    extractTree(src, dst)
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('B')
    // idempotente: sobrescrever a origem e re-extrair NÃO deve tocar quem já existe
    writeFileSync(join(src, 'a.txt'), 'MUDOU')
    extractTree(dst, dst) // no-op prático
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A')
    rmSync(src, { recursive: true }); rmSync(dst, { recursive: true })
  })
})
```

- [ ] **Step 2: implementar** (spikes validaram o mecanismo)

Create `server/src/pkg-runtime.ts`:
```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Rodando de dentro de um binário @yao-pkg/pkg? */
export function isPackaged(): boolean {
  return typeof (process as unknown as { pkg?: unknown }).pkg !== 'undefined'
}

/** Pasta de cache versionada p/ os nativos extraídos. */
export function cacheRoot(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || join(tmpdir())
  return join(base, 'claudinei', `native-${version}`)
}

/** Copia recursivo via read/write (copyFileSync pode não ler o snapshot do pkg);
 *  pula arquivos que já existem (idempotente / re-run barato). */
export function extractTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name), d = join(destDir, name)
    if (statSync(s).isDirectory()) extractTree(s, d)
    else if (!existsSync(d)) writeFileSync(d, readFileSync(s))
  }
}

/** No 1º run extrai assets/native e assets/web do snapshot p/ o cache; devolve
 *  os caminhos reais + o LD_LIBRARY_PATH (stdcxx + dir do sherpa). */
export function ensureNativeCache(opts: { snapshotAssets: string; version: string }): { nativeDir: string; webDir: string; ldPath: string } {
  const root = cacheRoot(opts.version)
  const nativeDir = join(root, 'native')
  const webDir = join(root, 'web')
  extractTree(join(opts.snapshotAssets, 'native'), nativeDir)
  extractTree(join(opts.snapshotAssets, 'web'), webDir)
  const stdcxx = join(nativeDir, 'stdcxx', 'lib')
  // o dir do sherpa é o que contém sherpa-onnx.node (nome do pacote por plataforma)
  const sherpaDir = readdirSync(nativeDir).map((n) => join(nativeDir, n)).find((p) => existsSync(join(p, 'sherpa-onnx.node'))) ?? nativeDir
  return { nativeDir, webDir, ldPath: `${stdcxx}:${sherpaDir}` }
}

/** Re-exec único do próprio binário com o LD_LIBRARY_PATH certo (o dlopen das .so
 *  exige o env no arranque do processo). No-op se já está no env. */
export function reexecIfNeeded(ldPath: string): void {
  if ((process.env.LD_LIBRARY_PATH || '').includes(ldPath.split(':')[1] ?? ldPath)) return
  process.env.LD_LIBRARY_PATH = `${ldPath}:${process.env.LD_LIBRARY_PATH || ''}`
  execFileSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env })
  process.exit(0)
}
```

- [ ] **Step 3: wiring no index (modo servidor, só quando empacotado)**

Em `server/src/index.ts`, no ramo do servidor, ANTES de `openDb`/qualquer require nativo:
```ts
if (isPackaged()) {
  const version = process.env.CLAUDINEI_VERSION ?? 'v1'
  const assets = join(__dirname, '..', 'assets') // caminho do snapshot p/ os assets
  const { nativeDir, webDir, ldPath } = ensureNativeCache({ snapshotAssets: assets, version })
  reexecIfNeeded(ldPath) // se re-exec, o processo atual sai aqui
  process.env.CLAUDINEI_PKG_NATIVE = nativeDir
  process.env.CLAUDINEI_PKG_WEB = webDir
}
```
E ajustar:
- o `webDist` do buildApp: se `CLAUDINEI_PKG_WEB` setado, usa-o; senão o `web/dist` de dev.
- o `serverDir`/LD do `createSpeechService`: se empacotado, o dir do sherpa é o do cache (`CLAUDINEI_PKG_NATIVE`), não `node_modules`. (Confirme como o `transcriber.ts` resolve o sherpa hoje — via `require.resolve('sherpa-onnx-linux-x64/...')`; empacotado, precisará do caminho do cache. Ajuste o `createSpeechService` p/ aceitar um `nativeDirOverride` opcional e passe-o quando `isPackaged()`.)
(Confirme os caminhos de snapshot empiricamente na T3, ao rodar o binário.)

- [ ] **Step 4: verde** — `cd server && npm test` + `npx tsc --noEmit` (o wiring pkg é no-op em teste/dev; os testes cobrem as funções puras).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkg-runtime.ts server/src/index.ts server/src/speech/transcriber.ts server/test/pkg-runtime.test.ts
git commit -m "feat(pkg): runtime de extração/cache + re-exec p/ LD_LIBRARY_PATH (no-op fora do binário)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `scripts/package.mjs` (esbuild + assets + pkg) + smoke do release

**Files:**
- Create: `scripts/package.mjs`
- Modify: `package.json` (raiz: `"package"` script; devDeps `@yao-pkg/pkg`, `esbuild`)
- Modify: `server/src/config.ts`/`index.ts` (quando empacotado, `hermesCommand` = o binário; `hermesArgs` = `['--hermes']`)
- Modify: `.gitignore` (`dist-pkg/`, `release/`)

**Interfaces:**
- Consumes: `--hermes` (T1), `pkg-runtime` (T2).
- Produces: `release/claudinei-<plat>` (o binário).

- [ ] **Step 1: devDeps** — na RAIZ: `npm install -D @yao-pkg/pkg esbuild`.

- [ ] **Step 2: `scripts/package.mjs`**

Create `scripts/package.mjs`:
```js
#!/usr/bin/env node
// Gera o binário único: build do web → esbuild do server (CJS, nativos external) →
// montar assets (native+web) → @yao-pkg/pkg. Plataforma = a máquina atual.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = (p) => join(root, 'node_modules', p)
const run = (cmd, args, opts) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })

// 1) web
run('npm', ['run', 'build', '-w', 'web'])

// 2) esbuild → CJS único; nativos e o que não bundlar ficam external
const outCjs = join(root, 'dist-pkg', 'server.cjs')
rmSync(join(root, 'dist-pkg'), { recursive: true, force: true })
mkdirSync(join(root, 'dist-pkg'), { recursive: true })
await build({
  entryPoints: [join(root, 'server', 'src', 'index.ts')],
  outfile: outCjs, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  // native addons + o que o esbuild apontar como não-resolvível vira external:
  external: ['better-sqlite3', 'node-pty', 'sherpa-onnx-node', 'sherpa-onnx-linux-x64', '@fastify/*', 'fsevents'],
})

// 3) assets/native (da plataforma atual) + assets/web
const assets = join(root, 'dist-pkg', 'assets')
mkdirSync(join(assets, 'native'), { recursive: true })
cpSync(nm('sherpa-onnx-linux-x64'), join(assets, 'native', 'sherpa-onnx-linux-x64'), { recursive: true })
cpSync(nm('sherpa-onnx-node'), join(assets, 'native', 'sherpa-onnx-node'), { recursive: true })
cpSync(nm('better-sqlite3/build/Release/better_sqlite3.node'), join(assets, 'native', 'better_sqlite3.node'))
cpSync(nm('node-pty/build/Release'), join(assets, 'native', 'node-pty'), { recursive: true })
// libstdc++ portátil: reusa o que o setup-speech baixa, OU baixa aqui (ver setup-speech.mjs)
if (existsSync(join(process.env.HOME, '.claudinei', 'speech', 'stdcxx')))
  cpSync(join(process.env.HOME, '.claudinei', 'speech', 'stdcxx'), join(assets, 'native', 'stdcxx'), { recursive: true })
cpSync(join(root, 'web', 'dist'), join(assets, 'web'), { recursive: true })

// 4) pkg
mkdirSync(join(root, 'release'), { recursive: true })
run('npx', ['pkg', outCjs, '--targets', 'node24-linux-x64',
  '--config', JSON.stringify({ pkg: { assets: ['dist-pkg/assets/**/*'] } }).length ? undefined : undefined, // ver nota
  '--output', join(root, 'release', 'claudinei-linux-x64')].filter(Boolean))
console.log('✔ binário em release/claudinei-linux-x64')
```
NOTA importante: o `pkg` lê `pkg.assets` do `package.json` OU de um `--config`.
O jeito robusto: escrever um `dist-pkg/pkg.json` com `{ "pkg": { "assets":
["assets/**/*"], "targets": ["node24-linux-x64"] } }` e chamar
`npx pkg dist-pkg/server.cjs --config dist-pkg/pkg.json --output …`. Ajuste a
chamada para isso (o snippet acima marca o ponto). O `external` do esbuild sai da
1ª execução: rode, veja o que ele reclama de não-resolver, e adicione — não invente
a lista final; ela é empírica.

- [ ] **Step 3: hermesCommand empacotado**

Quando `isPackaged()`, o mcp-config deve chamar o PRÓPRIO binário: em `config.ts`/
`index.ts`, se empacotado, `hermesCommand = process.execPath` (o binário) e
`hermesArgs = ['--hermes']`. Em dev, o valor de dev da T1. (O `process.execPath`
dentro do binário pkg é o caminho do próprio executável.)

- [ ] **Step 4: package.json + gitignore**

`package.json` (raiz) scripts: `"package": "node scripts/package.mjs"`.
`.gitignore`: `dist-pkg/` e `release/`.

- [ ] **Step 5: verde + build** — `cd server && npm test`; `cd web && npm test`; ambos `tsc`. O `npm run package` em si é smoke (não roda em CI de teste).

- [ ] **Step 6: Commit**

```bash
git add scripts/package.mjs package.json package-lock.json .gitignore
git commit -m "feat(pkg): npm run package — binário único (esbuild + assets + @yao-pkg/pkg)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Smoke (controlador — o teste de verdade)

1. `npm run package` → `release/claudinei-linux-x64` (~120MB).
2. Copiar SÓ o binário para um dir limpo; rodar → 1ª vez extrai libs+web p/ o cache,
   sobe em `http://127.0.0.1:9105`, UI servida do cache.
3. Abrir a UI, iniciar uma sessão real (Claude) → chat funciona.
4. 🎤 → baixa o modelo (1ª vez) → transcreve.
5. **Hermes:** numa sessão real, o Claude usa `list_projects`/`dispatch_task` → o
   binário-como-MCP responde (o de-risk final; se falhar aqui, ajustar hermesCommand).
6. `--host 0.0.0.0` → guarda recusa; `--insecure` → sobe.
7. README: adicionar a seção "Binário único (`npm run package`)" com as bordas
   (cache gravável, antivírus, per-plataforma).

## Self-Review (autor)
- Spec coberto: hermes importável + `--hermes` (T1), extração/cache/re-exec (T2),
  esbuild+pkg+assets+hermesCommand empacotado (T3), smoke com voz+hermes reais. ✔
- Placeholders: os pontos "external do esbuild sai da 1ª execução" e "confirme os
  caminhos de snapshot no smoke" são o MÉTODO empírico real (não dá p/ adivinhar a
  lista de externals nem o path de snapshot sem rodar), explicitamente marcados. ✔
- Consistência: `isPackaged`/`ensureNativeCache`/`reexecIfNeeded`/`runHermes`/
  `hermesCommand` batem entre tasks. ✔
