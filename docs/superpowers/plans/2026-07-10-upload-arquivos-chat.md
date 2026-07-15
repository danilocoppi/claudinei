# Upload de arquivos/imagens no chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arrastar/colar arquivos no campo de mensagem → upload para `~/.termaster/uploads` (rotação global de 100) → token inline no cursor → path absoluto substituído na mensagem enviada ao Claude.

**Architecture:** Serviço `uploads.ts` (sanitize + contador + rotação) usado por uma rota `POST /api/uploads` com `@fastify/multipart`. No front, o `ChatInput` ganha `onPaste`/`onDrop` que sobem o arquivo e inserem `[📎 nome]` na posição do cursor; o `send()` troca cada token pelo path real. Zero mudança no pipeline de sessões (a mensagem segue por WS como texto).

**Tech Stack:** Fastify 5 + `@fastify/multipart` ^9, Node streams (`pipeline`), vitest; React 18, testing-library.

## Global Constraints

- Limite de upload: **100 MB** (`100 * 1024 * 1024`), 1 arquivo por request.
- Rotação: **100 arquivos** (global, uma pasta para todos os projetos/sessões), apagando os mais antigos por mtime após cada gravação.
- Pasta: `config.uploadsDir` = env `CLAUDINEI_UPLOADS` ?? `~/.termaster/uploads`.
- Nome final: `NNN-<sanitizado>` — NNN = maior prefixo existente + 1, zero-padded a 3; sanitização mantém só `[a-zA-Z0-9._-]`, remove `..`, trunca a 80 chars, vazio → `arquivo`.
- Token no textarea: `[📎 <nomeFinal>]` (nome final do servidor — único). Token apagado pelo usuário = anexo não vai.
- `uploadFile` no front usa `fetch` cru com `FormData` — **sem** header Content-Type manual (o browser põe o boundary; o helper `req()` colocaria `application/json` e quebraria).
- ESM + TS strict, imports relativos com `.js` no server. Testes: vitest.

---

### Task 1: Serviço de uploads (sanitize + contador + rotação)

**Files:**
- Create: `server/src/uploads.ts`
- Test: `server/test/uploads.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeName(name: string): string`
  - `saveUpload(dir: string, name: string, stream: NodeJS.ReadableStream): Promise<{ path: string; name: string }>`
  - `rotateUploads(dir: string, keep?: number): void` (default keep=100)

- [ ] **Step 1: Escrever os testes (falhando)**

Create `server/test/uploads.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeName, saveUpload, rotateUploads } from '../src/uploads.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'up-'))

describe('sanitizeName', () => {
  it('remove path traversal e metachars', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc_passwd')
    expect(sanitizeName('foto legal (1).png')).toBe('foto_legal__1_.png')
    expect(sanitizeName('a;rm -rf.txt')).toBe('a_rm_-rf.txt')
  })
  it('vazio (ou só lixo) vira "arquivo"', () => {
    expect(sanitizeName('')).toBe('arquivo')
    expect(sanitizeName('///')).toBe('arquivo')
  })
  it('trunca a 80 chars preservando a extensão no fim', () => {
    const long = 'x'.repeat(200) + '.png'
    const out = sanitizeName(long)
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith('.png')).toBe(true)
  })
})

describe('saveUpload', () => {
  it('grava com prefixo incremental a partir do maior existente', async () => {
    const dir = tmp()
    writeFileSync(join(dir, '007-antigo.txt'), 'x')
    const r1 = await saveUpload(dir, 'foto.png', Readable.from('AAA'))
    expect(r1.name).toBe('008-foto.png')
    expect(r1.path).toBe(join(dir, '008-foto.png'))
    expect(readFileSync(r1.path, 'utf8')).toBe('AAA')
    const r2 = await saveUpload(dir, 'foto.png', Readable.from('BBB'))
    expect(r2.name).toBe('009-foto.png') // mesmo nome nunca colide
  })
  it('cria a pasta se não existir', async () => {
    const dir = join(tmp(), 'sub', 'dir')
    const r = await saveUpload(dir, 'a.txt', Readable.from('x'))
    expect(readFileSync(r.path, 'utf8')).toBe('x')
  })
})

describe('rotateUploads', () => {
  it('mantém só os N mais novos por mtime', () => {
    const dir = tmp()
    for (let i = 0; i < 7; i++) {
      const f = join(dir, `00${i}-f${i}.txt`)
      writeFileSync(f, 'x')
      utimesSync(f, new Date(1000000 + i * 1000), new Date(1000000 + i * 1000))
    }
    rotateUploads(dir, 3)
    const left = readdirSync(dir).sort()
    expect(left).toEqual(['004-f4.txt', '005-f5.txt', '006-f6.txt'])
  })
  it('pasta inexistente é no-op', () => {
    expect(() => rotateUploads('/nao/existe', 3)).not.toThrow()
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- uploads`
Expected: FAIL — módulo `../src/uploads.js` não existe.

