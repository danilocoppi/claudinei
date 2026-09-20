# Editar documentos no visualizador — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um lápis no visualizador de arquivos que permite editar e salvar documentos textuais — markdown com o visual formatado preservado enquanto se digita, código e texto num editor com realce.

**Architecture:** O servidor ganha uma rota de escrita (`POST /api/files/write`) restrita à pasta do projeto, com gravação atômica e detecção de alteração concorrente por hash. O front ganha um componente `TextDocument` que alterna entre o render de hoje e um editor CodeMirror 6; o live preview do markdown é um plugin nosso, cujo miolo é uma função pura testável sem montar o editor.

**Tech Stack:** Fastify + Node fs (servidor); React 18 + Zustand + CodeMirror 6 (front); Vitest nos dois lados.

**Spec:** `docs/superpowers/specs/2026-09-20-editar-documentos-no-visualizador-design.md`

## Global Constraints

- **Toda a comunicação, comentários e mensagens de commit em português, com acentuação correta.** O código (identificadores) segue o padrão do arquivo em que vive.
- **TDD obrigatório:** escrever o teste, **rodar e ver falhar**, só então implementar. Um teste que passa de primeira não provou nada — investigue antes de seguir.
- Teto de texto: **2 MB** (`TEXT_CAP` em `server/src/routes/files.ts`), o mesmo da leitura.
- Escrita **nunca** fora da raiz real do projeto, nem para admin.
- Tipos editáveis: `markdown`, `code`, `text`. Nunca `image`, `pdf`, `binary`.
- A rota de escrita **não cria** arquivos: só edita os que já existem.
- `npm install` nesta máquina precisa de `CC=gcc-10 CXX=g++-10` (o g++ 9.4 padrão quebra a compilação do `better-sqlite3`).
- Testes do servidor: `npx vitest run <arquivo> --root server`. Do front: `npx vitest run <arquivo> --root web`.
- i18n em três idiomas: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts` — toda chave nova entra nos três.

---

## Estrutura de arquivos

**Servidor**
- `server/src/files/scope.ts` — ganha `isUnderProjectRoot()`, a regra de "dentro do projeto" extraída do miolo de `resolveInScope`.
- `server/src/files/hash.ts` — **novo**: o sha256 usado pelo header e pela verificação de conflito.
- `server/src/files/write.ts` — **novo**: gravação atômica (temporário + rename), preservação de `mode` e de CRLF.
- `server/src/routes/files.ts` — ganha `POST /api/files/write` e o header `X-Content-Hash` no GET de texto.

**Front**
- `web/src/files.ts` — ganha `fetchTextFile()` e `saveFileContent()`.
- `web/src/editor/markdown-live.ts` — **novo**: `markdownDecorations()`, a função pura do live preview.
- `web/src/editor/markdown-live-plugin.ts` — **novo**: a ponte entre a função pura e o CodeMirror.
- `web/src/components/CodeEditor.tsx` — **novo**: casca fina sobre o `EditorView`.
- `web/src/components/TextDocument.tsx` — **novo**: barra de ações + alternância visualizar/editar + gravação.
- `web/src/components/FileViewerModal.tsx` — `TextBody` passa a viver dentro do `TextDocument`; o `Escape` do modal respeita alterações pendentes.
- `web/src/store.ts` — `fileEditDirty` e `setFileEditDirty`.
- `web/src/styles.css` — classes do live preview e da barra de ações.

---

### Task 1: A regra "dentro do projeto", isolada e testável

**Files:**
- Modify: `server/src/files/scope.ts`
- Test: `server/test/files-scope.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `isUnderProjectRoot(real: string, project: { path: string } | null): boolean` — `real` é um realpath já resolvido; devolve `true` só se ele for a raiz real do projeto ou estiver abaixo dela.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao fim de `server/test/files-scope.test.ts` (importe o que faltar do topo do arquivo):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUnderProjectRoot } from '../src/files/scope.js'

