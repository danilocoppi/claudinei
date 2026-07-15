# Visualizador de arquivos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps usam checkbox (`- [ ]`).

**Goal:** Paths de arquivos locais no chat viram clicáveis; clicar abre um modal que renderiza o conteúdo por tipo (imagem/PDF/markdown/texto/código/binário).

**Architecture:** 2 rotas backend (`resolve` + `content`) atrás da auth, com um único helper de escopo (`resolveInScope`) enforçando segurança via `realpath`. Frontend: detecção por plugin rehype no `MessageBlock` (verifica existência em lote) + `FileViewerModal`.

**Tech Stack:** Fastify, `node:fs` (realpath/stat/createReadStream), React + ReactMarkdown + rehypeHighlight, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-file-viewer-design.md`.
- **Segurança é o eixo:** leitura de arquivo exposta em servidor que pode ir à LAN. Escopo: não-admin só sob `project.path` (realpath, anti-traversal/symlink); admin qualquer arquivo. `service` token nunca chega aqui (a auth já barra fora de `/api/hermes|/api/orchestrator`). Sem `shell`. Caps de tamanho.
- `authUser`: `{kind:'user',id,username,isAdmin,projectIds}` | `{kind:'service'}` | `undefined` (auth off → tratar como admin local). `canAccessProject(user,id)` e `requireAdmin(req,reply)` em `server/src/auth/guards.js`.
- Claude/Codex/OpenCode e o resto intocados; suíte verde (server ~456|1, web ~288). TS ESM estrito (imports `.js`).
- Commits: trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `server/src/files/scope.ts` (novo) — `resolveInScope`, `kindOf`, tipos.
- `server/src/routes/files.ts` (novo) — `POST /api/files/resolve` + `GET /api/files/content`.
- `server/src/app.ts` (modificar) — `registerFileRoutes`.
- `web/src/files.ts` (novo) — `extractCandidatePaths`, client `resolveFiles`/`fileContentUrl`.
- `web/src/components/FileViewerModal.tsx` (novo).
- `web/src/components/MessageBlock.tsx` (modificar) — `rehypeFilePaths` + resolve em lote + abrir modal.
- `web/src/store.ts` (modificar) — estado do modal + cache de resolve.
- `web/src/i18n/{en,pt-BR,es}.ts` (modificar) — rótulos `fileViewer.*`.

---

### Task 1: núcleo de escopo/segurança (`scope.ts`)

**Files:** Create `server/src/files/scope.ts`; Test `server/test/files-scope.test.ts`.

**Interfaces:** Produces `type FileKind='image'|'pdf'|'markdown'|'code'|'text'|'binary'`; `interface ScopeResult { path:string; exists:boolean; inScope:boolean; kind?:FileKind; size?:number }`; `kindOf(path:string):FileKind`; `resolveInScope(raw:string, project:{id:number;path:string}|null, isAdmin:boolean):ScopeResult`.

- [ ] **Step 1: Teste que falha** — `server/test/files-scope.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveInScope, kindOf } from '../src/files/scope.js'

let root: string, proj: { id: number; path: string }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fv-'))
  proj = { id: 1, path: join(root, 'proj') }
  mkdirSync(proj.path, { recursive: true })
  writeFileSync(join(proj.path, 'a.txt'), 'hello')
  mkdirSync(join(root, 'secret'), { recursive: true })
  writeFileSync(join(root, 'secret', 'k.txt'), 'top')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('kindOf', () => {
  it('mapeia por extensão', () => {
    expect(kindOf('/x/a.png')).toBe('image'); expect(kindOf('/x/a.pdf')).toBe('pdf')
    expect(kindOf('/x/a.md')).toBe('markdown'); expect(kindOf('/x/a.ts')).toBe('code')
    expect(kindOf('/x/a.txt')).toBe('text'); expect(kindOf('/x/a.bin')).toBe('binary')
    expect(kindOf('/x/README')).toBe('text') // sem extensão → text
  })
})