- [ ] **Step 3: Implementar `server/src/uploads.ts`**

```ts
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, extname, basename } from 'node:path'

const MAX_NAME = 80

/** Mantém só [a-zA-Z0-9._-]; remove '..'; trunca preservando a extensão; vazio → 'arquivo'. */
export function sanitizeName(name: string): string {
  let clean = basename(name).replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_')
  clean = clean.replace(/^[._]+/, '') // não começa com ponto (arquivo oculto) nem _
  if (!clean) return 'arquivo'
  if (clean.length > MAX_NAME) {
    const ext = extname(clean)
    clean = clean.slice(0, MAX_NAME - ext.length) + ext
  }
  return clean
}

/** Próximo prefixo NNN- (maior existente + 1, mínimo 001), zero-padded a 3. */
function nextPrefix(dir: string): string {
  let max = 0
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d+)-/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return String(max + 1).padStart(3, '0')
}

export async function saveUpload(
  dir: string,
  name: string,
  stream: NodeJS.ReadableStream,
): Promise<{ path: string; name: string }> {
  mkdirSync(dir, { recursive: true })
  const finalName = `${nextPrefix(dir)}-${sanitizeName(name)}`
  const path = join(dir, finalName)
  await pipeline(stream, createWriteStream(path))
  return { path, name: finalName }
}

/** Rotação global: mantém só os `keep` mais novos por mtime. */
export function rotateUploads(dir: string, keep = 100): void {
  if (!existsSync(dir)) return
  const files = readdirSync(dir)
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of files.slice(keep)) {
    try { unlinkSync(join(dir, f)) } catch { /* sumiu no meio: ok */ }
  }
}
```

- [ ] **Step 4: Rodar para ver passar**

Run: `npm test -w server -- uploads`
Expected: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add server/src/uploads.ts server/test/uploads.test.ts
git commit -m "feat(server): serviço de uploads com sanitização, contador e rotação de 100"
```

---

### Task 2: Config `uploadsDir` + rota POST /api/uploads (@fastify/multipart)

**Files:**
- Modify: `server/src/config.ts` (campo `uploadsDir`)
- Create: `server/src/routes/uploads.ts`
- Modify: `server/src/app.ts` (registrar a rota)
- Test: `server/test/routes-uploads.test.ts` + 2 asserções em `server/test/config.test.ts`
- Modify: `server/package.json` (dep `@fastify/multipart`)

**Interfaces:**
- Consumes: `saveUpload`, `rotateUploads` (Task 1); `Config` existente.
- Produces:
  - `Config.uploadsDir: string`
  - `POST /api/uploads` (multipart, campo `file`) → `201 { path, name }`; sem arquivo → 400; estouro → 413.
  - `registerUploadRoutes(app, { uploadsDir })`

- [ ] **Step 1: Instalar a dependência**

Run: `npm install @fastify/multipart@^9.0.0 -w server`
Expected: dep em `server/package.json` (lockfile é o da raiz — workspaces).

- [ ] **Step 2: Config — testes e campo**

Em `server/test/config.test.ts`, adicionar no teste de defaults:
```ts
    expect(c.uploadsDir).toBe(join(homedir(), '.termaster', 'uploads'))