describe('isUnderProjectRoot', () => {
  it('arquivo dentro da raiz do projeto → true', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'escopo-'))
    mkdirSync(join(raiz, 'docs'))
    const arquivo = join(raiz, 'docs', 'a.md')
    writeFileSync(arquivo, 'oi')
    expect(isUnderProjectRoot(realpathSync(arquivo), { path: raiz })).toBe(true)
  })

  it('arquivo fora da raiz → false', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'escopo-'))
    const fora = mkdtempSync(join(tmpdir(), 'fora-'))
    const arquivo = join(fora, 'segredo.txt')
    writeFileSync(arquivo, 'x')
    expect(isUnderProjectRoot(realpathSync(arquivo), { path: raiz })).toBe(false)
  })

  it('symlink dentro do projeto apontando pra fora → false (o alvo é que conta)', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'escopo-'))
    const fora = mkdtempSync(join(tmpdir(), 'fora-'))
    const alvo = join(fora, 'segredo.txt')
    writeFileSync(alvo, 'x')
    const link = join(raiz, 'atalho.txt')
    symlinkSync(alvo, link)
    expect(isUnderProjectRoot(realpathSync(link), { path: raiz })).toBe(false)
  })

  it('prefixo parecido não conta como dentro (/proj vs /projeto-x)', () => {
    const base = mkdtempSync(join(tmpdir(), 'escopo-'))
    mkdirSync(join(base, 'proj'))
    mkdirSync(join(base, 'proj-x'))
    const arquivo = join(base, 'proj-x', 'a.txt')
    writeFileSync(arquivo, 'x')
    expect(isUnderProjectRoot(realpathSync(arquivo), { path: join(base, 'proj') })).toBe(false)
  })

  it('sem projeto → false', () => {
    expect(isUnderProjectRoot('/qualquer/coisa.txt', null)).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/files-scope.test.ts --root server`
Expected: FAIL — `isUnderProjectRoot is not a function` / erro de importação.

- [ ] **Step 3: Implementar**

Em `server/src/files/scope.ts`, acrescente antes de `resolveInScope`:

```ts
/**
 * O arquivo (realpath já resolvido) está dentro da raiz real do projeto?
 *
 * É a regra que a ESCRITA exige e a leitura não: admin lê qualquer caminho
 * absoluto do disco, mas ninguém grava fora do projeto. Compara realpath com
 * realpath para que symlink não sirva de porta dos fundos, e exige o separador
 * depois da raiz para que `/proj-x` não passe por dentro de `/proj`.
 */
export function isUnderProjectRoot(real: string, project: { path: string } | null): boolean {
  if (!project) return false
  try {
    const raiz = realpathSync(project.path)
    return real === raiz || real.startsWith(raiz + sep)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/files-scope.test.ts --root server`
Expected: PASS (inclusive os testes que já existiam no arquivo).

- [ ] **Step 5: Reaproveitar dentro de `resolveInScope`**

O miolo de `resolveInScope` tem esta duplicata — troque-a pela função nova:

```ts
  let inScope = isAdmin && !removedBase
  if (!inScope && project) inScope = isUnderProjectRoot(realFile, project)
```

(o `try/catch` com `realpathSync(project.path)` sai daqui: já está dentro de `isUnderProjectRoot`).

- [ ] **Step 6: Rodar a suíte de arquivos inteira**

Run: `npx vitest run test/files-scope.test.ts test/files-routes.test.ts --root server`
Expected: PASS — o refactor não pode mudar nenhum comportamento de leitura.

- [ ] **Step 7: Commit**

```bash
git add server/src/files/scope.ts server/test/files-scope.test.ts
git commit -m "feat(files): regra de dentro-do-projeto isolada em isUnderProjectRoot"
```

---

### Task 2: O hash do conteúdo no GET

**Files:**
- Create: `server/src/files/hash.ts`
- Modify: `server/src/routes/files.ts`
- Test: `server/test/files-routes.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `hashContent(dados: Buffer | string): string` (sha256 hex) e o header `X-Content-Hash` nas respostas de texto de `GET /api/files/content`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente a `server/test/files-routes.test.ts`, dentro do `describe` do GET de conteúdo (ou num novo):

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

describe('GET /api/files/content — hash do conteúdo', () => {
  it('texto vem com X-Content-Hash igual ao sha256 dos bytes do arquivo', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/files/content?path=a.txt&projectId=${projectId}`,
    })
    expect(res.statusCode).toBe(200)
    const esperado = createHash('sha256').update(readFileSync(join(projectPath, 'a.txt'))).digest('hex')
    expect(res.headers['x-content-hash']).toBe(esperado)
  })

  it('o hash acompanha o arquivo: muda o conteúdo, muda o header', async () => {
    const antes = await app.inject({ method: 'GET', url: `/api/files/content?path=a.txt&projectId=${projectId}` })
    writeFileSync(join(projectPath, 'a.txt'), 'outro conteúdo')
    const depois = await app.inject({ method: 'GET', url: `/api/files/content?path=a.txt&projectId=${projectId}` })
    expect(depois.headers['x-content-hash']).not.toBe(antes.headers['x-content-hash'])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/files-routes.test.ts --root server -t "hash do conteúdo"`
Expected: FAIL — `expected undefined to be '…'` (o header não existe).

- [ ] **Step 3: Implementar**

Crie `server/src/files/hash.ts`:

```ts
import { createHash } from 'node:crypto'

/**
 * Identidade do conteúdo de um arquivo, para detectar que ele mudou no disco
 * entre a leitura e a gravação (o agente escreveu no mesmo arquivo que o
 * operador estava editando). Calculado sobre os BYTES: o cliente devolve o
 * valor recebido, nunca recalcula — assim um arquivo com bytes que não são
 * UTF-8 válido não vira conflito eterno por causa do U+FFFD da decodificação.
 */
export const hashContent = (dados: Buffer | string): string =>
  createHash('sha256').update(dados).digest('hex')
```

Em `server/src/routes/files.ts`, importe `hashContent` e acrescente o header no ramo de texto do GET:

```ts
    const buf = await readFile(real)
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Security-Policy', 'sandbox')
    reply.header('X-Content-Hash', hashContent(buf))
    return reply.send(buf)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/files-routes.test.ts --root server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/files/hash.ts server/src/routes/files.ts server/test/files-routes.test.ts
git commit -m "feat(files): GET de texto informa o hash do conteúdo"
```

---

### Task 3: A rota de escrita — grava e respeita o escopo

**Files:**
- Modify: `server/src/routes/files.ts`
- Test: `server/test/files-write.test.ts` (novo)

**Interfaces:**
- Consumes: `isUnderProjectRoot` (Task 1), `hashContent` (Task 2).
- Produces: `POST /api/files/write` com corpo `{ path: string, projectId: number, content: string, baseHash: string }`, respondendo `200 { hash: string }`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `server/test/files-write.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { hashContent } from '../src/files/hash.js'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>
let projectId: number
let projectPath: string
let foraPath: string

const hashDe = (arquivo: string) => hashContent(readFileSync(arquivo))

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  projectPath = mkdtempSync(join(tmpdir(), 'files-write-'))
  writeFileSync(join(projectPath, 'doc.md'), '# antes\n')
  foraPath = mkdtempSync(join(tmpdir(), 'files-write-fora-'))
  writeFileSync(join(foraPath, 'segredo.txt'), 'não me toque')
  projectId = createProjectsService(db).create({ name: 'P', path: projectPath }).id
})

describe('POST /api/files/write — grava dentro do projeto', () => {
  it('grava o conteúdo enviado e o disco reflete', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: '# depois\n\ntexto novo\n', baseHash: hashDe(join(projectPath, 'doc.md')) },
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(join(projectPath, 'doc.md'), 'utf8')).toBe('# depois\n\ntexto novo\n')
  })

  it('sem projectId → 403 e nada é gravado', async () => {
    const alvo = join(projectPath, 'doc.md')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: alvo, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('# antes\n')
  })

  it('caminho absoluto FORA do projeto → 403 mesmo como admin local', async () => {
    const alvo = join(foraPath, 'segredo.txt')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: alvo, projectId, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('não me toque')
  })

  it('symlink dentro do projeto apontando pra fora → 403', async () => {
    const alvo = join(foraPath, 'segredo.txt')
    symlinkSync(alvo, join(projectPath, 'atalho.txt'))
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'atalho.txt', projectId, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('não me toque')
  })
})

describe('POST /api/files/write — RBAC', () => {
  it('usuário sem acesso ao projeto → 403 e nada é gravado', async () => {
    const authDb: Db = openDb(':memory:')
    const auth: AuthService = createAuthService({ db: authDb })
    const manager = createSessionManager({ db: authDb, broadcast: () => {} })
    const authApp = await buildApp({ config: loadConfig({}), db: authDb, manager, auth })
    const projects = createProjectsService(authDb)
    const alheio = mkdtempSync(join(tmpdir(), 'files-write-alheio-'))
    writeFileSync(join(alheio, 'doc.md'), '# alheio\n')
    const alheioId = projects.create({ name: 'Alheio', path: alheio }).id
    const dela = mkdtempSync(join(tmpdir(), 'files-write-dela-'))
    const delaId = projects.create({ name: 'Dela', path: dela }).id
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [delaId] })
    const login = await authApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } })
    const c = login.cookies.find((x: any) => x.name === COOKIE_NAME)
    const res = await authApp.inject({
      method: 'POST', url: '/api/files/write',
      cookies: c ? { [COOKIE_NAME]: c.value } : {},
      payload: { path: 'doc.md', projectId: alheioId, content: 'invadido', baseHash: hashDe(join(alheio, 'doc.md')) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(join(alheio, 'doc.md'), 'utf8')).toBe('# alheio\n')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/files-write.test.ts --root server`
Expected: FAIL — todos com 404 (a rota não existe).

- [ ] **Step 3: Implementar a rota**

Em `server/src/routes/files.ts`, importe `isUnderProjectRoot` de `../files/scope.js`, `hashContent` de `../files/hash.js` e acrescente depois da rota de conteúdo:

```ts
  /**
   * Grava um arquivo de texto do projeto.
   *
   * A diferença para a leitura é deliberada: ler alcança qualquer caminho
   * absoluto quando se é admin; gravar NÃO. Sem projeto, ou fora da raiz real
   * dele, a resposta é 403 — inclusive para admin, inclusive via symlink (o
   * realpath é que vale). Um clique perdido não pode alcançar ~/.ssh nem o
   * banco do próprio Claudinei.
   */
  app.post('/api/files/write', async (req, reply) => {
    const body = req.body as { path?: unknown; projectId?: unknown; content?: unknown; baseHash?: unknown }
    const raw = typeof body?.path === 'string' ? body.path : ''
    const content = typeof body?.content === 'string' ? body.content : null
    const baseHash = typeof body?.baseHash === 'string' ? body.baseHash : ''
    const projectId = typeof body?.projectId === 'number' ? body.projectId : undefined
    if (!raw || content === null || !baseHash) return reply.code(400).send({ error: 'invalid_body' })

    const project = projectFor(req, deps.projects, projectId)
    if (!project) return reply.code(403).send({ error: 'forbidden' })
    const r = resolveInScope(raw, project, isAdminReq(req))
    if (!r.exists || !r.real) return reply.code(404).send({ error: 'not_found' })
    if (!isUnderProjectRoot(r.real, project)) return reply.code(403).send({ error: 'forbidden' })

    const atual = await readFile(r.real)
    await writeFileAtomic(r.real, content, atual)
    const hash = hashContent(await readFile(r.real))
    req.log.info({ path: r.real, projectId: project.id, bytes: content.length }, 'arquivo gravado pelo visualizador')
    return { hash }
  })
```

E, por enquanto, crie `server/src/files/write.ts` com a versão mínima (a Task 5 a completa):

```ts
import { writeFile } from 'node:fs/promises'

export async function writeFileAtomic(real: string, conteudo: string, _anterior: Buffer): Promise<void> {
  await writeFile(real, conteudo, 'utf8')
}
```

Importe `writeFileAtomic` em `server/src/routes/files.ts`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/files-write.test.ts --root server`
Expected: PASS nos 5 casos.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/files.ts server/src/files/write.ts server/test/files-write.test.ts
git commit -m "feat(files): rota de escrita restrita à pasta do projeto"
```

---

### Task 4: As recusas e o conflito com o agente

**Files:**
- Modify: `server/src/routes/files.ts`
- Test: `server/test/files-write.test.ts`

**Interfaces:**
- Consumes: a rota da Task 3.
- Produces: respostas `404 not_found`, `415 not_editable`, `413 too_large`, `409 stale`; e o `{ hash }` de sucesso passa a ser o hash do conteúdo recém-gravado, usável como `baseHash` da próxima gravação.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente a `server/test/files-write.test.ts`:

```ts
describe('POST /api/files/write — recusas', () => {
  it('arquivo inexistente → 404 (a rota não cria arquivo)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'novo.md', projectId, content: 'oi', baseHash: hashContent('') },
    })
    expect(res.statusCode).toBe(404)
  })

  it('arquivo binário → 415 e nada é gravado', async () => {
    const png = join(projectPath, 'pic.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(png, bytes)
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'pic.png', projectId, content: 'texto', baseHash: hashDe(png) },
    })
    expect(res.statusCode).toBe(415)
    expect(readFileSync(png)).toEqual(bytes)
  })

  it('conteúdo acima do teto de 2 MB → 413 e nada é gravado', async () => {
    const alvo = join(projectPath, 'doc.md')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'x'.repeat(2 * 1024 * 1024 + 1), baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(413)
    expect(readFileSync(alvo, 'utf8')).toBe('# antes\n')
  })
})

describe('POST /api/files/write — o agente mexeu no arquivo', () => {
  it('baseHash velho → 409 e o arquivo continua como o agente deixou', async () => {
    const alvo = join(projectPath, 'doc.md')
    const velho = hashDe(alvo)
    writeFileSync(alvo, '# o agente reescreveu\n')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: '# minha versão\n', baseHash: velho },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'stale' })
    expect(readFileSync(alvo, 'utf8')).toBe('# o agente reescreveu\n')
  })

  it('o hash devolvido serve de baseHash para a gravação seguinte', async () => {
    const alvo = join(projectPath, 'doc.md')
    const primeira = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'um\n', baseHash: hashDe(alvo) },
    })
    expect(primeira.statusCode).toBe(200)
    const segunda = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'dois\n', baseHash: primeira.json().hash },
    })
    expect(segunda.statusCode).toBe(200)
    expect(readFileSync(alvo, 'utf8')).toBe('dois\n')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/files-write.test.ts --root server -t "recusas"`
Expected: FAIL — o binário grava (200 em vez de 415) e o teto não é checado.

Run: `npx vitest run test/files-write.test.ts --root server -t "o agente mexeu"`
Expected: FAIL — grava por cima em vez de responder 409.

- [ ] **Step 3: Implementar**

Em `server/src/routes/files.ts`, entre a checagem de escopo e a gravação:

```ts
    if (r.kind === 'image' || r.kind === 'pdf' || r.kind === 'binary') {
      return reply.code(415).send({ error: 'not_editable' })
    }
    if (Buffer.byteLength(content, 'utf8') > TEXT_CAP) return reply.code(413).send({ error: 'too_large' })

    const atual = await readFile(r.real)
    // Releitura na hora de gravar: entre o GET do operador e este POST cabe um
    // turno inteiro de agente. Divergiu → devolve 409 e não encosta no arquivo;
    // sobrescrever calado apagaria o trabalho dele sem ninguém notar.
    if (hashContent(atual) !== baseHash) return reply.code(409).send({ error: 'stale' })
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/files-write.test.ts --root server`
Expected: PASS em todos.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/files.ts server/test/files-write.test.ts
git commit -m "feat(files): escrita recusa tipo/tamanho e detecta alteração concorrente"
```

---

### Task 5: Gravação atômica, permissões e CRLF

**Files:**
- Modify: `server/src/files/write.ts`
- Test: `server/test/files-write.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic(real, conteudo, anterior)` da Task 3.
- Produces: a mesma assinatura, agora com temporário + rename, `mode` preservado e CRLF preservado.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente a `server/test/files-write.test.ts` (importe `chmodSync`, `statSync`, `readdirSync` de `node:fs`):

```ts
describe('POST /api/files/write — fidelidade ao arquivo', () => {
  it('preserva as permissões do arquivo original', async () => {
    const alvo = join(projectPath, 'doc.md')
    chmodSync(alvo, 0o640)
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'novo\n', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(200)
    expect(statSync(alvo).mode & 0o777).toBe(0o640)
  })

  it('arquivo CRLF continua CRLF depois de salvo', async () => {
    const alvo = join(projectPath, 'win.md')
    writeFileSync(alvo, 'linha1\r\nlinha2\r\n')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'win.md', projectId, content: 'linha1\nlinha2\nlinha3\n', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(alvo, 'utf8')).toBe('linha1\r\nlinha2\r\nlinha3\r\n')
  })

  it('arquivo LF continua LF (não ganha \\r por engano)', async () => {
    const alvo = join(projectPath, 'doc.md')
    await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'a\nb\n', baseHash: hashDe(alvo) },
    })
    expect(readFileSync(alvo, 'utf8')).toBe('a\nb\n')
  })

  it('não deixa arquivo temporário para trás', async () => {
    const alvo = join(projectPath, 'doc.md')
    await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'novo\n', baseHash: hashDe(alvo) },
    })
    expect(readdirSync(projectPath).filter((n) => n.includes('claudinei-tmp'))).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/files-write.test.ts --root server -t "fidelidade"`
Expected: FAIL no CRLF (vira LF). O de permissões pode passar por acidente, já que `writeFile` em arquivo existente mantém o `mode` — **isso não vale como verde**: o teste existe para proteger a versão com temporário, que criaria o arquivo com `mode` novo. Confirme depois do Step 3 que ele continua passando.

- [ ] **Step 3: Implementar**

Substitua `server/src/files/write.ts` inteiro:

```ts
import { rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { statSync } from 'node:fs'

/**
 * Grava por temporário + rename, no mesmo diretório do alvo.
 *
 * O rename é atômico: uma queda no meio nunca deixa o arquivo truncado, e o
 * agente que estiver lendo vê a versão antiga ou a nova — nunca meio arquivo.
 * O `mode` do original viaja junto porque o temporário nasce com o padrão do
 * processo (0o600 depois do umask), e o rename leva esse modo consigo.
 *
 * O fim de linha do arquivo manda: um `.md` gravado em CRLF que voltasse em LF
 * viraria um diff de arquivo inteiro no git por causa de uma frase corrigida.
 */
export async function writeFileAtomic(real: string, conteudo: string, anterior: Buffer): Promise<void> {
  const texto = anterior.includes('\r\n') ? conteudo.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : conteudo
  const temp = join(dirname(real), `.${basename(real)}.claudinei-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(temp, texto, { encoding: 'utf8', mode: statSync(real).mode & 0o777 })
    await rename(temp, real)
  } catch (err) {
    await unlink(temp).catch(() => { /* o temporário pode nem ter sido criado */ })
    throw err
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/files-write.test.ts --root server`
Expected: PASS em todos os casos do arquivo.

- [ ] **Step 5: Rodar a suíte do servidor inteira**

Run: `npm run test -w server`
Expected: PASS (o flaky conhecido é o do orchestrator — se ele falhar, rode o arquivo isolado para confirmar que é o de sempre).

- [ ] **Step 6: Commit**

```bash
git add server/src/files/write.ts server/test/files-write.test.ts
git commit -m "feat(files): gravação atômica preservando permissões e fim de linha"
```

---

### Task 6: O cliente HTTP no front

**Files:**
- Modify: `web/src/files.ts`
- Test: `web/src/test/files.test.ts`

**Interfaces:**
- Consumes: as rotas das Tasks 2 e 4.
- Produces:
  - `type TextFetch = { ok: true; text: string; hash: string | null } | { ok: false; code: number }`
  - `fetchTextFile(url: string): Promise<TextFetch>`
  - `saveFileContent(args: { path: string; projectId: number; content: string; baseHash: string }): Promise<{ hash: string }>` — em erro, lança `Error` cuja `message` é o campo `error` do corpo (`'stale'`, `'forbidden'`, …).

- [ ] **Step 1: Escrever o teste que falha**

Acrescente a `web/src/test/files.test.ts`:

```ts
import { fetchTextFile, saveFileContent } from '../files'

describe('fetchTextFile', () => {
  it('sucesso: devolve texto e hash do header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# oi', {
      status: 200, headers: { 'X-Content-Hash': 'abc123' },
    }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: true, text: '# oi', hash: 'abc123' })
  })

  it('sem o header: hash null (o arquivo fica só de leitura)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('texto', { status: 200 }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: true, text: 'texto', hash: null })
  })

  it('erro HTTP: devolve o código', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 413 }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: false, code: 413 })
  })

  it('falha de rede: código 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: false, code: 0 })
  })
})

describe('saveFileContent', () => {
  it('manda path, projeto, conteúdo e baseHash, e devolve o hash novo', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ hash: 'novo' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const r = await saveFileContent({ path: 'doc.md', projectId: 3, content: 'texto', baseHash: 'velho' })
    expect(r).toEqual({ hash: 'novo' })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/files/write')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'doc.md', projectId: 3, content: 'texto', baseHash: 'velho' })
  })

  it('409 vira Error com a mensagem stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    )
    await expect(saveFileContent({ path: 'doc.md', projectId: 3, content: 'x', baseHash: 'v' }))
      .rejects.toThrow('stale')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/test/files.test.ts --root web`
Expected: FAIL — `fetchTextFile is not a function`.

- [ ] **Step 3: Implementar**

Acrescente ao fim de `web/src/files.ts`:

```ts
export type TextFetch = { ok: true; text: string; hash: string | null } | { ok: false; code: number }

/**
 * Lê um arquivo de texto trazendo junto o hash do conteúdo — é ele que a
 * gravação devolve ao servidor para provar que está editando a versão que leu.
 * Sem o header (servidor antigo, resposta de cache), `hash` é null e a UI
 * mantém o arquivo só em leitura, em vez de arriscar sobrescrever às cegas.
 */
export async function fetchTextFile(url: string): Promise<TextFetch> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, code: res.status }
    return { ok: true, text: await res.text(), hash: res.headers.get('X-Content-Hash') }
  } catch {
    return { ok: false, code: 0 }
  }
}

/** Grava o arquivo. Lança Error('stale') quando o disco mudou desde a leitura. */
export const saveFileContent = (args: { path: string; projectId: number; content: string; baseHash: string }) =>
  req<{ hash: string }>('/api/files/write', { method: 'POST', body: JSON.stringify(args) })
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/test/files.test.ts --root web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/files.ts web/src/test/files.test.ts
git commit -m "feat(web): cliente de leitura com hash e de gravação de arquivo"
```

---

### Task 7: O live preview do markdown (função pura)

**Files:**
- Create: `web/src/editor/markdown-live.ts`
- Test: `web/src/test/markdown-live.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `interface MdDecoration { from: number; to: number; class?: string; hide?: boolean }` — `from`/`to` são offsets absolutos no texto.
  - `markdownDecorations(text: string, cursorLine: number): MdDecoration[]` — `cursorLine` é o índice 0-based da linha do cursor; use `-1` para "sem cursor" (tudo escondido).

- [ ] **Step 1: Escrever o teste que falha**

Crie `web/src/test/markdown-live.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { markdownDecorations } from '../editor/markdown-live'

/** Só as decorações que escondem texto, como pares [from,to). */
const escondidos = (texto: string, linha: number) =>
  markdownDecorations(texto, linha).filter((d) => d.hide).map((d) => [d.from, d.to])
/** As classes aplicadas, em ordem. */
const classes = (texto: string, linha: number) =>
  markdownDecorations(texto, linha).filter((d) => d.class).map((d) => d.class)

describe('títulos', () => {
  it('# Título vira h1 e esconde a marca quando o cursor está noutra linha', () => {
    const texto = '# Título\noutra linha'
    expect(classes(texto, 1)).toContain('cm-md-h1')
    expect(escondidos(texto, 1)).toContainEqual([0, 2]) // "# "
  })

  it('com o cursor na linha do título, a marca aparece', () => {
    const texto = '# Título\noutra linha'
    expect(classes(texto, 0)).toContain('cm-md-h1')
    expect(escondidos(texto, 0)).toEqual([])
  })

  it('### vira h3', () => {
    expect(classes('### Três\n', 1)).toContain('cm-md-h3')
  })

  it('#sem espaço não é título', () => {
    expect(classes('#semespaço\n', 1)).not.toContain('cm-md-h1')
  })
})

describe('ênfase', () => {
  it('**negrito** estiliza o miolo e esconde os asteriscos', () => {
    const texto = 'um **forte** aqui'
    expect(classes(texto, 1)).toContain('cm-md-strong')
    expect(escondidos(texto, 1)).toContainEqual([3, 5])
    expect(escondidos(texto, 1)).toContainEqual([10, 12])
  })

  it('*itálico* vira em', () => {
    expect(classes('um *leve* aqui', 1)).toContain('cm-md-em')
  })

  it('~~riscado~~ vira strike', () => {
    expect(classes('um ~~fora~~ aqui', 1)).toContain('cm-md-strike')
  })

  it('`código` vira code e esconde as crases', () => {
    const texto = 'rode `npm test` agora'
    expect(classes(texto, 1)).toContain('cm-md-code')
    expect(escondidos(texto, 1)).toContainEqual([5, 6])
  })

  it('com o cursor na linha, nada é escondido', () => {
    expect(escondidos('um **forte** aqui', 0)).toEqual([])
  })
})

describe('links', () => {
  it('[texto](url) mostra só o texto', () => {
    const texto = 'veja o [manual](https://exemplo.com) ali'
    expect(classes(texto, 1)).toContain('cm-md-link')
    expect(escondidos(texto, 1)).toContainEqual([7, 8])   // "["
    expect(escondidos(texto, 1)).toContainEqual([14, 36]) // "](https://exemplo.com)"
  })
})

describe('linha inteira', () => {
  it('> citação recebe a classe e esconde a marca', () => {
    const texto = '> pensei\noutra'
    expect(classes(texto, 1)).toContain('cm-md-quote')
    expect(escondidos(texto, 1)).toContainEqual([0, 2])
  })

  it('- item recebe classe de lista e NÃO esconde o marcador', () => {
    const texto = '- item\noutra'
    expect(classes(texto, 1)).toContain('cm-md-list')
    expect(escondidos(texto, 1)).toEqual([])
  })
})

describe('bloco de código', () => {
  it('não estiliza marcação dentro de fence', () => {
    const texto = '```js\nconst x = "**não é negrito**"\n```\n'
    expect(classes(texto, 5)).not.toContain('cm-md-strong')
  })

  it('volta a estilizar depois do fence fechar', () => {
    const texto = '```\nx\n```\n**forte**'
    expect(classes(texto, 0)).toContain('cm-md-strong')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/test/markdown-live.test.ts --root web`
Expected: FAIL — o módulo não existe.

- [ ] **Step 3: Implementar**

Crie `web/src/editor/markdown-live.ts`:

```ts
/**
 * O miolo do live preview: dado o texto e a linha do cursor, quais trechos
 * ganham estilo e quais marcas somem.
 *
 * É função pura de propósito. O CodeMirror precisa de layout para montar uma
 * view, o que o jsdom não fornece; mantendo a decisão aqui, toda a regra de
 * "o que fica bonito" é testável sem navegador. O plugin (markdown-live-plugin)
 * só traduz esta saída para Decoration.set.
 *
 * A marca aparece quando o cursor está na linha: é assim que se edita o que
 * está escondido, sem precisar de um modo "ver fonte".
 */
export interface MdDecoration { from: number; to: number; class?: string; hide?: boolean }

const TITULO = /^(#{1,6})\s+/
const CITACAO = /^>\s?/
const LISTA = /^\s*(?:[-*+]|\d+\.)\s+/
const FENCE = /^\s*(?:```|~~~)/

// Ordem importa: ** antes de *, ~~ antes de qualquer coisa com ~.
const INLINE: { re: RegExp; classe: string }[] = [
  { re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strong' },
  { re: /(~~)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strike' },
  { re: /(?<![*\w])(\*|_)(?=\S)([^*_]*?\S)\1(?![*\w])/g, classe: 'cm-md-em' },
  { re: /(`)([^`]+)\1/g, classe: 'cm-md-code' },
]

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

export function markdownDecorations(text: string, cursorLine: number): MdDecoration[] {
  const saida: MdDecoration[] = []
  let offset = 0
  let dentroDeFence = false

  text.split('\n').forEach((linha, i) => {
    const base = offset
    offset += linha.length + 1
    const naLinhaDoCursor = i === cursorLine
    const esconder = (from: number, to: number) => {
      if (!naLinhaDoCursor) saida.push({ from, to, hide: true })
    }

    if (FENCE.test(linha)) {
      dentroDeFence = !dentroDeFence
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-fence' })
      return
    }
    // Dentro do bloco o texto é código: nada de negrito por causa de um `**`.
    if (dentroDeFence) {
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-codeblock' })
      return
    }

    const titulo = TITULO.exec(linha)
    if (titulo) {
      saida.push({ from: base, to: base + linha.length, class: `cm-md-h${titulo[1].length}` })
      esconder(base, base + titulo[0].length)
    }
    const citacao = CITACAO.exec(linha)
    if (citacao) {
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-quote' })
      esconder(base, base + citacao[0].length)
    }
    // O marcador da lista é conteúdo (some ele, some a estrutura): só estiliza.
    if (LISTA.test(linha)) saida.push({ from: base, to: base + linha.length, class: 'cm-md-list' })

    for (const { re, classe } of INLINE) {
      re.lastIndex = 0
      for (let m = re.exec(linha); m; m = re.exec(linha)) {
        const inicio = base + m.index
        const marca = m[1].length
        saida.push({ from: inicio + marca, to: inicio + m[0].length - marca, class: classe })
        esconder(inicio, inicio + marca)
        esconder(inicio + m[0].length - marca, inicio + m[0].length)
      }
    }

    LINK.lastIndex = 0
    for (let m = LINK.exec(linha); m; m = LINK.exec(linha)) {
      const inicio = base + m.index
      saida.push({ from: inicio + 1, to: inicio + 1 + m[1].length, class: 'cm-md-link' })
      esconder(inicio, inicio + 1)
      esconder(inicio + 1 + m[1].length, inicio + m[0].length)
    }
  })

  return saida
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/test/markdown-live.test.ts --root web`
Expected: PASS. Se algum caso de ênfase falhar por causa das regexes, ajuste a **regex**, não o teste — os offsets esperados nos testes vêm do texto literal e estão corretos.

- [ ] **Step 5: Commit**

```bash
git add web/src/editor/markdown-live.ts web/src/test/markdown-live.test.ts
git commit -m "feat(web): decorações do live preview de markdown"
```

---

### Task 8: O editor CodeMirror

**Files:**
- Create: `web/src/editor/markdown-live-plugin.ts`
- Create: `web/src/components/CodeEditor.tsx`
- Modify: `web/package.json` (dependências)
- Test: verificação manual no navegador (ver Step 5) — a montagem do `EditorView` depende de layout e não roda em jsdom.

**Interfaces:**
- Consumes: `markdownDecorations` (Task 7).
- Produces:
  - `livePreview(): Extension` — a extensão CodeMirror do live preview.
  - `<CodeEditor value={string} lang={'markdown' | 'html' | 'javascript' | null} onChange={(v: string) => void} onSave={() => void} />` — editor montado uma vez; `value` só é reaplicado quando difere do conteúdo atual (evita reset do cursor a cada tecla).

- [ ] **Step 1: Instalar as dependências**

```bash
cd /home/coppi/Projects/61-Claudinei/claudinei
CC=gcc-10 CXX=g++-10 npm i -w web @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown @codemirror/lang-html @codemirror/lang-javascript
```

Confira que `web/package.json` listou os sete pacotes e que `npm run build -w web` ainda passa.

- [ ] **Step 2: Escrever o plugin**

Crie `web/src/editor/markdown-live-plugin.ts`:

```ts
import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { markdownDecorations } from './markdown-live'

/**
 * A ponte entre a regra (markdown-live.ts, testada) e o CodeMirror.
 *
 * Recalcula quando o texto ou o cursor mudam — o cursor entra na conta porque
 * a linha em que ele está mostra a marcação crua, que é como se edita o que
 * está escondido no resto do documento.
 */
function construir(view: EditorView): DecorationSet {
  const texto = view.state.doc.toString()
  const linhaDoCursor = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const builder = new RangeSetBuilder<Decoration>()
  const decs = markdownDecorations(texto, linhaDoCursor)
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)
  for (const d of decs) {
    if (d.hide) builder.add(d.from, d.to, Decoration.replace({}))
    else if (d.class) builder.add(d.from, d.to, Decoration.mark({ class: d.class }))
  }
  return builder.finish()
}

export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = construir(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = construir(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
```

- [ ] **Step 3: Escrever o componente**

Crie `web/src/components/CodeEditor.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { livePreview } from '../editor/markdown-live-plugin'

export type EditorLang = 'markdown' | 'html' | 'javascript' | null

function extensoesDaLinguagem(lang: EditorLang): Extension[] {
  if (lang === 'markdown') return [markdown(), livePreview()]
  if (lang === 'html') return [html()]
  if (lang === 'javascript') return [javascript({ typescript: true })]
  return []
}

/**
 * Casca fina sobre o CodeMirror. Monta a view UMA vez: recriar a cada render
 * jogaria fora cursor, rolagem e histórico de desfazer. `value` só volta para
 * dentro quando difere do que está no editor — o caso real é o "recarregar"
 * depois de um conflito.
 */
export function CodeEditor({ value, lang, onChange, onSave }: {
  value: string
  lang: EditorLang
  onChange: (v: string) => void
  onSave: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const aoMudar = useRef(onChange)
  const aoSalvar = useRef(onSave)
  aoMudar.current = onChange
  aoSalvar.current = onSave

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { aoSalvar.current(); return true } },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => { if (u.docChanged) aoMudar.current(u.state.doc.toString()) }),
        ...extensoesDaLinguagem(lang),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    v.focus()
    return () => { v.destroy(); view.current = null }
    // `value` de propósito fora das dependências: ver o efeito seguinte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const atual = v.state.doc.toString()
    if (atual === value) return
    v.dispatch({ changes: { from: 0, to: atual.length, insert: value } })
  }, [value])

  return <div className="code-editor" ref={host} data-testid="code-editor" />
}
```

- [ ] **Step 4: Compilar**

Run: `npx tsc --noEmit -p web`
Expected: sem erros.

- [ ] **Step 5: Verificar à mão**

Suba a instância isolada (não toque no serviço — ver `docs/` e a memória `verificar-e2e-sem-reiniciar`):

```bash
npm run build -w web
cd server && CLAUDINEI_PORT=9199 CLAUDINEI_DB=/tmp/claudinei-e2e/claudinei.db \
  CLAUDINEI_UPLOADS=/tmp/claudinei-e2e/uploads CLAUDINEI_SCHEDULES=/tmp/claudinei-e2e/schedules \
  CLAUDINEI_SPEECH=/tmp/claudinei-e2e/speech npx tsx src/index.ts
```

Este passo só confirma que o editor monta e digita; a integração completa é a Task 10.

- [ ] **Step 6: Commit**

```bash
git add web/package.json package-lock.json web/src/editor/markdown-live-plugin.ts web/src/components/CodeEditor.tsx
git commit -m "feat(web): editor CodeMirror com live preview de markdown"
```

---

### Task 9: O documento editável (barra de ações e gravação)

**Files:**
- Create: `web/src/components/TextDocument.tsx`
- Modify: `web/src/store.ts`
- Test: `web/src/test/text-document.test.tsx` (novo)

**Interfaces:**
- Consumes: `fetchTextFile`, `saveFileContent` (Task 6), `CodeEditor` (Task 8).
- Produces:
  - store: `fileEditDirty: boolean` e `setFileEditDirty(v: boolean): void`.
  - `<TextDocument kind={FileKind} url={string} name={string} path={string} projectId={number | undefined} />` — carrega, mostra, e (quando editável) edita e grava.

**Nota sobre o CodeMirror nos testes:** a montagem do `EditorView` não funciona em jsdom. Nos testes deste arquivo, substitua o módulo do editor:

```tsx
vi.mock('../components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
```

Isso troca **a casca**, não a lógica: as regras do live preview já estão cobertas na Task 7, e o que este arquivo testa é a barra, o estado sujo e a gravação.

- [ ] **Step 1: Escrever o teste que falha**

Crie `web/src/test/text-document.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { useStore } from '../store'

vi.mock('../components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

const { TextDocument } = await import('../components/TextDocument')

const respostaDeLeitura = (texto: string, hash: string | null = 'h1') =>
  new Response(texto, { status: 200, headers: hash ? { 'X-Content-Hash': hash } : {} })

const montar = (props: Partial<Parameters<typeof TextDocument>[0]> = {}) =>
  render(<TextDocument kind="markdown" url="/api/files/content?path=doc.md" name="doc.md" path="doc.md" projectId={1} {...props} />)

beforeEach(() => { useStore.setState({ fileEditDirty: false }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('TextDocument — quando o lápis aparece', () => {
  it('markdown com projeto: aparece', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar()
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeTruthy()
  })

  it('sem projeto: não aparece (o servidor recusaria a gravação)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar({ projectId: undefined })
    await screen.findByText('oi')
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull()
  })

  it('sem hash no header: não aparece (não dá para provar qual versão foi lida)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi', null))
    montar()
    await screen.findByText('oi')
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull()
  })
})

describe('TextDocument — editar e salvar', () => {
  it('editar abre o editor com o conteúdo lido', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('# oi')
  })

  it('digitar marca como sujo; salvar manda o baseHash e limpa a marca', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('# oi', 'hash-lido'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'hash-novo' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: '# mudou' } })
    expect(useStore.getState().fileEditDirty).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    const corpo = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)
    expect(corpo).toEqual({ path: 'doc.md', projectId: 1, content: '# mudou', baseHash: 'hash-lido' })
  })

  it('salvar duas vezes usa o hash devolvido na primeira', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValue(new Response(JSON.stringify({ hash: 'h2' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'c' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    expect(JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string).baseHash).toBe('h2')
  })

  it('409: mostra o aviso de arquivo alterado e mantém o texto editado', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'minha versão' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText(/mudou no disco/i)).toBeTruthy()
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('minha versão')
    expect(useStore.getState().fileEditDirty).toBe(true)
  })

  it('recarregar depois do conflito traz a versão do disco e limpa o aviso', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(respostaDeLeitura('versão do agente', 'h9'))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'minha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Recarregar' }))
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('versão do agente'))
    expect(useStore.getState().fileEditDirty).toBe(false)
  })

  it('desmontar sujo limpa a marca do store (não fica travando o modal seguinte)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('a', 'h1'))
    const { unmount } = montar()
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'b' } })
    unmount()
    expect(useStore.getState().fileEditDirty).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/test/text-document.test.tsx --root web`
Expected: FAIL — o módulo `TextDocument` não existe.

- [ ] **Step 3: Acrescentar o estado ao store**

Em `web/src/store.ts`, no tipo do estado (perto de `fileViewer`):

```ts
  /** Há edição não salva num documento aberto? O modal consulta antes de fechar. */
  fileEditDirty: boolean
```

na lista de ações (perto de `closeFile`):

```ts
  setFileEditDirty(v: boolean): void
```

no estado inicial (perto de `fileViewer: null`) e também no objeto de reset que zera `fileViewer`:

```ts
  fileEditDirty: false,
```

e na implementação:

```ts
  setFileEditDirty: (v) => set({ fileEditDirty: v }),
```

- [ ] **Step 4: Escrever o componente**

Crie `web/src/components/TextDocument.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileKind } from '../files'
import { fetchTextFile, langOfPath, saveFileContent } from '../files'
import { useStore } from '../store'
import { CodeEditor, type EditorLang } from './CodeEditor'
import { RenderedText } from './FileViewerModal'

type Carga =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'ok'; text: string; hash: string | null }

/** A linguagem do editor a partir da extensão — o resto cai em texto puro. */
function editorLang(kind: FileKind, name: string): EditorLang {
  if (kind === 'markdown') return 'markdown'
  const lang = langOfPath(name)
  if (lang === 'html') return 'html'
  if (lang === 'js' || lang === 'ts' || lang === 'tsx' || lang === 'jsx') return 'javascript'
  return null
}

/**
 * Um documento de texto no visualizador: lê, mostra formatado e — quando é
 * editável — deixa editar e gravar.
 *
 * O lápis exige projeto E hash: sem projeto o servidor recusaria a gravação, e
 * sem o hash não há como provar qual versão foi lida, o que abriria espaço para
 * sobrescrever o agente às cegas. Em vez de oferecer um botão que falha depois,
 * ele não aparece.
 */
export function TextDocument({ kind, url, name, path, projectId }: {
  kind: FileKind; url: string; name: string; path: string; projectId?: number
}) {
  const { t } = useTranslation()
  const setFileEditDirty = useStore((s) => s.setFileEditDirty)
  const [carga, setCarga] = useState<Carga>({ status: 'loading' })
  const [editando, setEditando] = useState(false)
  const [rascunho, setRascunho] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [sujo, setSujo] = useState(false)
  const [erro, setErro] = useState<'stale' | 'outro' | null>(null)
  const [salvando, setSalvando] = useState(false)
  const rascunhoRef = useRef('')
  rascunhoRef.current = rascunho

  const carregar = (limparRascunho: boolean) => {
    setCarga({ status: 'loading' })
    return fetchTextFile(url).then((r) => {
      if (!r.ok) { setCarga({ status: 'error', code: r.code }); return }
      setCarga({ status: 'ok', text: r.text, hash: r.hash })
      setBase(r.hash)
      if (limparRascunho) {
        setRascunho(r.text)
        setSujo(false)
        setFileEditDirty(false)
        setErro(null)
      }
    })
  }

  useEffect(() => { void carregar(true) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [url])
  // Sair da tela com edição pendente não pode deixar o aviso preso no store.
  useEffect(() => () => setFileEditDirty(false), [setFileEditDirty])

  const editavel = carga.status === 'ok' && !!projectId && !!base

  const mudou = (v: string) => {
    setRascunho(v)
    const diferente = carga.status === 'ok' && v !== carga.text
    setSujo(diferente)
    setFileEditDirty(diferente)
  }

  const salvar = () => {
    if (!projectId || !base || salvando) return
    setSalvando(true)
    setErro(null)
    saveFileContent({ path, projectId, content: rascunhoRef.current, baseHash: base })
      .then((r) => {
        setBase(r.hash)
        setCarga({ status: 'ok', text: rascunhoRef.current, hash: r.hash })
        setSujo(false)
        setFileEditDirty(false)
      })
      .catch((e: Error) => setErro(e.message === 'stale' ? 'stale' : 'outro'))
      .finally(() => setSalvando(false))
  }

  if (carga.status === 'loading') return <div style={{ color: 'var(--text-dim)' }}>{t('fileViewer.loading')}</div>
  if (carga.status === 'error') {
    if (carga.code === 403) return <div style={{ color: 'var(--err)' }}>{t('fileViewer.forbidden')}</div>
    if (carga.code === 413) {
      return (
        <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
          <p>{t('fileViewer.tooLarge')}</p>
          <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
        </div>
      )
    }
    return <div style={{ color: 'var(--err)' }}>{t('fileViewer.notFound')}</div>
  }

  return (
    <div className="text-document">
      <div className="text-document__bar">
        {editando ? (
          <>
            {sujo && <span className="text-document__dot" title={t('fileViewer.unsaved')} />}
            <button type="button" className="ghost" disabled={!sujo || salvando} onClick={salvar}>
              {t('fileViewer.save')}
            </button>
            <button type="button" className="ghost" onClick={() => { setEditando(false); setRascunho(carga.text); setSujo(false); setFileEditDirty(false); setErro(null) }}>
              {t('fileViewer.stopEditing')}
            </button>
          </>
        ) : (
          editavel && (
            <button type="button" className="ghost" onClick={() => { setRascunho(carga.text); setEditando(true) }}>
              ✏️ {t('fileViewer.edit')}
            </button>
          )
        )}
      </div>

      {erro === 'stale' && (
        <div className="text-document__alert">
          {t('fileViewer.staleFile')}
          <button type="button" className="ghost" onClick={() => { void carregar(true) }}>{t('fileViewer.reload')}</button>
        </div>
      )}
      {erro === 'outro' && <div className="text-document__alert">{t('fileViewer.saveFailed')}</div>}

      {editando
        ? <CodeEditor value={rascunho} lang={editorLang(kind, name)} onChange={mudou} onSave={salvar} />
        : <RenderedText kind={kind} text={carga.text} name={name} />}
    </div>
  )
}
```

- [ ] **Step 5: Extrair o `RenderedText` do `TextBody`**

`TextDocument` precisa renderizar o texto que já carregou. Em `web/src/components/FileViewerModal.tsx`, separe a renderização do carregamento: mantenha o `TextBody` como está por enquanto e **exporte** uma função nova com só a parte de render (o corpo dos `if (kind === 'markdown')` / código / `<pre>` de hoje, recebendo `text` pronto):

```tsx
/** Só a renderização de um texto já carregado — o carregamento vive no TextDocument. */
export function RenderedText({ kind, text, name }: { kind: FileKind; text: string; name: string }) {
  // (mover para cá, sem alterar, os três ramos finais do TextBody: markdown,
  // código com fence + rehypeHighlight, e o <pre> de fallback)
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run src/test/text-document.test.tsx --root web`
Expected: PASS nos 9 casos.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TextDocument.tsx web/src/components/FileViewerModal.tsx web/src/store.ts web/src/test/text-document.test.tsx
git commit -m "feat(web): documento de texto editável com gravação e aviso de conflito"
```

---

### Task 10: Integração — modal, painel inline, HTML, textos e estilo

**Files:**
- Modify: `web/src/components/FileViewerModal.tsx`
- Modify: `web/src/i18n/pt-BR.ts`, `web/src/i18n/en.ts`, `web/src/i18n/es.ts`
- Modify: `web/src/styles.css`
- Test: `web/src/test/file-viewer-modal.test.tsx`

**Interfaces:**
- Consumes: `TextDocument` (Task 9), `fileEditDirty` (Task 9).
- Produces: o visualizador inteiro (modal e inline) usando `TextDocument`; `Escape` e `✕` confirmam antes de descartar; a aba Página do HTML recarrega depois de salvar.

- [ ] **Step 1: Escrever o teste que falha**

Acrescente a `web/src/test/file-viewer-modal.test.tsx`:

```tsx
describe('fechar com edição pendente', () => {
  it('Escape com alteração não salva pede confirmação e não fecha', async () => {
    useStore.setState({ fileEditDirty: true })
    open('markdown', '/p/doc.md', 1)
    render(<FileViewerModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await screen.findByText(/descartar/i)).toBeTruthy()
    expect(useStore.getState().fileViewer).not.toBeNull()
  })

  it('confirmando o descarte, fecha', async () => {
    useStore.setState({ fileEditDirty: true })
    open('markdown', '/p/doc.md', 1)
    render(<FileViewerModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar' }))
    await waitFor(() => expect(useStore.getState().fileViewer).toBeNull())
  })

  it('sem alteração pendente, Escape fecha direto', () => {
    useStore.setState({ fileEditDirty: false })
    open('markdown', '/p/doc.md', 1)
    render(<FileViewerModal />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().fileViewer).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/test/file-viewer-modal.test.tsx --root web -t "edição pendente"`
Expected: FAIL — o modal fecha sem perguntar.

- [ ] **Step 3: Ligar o `TextDocument` no corpo**

Em `web/src/components/FileViewerModal.tsx`, no `FileBody`, troque a última linha:

```tsx
  return <TextDocument kind={kind} url={url} name={name} path={path ?? name} projectId={projectId} />
```

e, dentro do `HtmlBody`, troque o `{view === 'source' && <TextBody … />}` por:

```tsx
      {view === 'source' && (
        <TextDocument
          kind="code" url={url} name={name} path={path} projectId={projectId}
          onSaved={() => { /* o Step 5 preenche: recarregar a prévia */ }}
        />
      )}
```

Remova o `TextBody` antigo (o carregamento agora vive no `TextDocument`; a renderização, no `RenderedText`).

- [ ] **Step 4: Proteger o fechamento**

Ainda em `FileViewerModal`:

```tsx
  const sujo = useStore((s) => s.fileEditDirty)
  const [confirmando, setConfirmando] = useState(false)
  const tentarFechar = () => { if (sujo) setConfirmando(true); else closeFile() }
```

Use `tentarFechar` no `onKeyDown` do `Escape`, no clique fora e no botão `✕`; e renderize, quando `confirmando`:

```tsx
      {confirmando && (
        <ConfirmDialog
          title={t('fileViewer.discardTitle')}
          message={t('fileViewer.discardBody')}
          confirmLabel={t('fileViewer.discard')}
          onConfirm={() => { setConfirmando(false); closeFile() }}
          onClose={() => setConfirmando(false)}
        />
      )}
```

Faça o mesmo no `InlineFileView` para o botão `✕`.

- [ ] **Step 5: Recarregar a página do HTML depois de salvar**

Dê ao `TextDocument` uma prop opcional `onSaved?: () => void`, chamada no `.then` de `salvar`. No `HtmlBody`, passe uma função que refaz a prévia:

```tsx
  const recarregarPagina = () => {
    createFilePreview(path, projectId)
      .then((r) => setPreview({ status: 'ok', url: r.url }))
      .catch(() => setPreview({ status: 'error' }))
  }
```

- [ ] **Step 6: Textos nos três idiomas**

Em `web/src/i18n/pt-BR.ts`, dentro de `fileViewer`:

```ts
    edit: 'Editar', save: 'Salvar', stopEditing: 'Concluir',
    unsaved: 'Alterações não salvas',
    staleFile: 'Este arquivo mudou no disco desde que você abriu.',
    reload: 'Recarregar', saveFailed: 'Não foi possível salvar o arquivo.',
    discardTitle: 'Descartar alterações?',
    discardBody: 'Você editou este arquivo e ainda não salvou. Fechar agora descarta o que você escreveu.',
    discard: 'Descartar',
```

`en.ts`:

```ts
    edit: 'Edit', save: 'Save', stopEditing: 'Done',
    unsaved: 'Unsaved changes',
    staleFile: 'This file changed on disk since you opened it.',
    reload: 'Reload', saveFailed: 'Could not save the file.',
    discardTitle: 'Discard changes?',
    discardBody: 'You edited this file and have not saved. Closing now discards what you wrote.',
    discard: 'Discard',
```

`es.ts`:

```ts
    edit: 'Editar', save: 'Guardar', stopEditing: 'Listo',
    unsaved: 'Cambios sin guardar',
    staleFile: 'Este archivo cambió en el disco desde que lo abriste.',
    reload: 'Recargar', saveFailed: 'No se pudo guardar el archivo.',
    discardTitle: '¿Descartar cambios?',
    discardBody: 'Editaste este archivo y no lo guardaste. Cerrar ahora descarta lo que escribiste.',
    discard: 'Descartar',
```

- [ ] **Step 7: Estilo**

Em `web/src/styles.css`, acrescente as classes do live preview e da barra. Os tamanhos de título acompanham os do `.markdown` que já existe no arquivo:

```css
.text-document__bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-bottom: 8px; }
.text-document__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.text-document__alert { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 8px;
  border: 1px solid var(--glass-border); border-radius: 8px; color: var(--err); }
.code-editor .cm-editor { background: transparent; }
.code-editor .cm-content { font-family: monospace; font-size: 13px; }
.cm-md-h1 { font-size: 1.7em; font-weight: 700; }
.cm-md-h2 { font-size: 1.45em; font-weight: 700; }
.cm-md-h3 { font-size: 1.25em; font-weight: 600; }
.cm-md-h4, .cm-md-h5, .cm-md-h6 { font-weight: 600; }
.cm-md-strong { font-weight: 700; }
.cm-md-em { font-style: italic; }
.cm-md-strike { text-decoration: line-through; opacity: .7; }
.cm-md-code, .cm-md-codeblock { font-family: monospace; background: rgba(255,255,255,.06); border-radius: 4px; }
.cm-md-fence { opacity: .5; }
.cm-md-quote { border-left: 3px solid var(--glass-border); padding-left: 10px; opacity: .85; }
.cm-md-link { color: var(--accent); }
```

- [ ] **Step 8: Rodar tudo**

Run: `npx vitest run src/test/file-viewer-modal.test.tsx src/test/inline-file.test.tsx src/test/text-document.test.tsx --root web`
Expected: PASS.

Run: `npx tsc --noEmit -p web && npx tsc --noEmit -p server`
Expected: sem erros.

Run: `npm test`
Expected: PASS nas duas suítes (atenção ao flaky conhecido do orchestrator).

- [ ] **Step 9: Verificar à mão, na instância isolada**

Suba a instância da porta 9199 (Task 8, Step 5) e confira, num projeto de teste:

1. abrir um `.md`, clicar no lápis, digitar — o título continua grande, a marca `#` aparece só na linha do cursor;
2. `Ctrl+S` grava e o ponto de pendência some; conferir o arquivo no disco;
3. editar sem salvar e apertar `Escape` — a confirmação aparece;
4. com o editor aberto, alterar o arquivo por fora (`echo x >> arquivo`) e salvar — o aviso de conflito aparece e o disco não é tocado; "Recarregar" traz a versão de fora;
5. abrir um `.html`, editar no Fonte, salvar, e ver a aba Página refletir a mudança;
6. abrir uma imagem e um PDF — sem lápis.

Limpe depois: `rm -rf /tmp/claudinei-e2e` e a pasta de teste.

- [ ] **Step 10: Commit**

```bash
git add web/src
git commit -m "feat(web): lápis de edição no visualizador de arquivos"
```

---

## Notas para quem executa

- **Não reinicie o `claudinei.service`** e não empacote nada sem autorização expressa do Danilo. O serviço hospeda as sessões de outros agentes — inclusive a que estiver executando este plano. Toda verificação vai na instância isolada da porta 9199.
- O teste do orchestrator falha de forma intermitente e isso é anterior a este trabalho: se `npm test` acusar só ele, rode o arquivo isolado para confirmar antes de investigar.
- Se um teste passar de primeira, pare e descubra por quê. Quase sempre significa que ele não está testando o que se pensa.