describe('resolveInScope', () => {
  it('arquivo dentro do projeto (não-admin) → exists+inScope', () => {
    const r = resolveInScope(join(proj.path, 'a.txt'), proj, false)
    expect(r).toMatchObject({ exists: true, inScope: true, kind: 'text', size: 5 })
  })
  it('relativo resolve contra project.path', () => {
    expect(resolveInScope('a.txt', proj, false)).toMatchObject({ exists: true, inScope: true })
  })
  it('fora do projeto (não-admin) → inScope:false', () => {
    expect(resolveInScope(join(root, 'secret', 'k.txt'), proj, false)).toMatchObject({ exists: true, inScope: false })
  })
  it('admin → inScope mesmo fora do projeto', () => {
    expect(resolveInScope(join(root, 'secret', 'k.txt'), proj, true)).toMatchObject({ exists: true, inScope: true })
  })
  it('traversal ../.. barrado (não-admin)', () => {
    expect(resolveInScope(join(proj.path, '..', 'secret', 'k.txt'), proj, false).inScope).toBe(false)
  })
  it('symlink de dentro→fora barrado (não-admin)', () => {
    symlinkSync(join(root, 'secret', 'k.txt'), join(proj.path, 'link.txt'))
    expect(resolveInScope(join(proj.path, 'link.txt'), proj, false).inScope).toBe(false)
  })
  it('diretório → exists mas inScope:false (não é arquivo)', () => {
    expect(resolveInScope(proj.path, proj, false)).toMatchObject({ exists: true, inScope: false })
  })
  it('inexistente → exists:false', () => {
    expect(resolveInScope(join(proj.path, 'nope.txt'), proj, false)).toMatchObject({ exists: false, inScope: false })
  })
  it('relativo sem projeto → não resolve', () => {
    expect(resolveInScope('a.txt', null, false)).toMatchObject({ exists: false, inScope: false })
  })
  it('admin com absoluto e project=null → inScope', () => {
    expect(resolveInScope(join(root, 'secret', 'k.txt'), null, true)).toMatchObject({ exists: true, inScope: true })
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `cd server && npx vitest run test/files-scope.test.ts` → FAIL.
- [ ] **Step 3: Implementar `server/src/files/scope.ts`**

```typescript
import { realpathSync, statSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { homedir } from 'node:os'

export type FileKind = 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'binary'
export interface ScopeResult { path: string; exists: boolean; inScope: boolean; kind?: FileKind; size?: number }

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'])
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.c', '.h', '.cpp', '.cc', '.cs', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.sql', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.css', '.scss', '.less', '.html', '.xml', '.vue', '.svelte'])
const TEXT = new Set(['.txt', '.log', '.csv', '.tsv', '.env', '.gitignore', '.diff', '.patch', '.text'])

export function kindOf(p: string): FileKind {
  const e = extname(p).toLowerCase()
  if (IMAGE.has(e)) return 'image'
  if (e === '.pdf') return 'pdf'
  if (e === '.md' || e === '.markdown') return 'markdown'
  if (CODE.has(e)) return 'code'
  if (TEXT.has(e) || e === '') return 'text'
  return 'binary'
}

// ~ e relativo → absoluto; relativo sem projeto → null (não resolve)
function toAbsolute(raw: string, projectPath: string | null): string | null {
  let p = raw.trim()
  if (!p) return null
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1)
  if (p.startsWith('/')) return resolve(p)
  if (!projectPath) return null
  return resolve(projectPath, p)
}

/**
 * Resolve um path pedido e decide se está no ESCOPO permitido. Fonte única de verdade
 * de segurança (usada por resolve e content). Usa realpath (segue symlink) e checa que
 * o arquivo real está sob a raiz real do projeto — barra traversal e symlink pra fora.
 */
export function resolveInScope(raw: string, project: { id: number; path: string } | null, isAdmin: boolean): ScopeResult {
  const abs = toAbsolute(raw, project?.path ?? null)
  if (!abs) return { path: raw, exists: false, inScope: false }
  let realFile: string
  let st: ReturnType<typeof statSync>
  try { realFile = realpathSync(abs); st = statSync(realFile) } catch { return { path: raw, exists: false, inScope: false } }
  if (!st.isFile()) return { path: raw, exists: true, inScope: false }
  let inScope = isAdmin
  if (!inScope && project) {
    try {
      const realRoot = realpathSync(project.path)
      inScope = realFile === realRoot || realFile.startsWith(realRoot + sep)
    } catch { inScope = false }
  }
  return { path: raw, exists: true, inScope, kind: inScope ? kindOf(realFile) : undefined, size: inScope ? st.size : undefined }
}
```

- [ ] **Step 4: Passar** — `npx vitest run test/files-scope.test.ts` → PASS.
- [ ] **Step 5: Commit** (`git add server/src/files/scope.ts server/test/files-scope.test.ts`; msg `feat(files): núcleo de escopo/segurança (realpath, anti-traversal/symlink) + kind por extensão`).

---

### Task 2: rota `POST /api/files/resolve`

**Files:** Create `server/src/routes/files.ts`; Modify `server/src/app.ts`; Test `server/test/files-routes.test.ts`.

**Interfaces:** Consumes `resolveInScope` (T1), `projects` service (`get(id)`), `canAccessProject`. Produces `registerFileRoutes(app, { projects })`; `POST /api/files/resolve` body `{paths:string[], projectId?:number}` → `ScopeResult[]`.

- [ ] **Step 1: Teste que falha** — `server/test/files-routes.test.ts` (usa `buildApp`/inject como os testes de rota existentes; sem auth configurada → `authUser` undefined → admin local). Cobrir: dentro do projeto → inScope; fora → inScope:false; array vazio → []; projectId inexistente → resolve mesmo assim contra null (só absolutos). Espelhar o harness de `server/test/*routes*.test.ts` (procure um exemplo com `app.inject`).

- [ ] **Step 2: Rodar e ver falhar** — FAIL.
- [ ] **Step 3: Implementar `server/src/routes/files.ts`** (parte resolve)

```typescript
import type { FastifyInstance } from 'fastify'
import { canAccessProject } from '../auth/guards.js'
import { resolveInScope, kindOf } from '../files/scope.js'
import type { ProjectsService } from '../projects.js'

function isAdminReq(req: { authUser?: { kind?: string; isAdmin?: boolean } }): boolean {
  const u = req.authUser
  if (!u) return true // auth desativada = single-user local
  return u.kind === 'user' && !!u.isAdmin
}

// Projeto acessível pelo usuário, ou null (relativo será ignorado; absoluto só p/ admin).
function projectFor(req: any, projects: ProjectsService, projectId?: number): { id: number; path: string } | null {
  if (!projectId) return null
  if (!canAccessProject(req.authUser, projectId)) return null
  const p = projects.get(projectId)
  return p ? { id: p.id, path: p.path } : null
}

export function registerFileRoutes(app: FastifyInstance, deps: { projects: ProjectsService }): void {
  app.post('/api/files/resolve', async (req, reply) => {
    const body = req.body as { paths?: unknown; projectId?: number }
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p): p is string => typeof p === 'string').slice(0, 200) : []
    const project = projectFor(req, deps.projects, body?.projectId)
    const admin = isAdminReq(req)
    return paths.map((raw) => resolveInScope(raw, project, admin))
  })
  // content vem na Task 3
}
```

E em `server/src/app.ts`: importar + `registerFileRoutes(app, { projects })` (o `projects` service já é criado no app/index — passar o mesmo).

- [ ] **Step 4: Passar** — PASS. Rodar `npm test` (regressão).
- [ ] **Step 5: Commit** (`feat(files): POST /api/files/resolve (verifica existência + escopo em lote)`).

---

### Task 3: rota `GET /api/files/content`

**Files:** Modify `server/src/routes/files.ts`; Test amplia `server/test/files-routes.test.ts`.

**Interfaces:** `GET /api/files/content?path=…&projectId=…` → bytes com `Content-Type` por kind; 403 fora de escopo; 404 sumiu; 413 texto grande.

- [ ] **Step 1: Teste que falha** — casos: texto dentro do projeto → 200 + corpo + `content-type: text/plain`; imagem `.png` → `content-type: image/png` (stream); fora de escopo → 403; inexistente → 404; texto acima do teto → 413. (Crie arquivos no tmp; para "grande", um teto de teste via arquivo > cap — ou injete o cap; mantenha simples com um arquivo de ~alguns bytes e um cap pequeno se o cap for configurável, senão pule o 413 e teste no manual.)

- [ ] **Step 2: Rodar e ver falhar** — FAIL.
- [ ] **Step 3: Implementar** (adicionar ao `files.ts`)

```typescript
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const TEXT_CAP = 2 * 1024 * 1024 // 2 MB p/ texto/markdown/código
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
}

// dentro do registerFileRoutes:
app.get('/api/files/content', async (req, reply) => {
  const q = req.query as { path?: string; projectId?: string }
  if (!q?.path) return reply.code(400).send({ error: 'path required' })
  const projectId = q.projectId ? Number(q.projectId) : undefined
  const project = projectFor(req, deps.projects, projectId)
  const r = resolveInScope(q.path, project, isAdminReq(req))
  if (!r.exists) return reply.code(404).send({ error: 'not found' })
  if (!r.inScope) return reply.code(403).send({ error: 'forbidden' })
  const abs = require('node:fs').realpathSync(  // já validado por resolveInScope
    q.path.startsWith('~') ? q.path.replace(/^~/, require('node:os').homedir()) : q.path.startsWith('/') ? q.path : require('node:path').resolve(project!.path, q.path),
  )
  const kind = r.kind!
  const ext = require('node:path').extname(abs).toLowerCase()
  if (kind === 'image' || kind === 'pdf') {
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream')
    reply.header('Content-Disposition', `inline; filename="${basename(abs).replace(/"/g, '')}"`)
    return reply.send(createReadStream(abs))
  }
  if (kind === 'binary') {
    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${basename(abs).replace(/"/g, '')}"`)
    return reply.send(createReadStream(abs))
  }
  // text/markdown/code: lê com teto
  if ((r.size ?? 0) > TEXT_CAP) return reply.code(413).send({ error: 'file too large' })
  const buf = await readFile(abs)
  reply.header('Content-Type', 'text/plain; charset=utf-8')
  return reply.send(buf)
})
```

> **Nota ao implementador:** o `require(...)` inline acima é feio e duplica a normalização de path do `scope.ts` — REFATORE: exporte de `scope.ts` uma função `toAbsoluteChecked(raw, project, isAdmin): { abs: string; kind: FileKind } | null` (ou faça `resolveInScope` devolver também o `realpath` absoluto no resultado, ex. campo `real?: string`, só preenchido quando `inScope`). Use ESSE valor no content — nada de re-derivar o path com `require`. Ajuste o teste do T1 se adicionar o campo `real`.

- [ ] **Step 4: Passar** + `npm test` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** (`feat(files): GET /api/files/content (stream por tipo, caps, 403/404/413)`).

---

### Task 4: frontend — detecção de candidatos + client (`web/src/files.ts`)

**Files:** Create `web/src/files.ts`; Test `web/src/test/files.test.ts`.

**Interfaces:** Produces `extractCandidatePaths(text:string):string[]`; `resolveFiles(paths, projectId):Promise<ScopeResult[]>`; `fileContentUrl(path, projectId):string`.

- [ ] **Step 1: Teste que falha** — `extractCandidatePaths`: acha `/home/u/a.ts`, `~/docs/b.md`, `src/app.tsx`; ignora `https://x/y.png`, palavras comuns, e paths sem extensão claramente-não-arquivo (ex.: `/usr` sozinho — decisão: exigir extensão OU pelo menos 2 segmentos + extensão). Casos concretos no teste.

- [ ] **Step 2/3: Implementar** — regex apertado. Sugestão:
  - absoluto/`~`: `/(?:~|\/)[\w./\-+@]+\.[A-Za-z0-9]{1,8}/g` (tem extensão).
  - relativo: `/\b[\w.\-]+\/[\w./\-]+\.[A-Za-z0-9]{1,8}/g`.
  - filtrar os que começam com `http://`/`https://`/`ftp:`. Dedup. `fileContentUrl` = `\`/api/files/content?path=${encodeURIComponent(path)}${projectId?\`&projectId=${projectId}\`:''}\``.
- [ ] **Step 4: Passar** + `cd web && npx tsc --noEmit`.
- [ ] **Step 5: Commit** (`feat(files): detecção de candidatos a path + client no front`).

---

### Task 5: `FileViewerModal` + i18n + estado no store

**Files:** Create `web/src/components/FileViewerModal.tsx`; Modify `web/src/store.ts`, `web/src/i18n/*.ts`; Test `web/src/test/file-viewer-modal.test.tsx`.

**Interfaces:** Consumes `fileContentUrl`, `kind` do resolve. Produces store `fileViewer: { path, kind, projectId } | null` + `openFile(path,kind,projectId)`/`closeFile()`; `<FileViewerModal/>` montado no App.

- [ ] **Step 1: Teste que falha** — por `kind`: `image`→`<img>` com src do content; `pdf`→`<iframe>`; `markdown`→container `.markdown` (reusa ReactMarkdown) buscando o texto; `text`/`code`→`<pre>`; `binary`→texto "sem preview" + link baixar; Esc fecha (chama closeFile). Mockar `fetch` pro conteúdo texto/markdown.
- [ ] **Step 2/3: Implementar** — overlay fixo (Glass, reusa vars do tema), fetch do texto p/ text/markdown/code (com estados loading/erro: 403→"sem permissão", 404→"arquivo não encontrado", 413→"grande demais, baixe"), `<img>/<iframe>` apontando direto pro content URL p/ image/pdf. Fecha no Esc/backdrop. i18n `fileViewer.{close,download,noPreview,tooLarge,notFound,forbidden,loading}` nos 3 idiomas. Montar `<FileViewerModal/>` no `App.tsx` (renderiza quando `fileViewer` != null).
- [ ] **Step 4: Passar** + `npm test` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** (`feat(files): FileViewerModal (render por tipo) + i18n + estado no store`).

---

### Task 6: ligar no chat (`rehypeFilePaths` no MessageBlock)

**Files:** Modify `web/src/components/MessageBlock.tsx` (+ store cache de resolve); Test `web/src/test/messageblock-files.test.tsx`.

**Interfaces:** Consumes `extractCandidatePaths`/`resolveFiles`/`openFile`. Um plugin rehype quebra candidatos em `<a data-file>`; um efeito resolve em lote os candidatos da mensagem; só confirmados viram clicáveis e chamam `openFile`.

- [ ] **Step 1: Teste que falha** — render de um MessageBlock com texto contendo um path confirmado (mock do resolve → inScope:true) → vira `<a>`/clicável, clicar chama `openFile`; um path não-confirmado (inScope:false) → continua texto puro (sem `<a>` clicável). Regressão: markdown normal (links http, código) intactos.
- [ ] **Step 2/3: Implementar** — `rehypeFilePaths`: visita nós `text`, casa `extractCandidatePaths`, substitui por nós `element` `a` com `properties:{dataFile:path, className:'file-link'}`. Em `ReactMarkdown`, `components.a`: se tem `data-file` E está no cache-resolve como confirmado → `<a onClick>` que chama `openFile(path, kind, projectId)`; senão renderiza o texto puro (ou `<a>` externo se for URL normal). O efeito no MessageBlock: `useEffect` extrai candidatos do texto, chama `resolveFiles(cands, projectId)` (projectId da sessão da mensagem), guarda no cache do store (por path). Debounce/skip se já resolvido. CSS `.file-link` (sublinhado pontilhado, cursor pointer, cor accent).
- [ ] **Step 4: Passar** + `cd web && npm test && npx tsc --noEmit && npm run build`; `cd server && npm test && npx tsc --noEmit`.
- [ ] **Step 5: Commit** (`feat(files): paths do chat viram clicáveis e abrem o visualizador`).

---

## Revisão final (segurança)

Dispatch um review final com LENTE DE SEGURANÇA no `scope.ts` + `files.ts`: tentar furar o escopo (traversal, symlink, `projectId` de outro usuário, `..\\`, null bytes, path absoluto disfarçado, `%00`, race TOCTOU entre resolve e content — o content REVALIDA, confirmar), confirmar que `service` token não acessa, caps de tamanho efetivos, sem `shell`, e que admin-any está atrás de `isAdmin` de verdade. Corrigir Critical/Important antes de fechar.

## Self-Review

- Cobertura do spec: escopo projetos+admin (T1), resolve (T2), content por tipo+caps (T3), detecção (T4/T6), modal por tipo (T5), i18n (T5), relativo contra projeto ativo (T1/T4/T6). ✅
- Sem placeholders: código concreto nas tasks de segurança (T1-T3); frontend com interfaces e sugestões de regex/estrutura.
- **Dívida marcada:** o `require()` inline do T3 é explicitamente marcado pra refatorar (expor o `real` do scope). O revisor deve confirmar que sumiu.
- Tipos encadeados: `ScopeResult`/`FileKind` de scope.ts → rotas → front; `openFile`/`closeFile` store → modal/MessageBlock.