```
(garantir `import { homedir } from 'node:os'` e `import { join } from 'node:path'` no topo se ausentes) e no teste de overrides (env `CLAUDINEI_UPLOADS: '/tmp/ups'`):
```ts
    expect(c.uploadsDir).toBe('/tmp/ups')
```

Em `server/src/config.ts`: adicionar `uploadsDir: string` na interface (com doc `/** Pasta global de uploads do chat (rotação de 100). */`) e no objeto retornado:
```ts
    uploadsDir: env.CLAUDINEI_UPLOADS ?? join(homedir(), '.termaster', 'uploads'),
```

Run: `npm test -w server -- config`
Expected: PASS.

- [ ] **Step 3: Testes da rota (falhando)**

Create `server/test/routes-uploads.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerUploadRoutes } from '../src/routes/uploads.js'

const BOUNDARY = 'X-TEST-BOUNDARY'
function multipartBody(filename: string, content: string): string {
  return [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    content,
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n')
}
const HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

let dir: string
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'up-'))
  app = Fastify()
  await registerUploadRoutes(app, { uploadsDir: dir })
})

describe('POST /api/uploads', () => {
  it('salva o arquivo e devolve path absoluto + nome final', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('print.png', 'PNGDATA'), headers: HEADERS })
    expect(res.statusCode).toBe(201)
    const { path, name } = res.json()
    expect(name).toBe('001-print.png')
    expect(path).toBe(join(dir, '001-print.png'))
    expect(readFileSync(path, 'utf8')).toBe('PNGDATA')
    await app.close()
  })

  it('sem arquivo no form retorna 400', async () => {
    const payload = [`--${BOUNDARY}`, 'Content-Disposition: form-data; name="nada"', '', 'valor', `--${BOUNDARY}--`, ''].join('\r\n')
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload, headers: HEADERS })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('nome malicioso é sanitizado (fica dentro do dir)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('../../etc/passwd', 'X'), headers: HEADERS })
    expect(res.statusCode).toBe(201)
    expect(res.json().path.startsWith(dir)).toBe(true)
    expect(res.json().path).not.toContain('..')
    await app.close()
  })
})
```

Run: `npm test -w server -- routes-uploads`
Expected: FAIL — `registerUploadRoutes` não existe.

- [ ] **Step 4: Implementar `server/src/routes/uploads.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { unlinkSync } from 'node:fs'
import { saveUpload, rotateUploads } from '../uploads.js'

const MAX_FILE_BYTES = 100 * 1024 * 1024 // 100 MB (decisão do spec)
const KEEP = 100

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: { uploadsDir: string },
): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } })

  app.post('/api/uploads', async (req, reply) => {
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'nenhum arquivo no form (campo "file")' })
    const saved = await saveUpload(deps.uploadsDir, part.filename ?? 'arquivo', part.file)
    // O multipart trunca silenciosamente no limite — arquivo pela metade é
    // inútil para o claude: apaga e avisa.
    if (part.file.truncated) {
      try { unlinkSync(saved.path) } catch { /* já foi */ }
      return reply.code(413).send({ error: 'arquivo grande demais (máx. 100 MB)' })
    }
    rotateUploads(deps.uploadsDir, KEEP)
    return reply.code(201).send(saved)
  })
}
```

- [ ] **Step 5: Registrar no `app.ts`**

Em `server/src/app.ts`, adicionar o import e o registro (junto dos demais, dentro de `buildApp`):
```ts
import { registerUploadRoutes } from './routes/uploads.js'
```
```ts
  await registerUploadRoutes(app, { uploadsDir: deps.config.uploadsDir })
```

- [ ] **Step 6: Rodar tudo**

Run: `npm test -w server -- routes-uploads config && npx tsc -p server --noEmit && npm test -w server`
Expected: tudo PASS; tsc limpo.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/uploads.ts server/src/config.ts server/src/app.ts server/test/routes-uploads.test.ts server/test/config.test.ts server/package.json package-lock.json
git commit -m "feat(server): POST /api/uploads com multipart (100MB) + config uploadsDir"
```

---

### Task 3: ChatInput — paste/drop, token inline no cursor, substituição no send

**Files:**
- Modify: `web/src/api.ts` (função `uploadFile`)
- Modify: `web/src/components/ChatInput.tsx` (reescrita com anexos)
- Modify: `web/src/styles.css` (classe `drag-over` + aviso)
- Test: `web/src/test/chatinput-upload.test.tsx`

**Interfaces:**
- Consumes: `POST /api/uploads` → `{ path, name }` (Task 2).
- Produces: UX final — token `[📎 <name>]` no cursor; `send()` substitui token→path.

- [ ] **Step 1: `uploadFile` na api**

Em `web/src/api.ts`, adicionar (fetch cru — o `req()` colocaria Content-Type json e quebraria o boundary):
```ts
export const uploadFile = async (file: File, name?: string): Promise<{ path: string; name: string }> => {
  const fd = new FormData()
  fd.append('file', file, name ?? file.name)
  const res = await fetch('/api/uploads', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json()
}
```

- [ ] **Step 2: Testes do ChatInput (falhando)**

Create `web/src/test/chatinput-upload.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

const okUpload = (name: string) =>
  new Response(JSON.stringify({ path: `/ups/${name}`, name }), { status: 201, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, textarea: screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('upload no ChatInput', () => {
  it('paste de arquivo insere token na posição do cursor', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('001-print.png'))
    const { textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: 'olha isso  e me diz' } })
    textarea.setSelectionRange(10, 10) // depois de "olha isso "
    const file = new File(['x'], 'print.png', { type: 'image/png' })
    fireEvent.paste(textarea, { clipboardData: { files: [file] } })
    await vi.waitFor(() => expect(textarea.value).toBe('olha isso [📎 001-print.png] e me diz'))
    expect(spy).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({ method: 'POST' }))
    spy.mockRestore()
  })

  it('send substitui o token pelo path real', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('002-log.txt'))
    const { send, textarea } = renderInput()
    const file = new File(['x'], 'log.txt', { type: 'text/plain' })
    fireEvent.paste(textarea, { clipboardData: { files: [file] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 002-log.txt]'))
    fireEvent.change(textarea, { target: { value: `analisa ${textarea.value} por favor` } })
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'analisa /ups/002-log.txt por favor' })
    spy.mockRestore()
  })

  it('token apagado pelo usuário não é substituído (anexo não vai)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('003-a.txt'))
    const { send, textarea } = renderInput()
    fireEvent.paste(textarea, { clipboardData: { files: [new File(['x'], 'a.txt')] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 003-a.txt]'))
    fireEvent.change(textarea, { target: { value: 'só texto, apaguei o anexo' } })
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'só texto, apaguei o anexo' })
    spy.mockRestore()
  })

  it('drop de arquivo insere token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('004-doc.pdf'))
    const { textarea } = renderInput()
    fireEvent.drop(textarea, { dataTransfer: { files: [new File(['x'], 'doc.pdf')] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 004-doc.pdf]'))
    spy.mockRestore()
  })

  it('erro de upload mostra aviso e não insere token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'arquivo grande demais (máx. 100 MB)' }), { status: 413, headers: { 'Content-Type': 'application/json' } }),
    )
    const { textarea } = renderInput()
    fireEvent.paste(textarea, { clipboardData: { files: [new File(['x'], 'big.iso')] } })
    await vi.waitFor(() => expect(screen.getByText(/grande demais/)).toBeTruthy())
    expect(textarea.value).toBe('')
    spy.mockRestore()
  })
})
```

Run: `npm test -w web -- chatinput-upload`
Expected: FAIL — ChatInput não tem handlers de paste/drop.

- [ ] **Step 3: Reescrever `web/src/components/ChatInput.tsx`**

```tsx
import { useContext, useRef, useState } from 'react'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { uploadFile } from '../api'

/** Token inline que marca a posição do anexo no texto até o envio. */
const token = (name: string) => `[📎 ${name}]`

export function ChatInput({ localId, disabled }: { localId: string; disabled: boolean }) {
  const ws = useContext(WsContext)
  const addLocalUserText = useStore((s) => s.addLocalUserText)
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // token → path; apagar o token do texto simplesmente deixa a entrada sem uso
  const attachments = useRef(new Map<string, string>())

  const send = () => {
    let out = text
    for (const [tok, path] of attachments.current) out = out.split(tok).join(path)
    const trimmed = out.trim()
    if (!trimmed || disabled || uploading > 0) return
    ws?.send({ type: 'send_message', localId, text: trimmed })
    addLocalUserText(localId, trimmed)
    setText('')
    setUploadError(null)
    attachments.current.clear()
  }

  const attachFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    // posição do cursor no momento do gesto — os tokens entram ali
    let pos = areaRef.current?.selectionStart ?? text.length
    for (const file of list) {
      setUploading((n) => n + 1)
      try {
        // imagem colada do clipboard vem com nome genérico — dá um nome útil
        const isPastedImage = file.name === 'image.png' || file.name === ''
        const name = isPastedImage ? `colado-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png` : undefined
        const saved = await uploadFile(file, name)
        const tok = token(saved.name)
        attachments.current.set(tok, saved.path)
        setText((t) => {
          const at = Math.min(pos, t.length)
          const next = `${t.slice(0, at)}${tok}${t.slice(at)}`
          pos = at + tok.length
          return next
        })
        setUploadError(null)
      } catch (err) {
        setUploadError((err as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  return (
    <div style={{ padding: 16, borderTop: '1px solid var(--glass-border)' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          ref={areaRef}
          className={dragOver ? 'drag-over' : undefined}
          style={{ flex: 1, resize: 'none', minHeight: 44 }}
          rows={2}
          placeholder={
            disabled ? 'sessão trabalhando…'
            : uploading > 0 ? 'enviando anexo…'
            : 'Mensagem para o Claude Code… (arraste ou cole arquivos)'
          }
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) { e.preventDefault(); void attachFiles(e.clipboardData.files) }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false)
            if (e.dataTransfer?.files?.length) void attachFiles(e.dataTransfer.files)
          }}
        />
        <button onClick={send} disabled={disabled || uploading > 0}>Enviar</button>
      </div>
      {uploadError && (
        <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>⚠ {uploadError}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: CSS do drag**

Adicionar ao fim de `web/src/styles.css`:
```css
textarea.drag-over { outline: 2px dashed var(--accent); outline-offset: -2px; }
```

- [ ] **Step 5: Rodar os testes e o build**

Run: `npm test -w web && npm run build -w web`
Expected: suíte inteira PASS (incluindo os 5 novos); build limpo.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/components/ChatInput.tsx web/src/styles.css web/src/test/chatinput-upload.test.tsx
git commit -m "feat(web): arrastar/colar arquivos no chat com token inline e path no envio"
```

---

## Self-Review

**1. Spec coverage:** sanitize/contador/rotação → Task 1 ✅; multipart 100MB + uploadsDir + 400/413 → Task 2 ✅; paste/drop/token no cursor/substituição no send/uploading/aviso de erro/rename de imagem colada → Task 3 ✅; "token apagado não vai" → coberto no send (replace não casa) + teste ✅; fora de escopo respeitado ✅.
**2. Placeholder scan:** nenhum TBD/TODO; todo passo tem código completo. ✅
**3. Type consistency:** `{ path, name }` idêntico em uploads.ts (Task 1), rota (Task 2), `uploadFile`/testes (Task 3); `registerUploadRoutes(app, { uploadsDir })` consistente entre Task 2 Steps 3-5; `token(name)` = `[📎 name]` casa com os testes. ✅
