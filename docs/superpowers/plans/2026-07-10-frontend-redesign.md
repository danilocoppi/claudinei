# Redesign do Frontend — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar task a task. Steps usam checkbox (`- [ ]`).

**Goal:** Aplicar o tema Glass/Aurora ao app inteiro e trocar a criação de projeto por seletor de pastas navegável, seletor de emojis e preview de card ao vivo.

**Architecture:** Novo endpoint só-leitura `GET /api/fs/list` no backend serve navegação de diretórios (o browser não expõe caminhos absolutos). O frontend ganha um tema de vidro em `styles.css` e componentes novos (`FolderPicker`, `EmojiPicker`, `ColorField`, `ProjectPreviewCard`) que o `NewProjectModal` reformulado consome. Modelo de dados inalterado.

**Tech Stack:** Node/TS + Fastify (backend); React 18 + Vite + TS (frontend); `emoji-picker-react` (modo `EmojiStyle.NATIVE`, sem CDN); Vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-frontend-redesign-design.md`

## Global Constraints
- TypeScript strict; ESM — imports locais terminam em `.js` (server) e sem extensão (web/bundler).
- `fs/list` é **só-leitura**, retorna **apenas diretórios**, começa na home (`os.homedir()`) quando `path` ausente; erro → HTTP 400 `{ error }`.
- `emoji-picker-react` SEMPRE em `emojiStyle={EmojiStyle.NATIVE}` e `theme={Theme.DARK}` (sem requisições de rede).
- Paleta Glass/Aurora (valores exatos abaixo, Task 3) — usar as CSS vars, não hardcode espalhado.
- Testes web em jsdom; `web/src/test/setup.ts` já provê `afterEach(cleanup)` global (não repetir localmente). Mock de `fetch` com `vi.spyOn(globalThis,'fetch').mockImplementation(() => Promise.resolve(new Response(...)))` — Response nova por chamada.
- Commits convencionais terminando com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Server escuta só 127.0.0.1. Sessões e demais features do MVP não são tocadas.

## Estrutura de arquivos
```
server/src/routes/fs.ts        # (novo) GET /api/fs/list
server/src/app.ts              # (modificar) registra fs routes
server/test/routes-fs.test.ts  # (novo)
web/src/styles.css             # (reescrito) tema Glass/Aurora
web/src/api.ts                 # (modificar) fetchDir()
web/src/components/FolderPicker.tsx       # (novo)
web/src/components/EmojiPicker.tsx         # (novo) wrapper
web/src/components/ColorField.tsx          # (novo)
web/src/components/ProjectPreviewCard.tsx  # (novo)
web/src/components/NewProjectModal.tsx     # (reformulado)
web/src/test/{folder-picker,color-field,new-project-modal}.test.tsx  # (novos)
```

---

### Task 1: Endpoint `GET /api/fs/list`

**Files:**
- Create: `server/src/routes/fs.ts`
- Modify: `server/src/app.ts` (importar e registrar)
- Test: `server/test/routes-fs.test.ts`

**Interfaces:**
- Consumes: `buildApp` (AppDeps) já existente.
- Produces: `registerFsRoutes(app: FastifyInstance): void`. Rota `GET /api/fs/list?path=<abs>` → 200 `{ path: string; parent: string | null; entries: { name: string; path: string; isDir: true }[] }` ou 400 `{ error }`.

- [ ] **Step 1: Teste que falha**

`server/test/routes-fs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
})

describe('GET /api/fs/list', () => {
  it('lista apenas subdiretórios (ignora arquivos), com parent e paths absolutos', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fs-'))
    mkdirSync(join(base, 'sub-a'))
    mkdirSync(join(base, 'sub-b'))
    writeFileSync(join(base, 'arquivo.txt'), 'x')
    const res = await app.inject({ method: 'GET', url: `/api/fs/list?path=${encodeURIComponent(base)}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.path).toBe(base)
    expect(body.parent).toBe(join(base, '..'))
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('sub-a')
    expect(names).toContain('sub-b')
    expect(names).not.toContain('arquivo.txt')
    expect(body.entries.every((e: any) => e.isDir === true)).toBe(true)
    expect(body.entries.every((e: any) => e.path.startsWith(base))).toBe(true)
  })

  it('sem path usa o home do usuário', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe(homedir())
  })

  it('path inexistente retorna 400 com error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=/nao/existe/xyz-123' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('parent é null na raiz do filesystem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list?path=/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().parent).toBeNull()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo `routes/fs` / rota não existe (404).

- [ ] **Step 3: Implementar**

`server/src/routes/fs.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'

export function registerFsRoutes(app: FastifyInstance): void {
  app.get('/api/fs/list', async (req, reply) => {
    const q = (req.query as { path?: string }).path
    const target = q && q.trim() ? resolve(q) : homedir()
    let st
    try {
      st = statSync(target)
    } catch {
      return reply.code(400).send({ error: `diretório não acessível: ${target}` })
    }
    if (!st.isDirectory()) {
      return reply.code(400).send({ error: `não é um diretório: ${target}` })
    }
    let names: string[]
    try {
      names = readdirSync(target)
    } catch {
      return reply.code(400).send({ error: `sem permissão de leitura: ${target}` })
    }
    const insideHidden = /(^|\/)\.[^/]*$/.test(target)
    const entries = names
      .filter((n) => insideHidden || !n.startsWith('.'))
      .map((name) => ({ name, path: join(target, name) }))
      .filter((e) => {
        try { return statSync(e.path).isDirectory() } catch { return false }
      })
      .map((e) => ({ name: e.name, path: e.path, isDir: true as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = target === '/' ? null : join(target, '..')
    return { path: target, parent, entries }
  })
}
```

Em `server/src/app.ts`: adicionar `import { registerFsRoutes } from './routes/fs.js'` e, após `registerSessionRoutes(app, deps)`, chamar `registerFsRoutes(app)`.

Nota: o teste espera `parent === join(base,'..')` (forma não-normalizada, ex.: `/tmp/fs-x/..`). `join(target,'..')` produz `/tmp` normalizado — CORRIJA o teste OU o código para casarem. Decisão do plano: normalizar no código com `dirname(target)` e ajustar o teste para `dirname(base)`. Reescreva a linha do parent como:
```ts
const parent = target === '/' ? null : dirname(target)
```
e no teste troque `expect(body.parent).toBe(join(base, '..'))` por `expect(body.parent).toBe(dirname(base))` (importe `dirname` de `node:path` no teste).

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS (todas as 4).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/fs.ts server/src/app.ts server/test/routes-fs.test.ts
git commit -m "feat: endpoint fs/list para navegação de diretórios"
```

---

### Task 2: Cliente `fetchDir` no frontend

**Files:**
- Modify: `web/src/api.ts`
- Test: coberto indiretamente pelo FolderPicker (Task 5); sem teste dedicado (função fina de `fetch`).

**Interfaces:**
- Consumes: rota `/api/fs/list` (Task 1).
- Produces: `interface DirListing { path: string; parent: string | null; entries: { name: string; path: string; isDir: boolean }[] }` e `fetchDir(path?: string): Promise<DirListing>`.

- [ ] **Step 1: Implementar (função fina, sem TDD dedicado)**

Em `web/src/api.ts`, adicionar ao final:
```ts
export interface DirEntry { name: string; path: string; isDir: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export const fetchDir = (path?: string) =>
  req<DirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`)
```
(`req` é o helper existente que lança `Error(body.error)` em não-2xx.)

- [ ] **Step 2: Verificar build de tipos**

Run: `npm run build -w web` (ou `npx tsc --noEmit -p web/tsconfig.json`)
Expected: sem erros de tipo.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat: cliente fetchDir para o seletor de pastas"
```

---

### Task 3: Tema Glass/Aurora (styles.css)

**Files:**
- Modify: `web/src/styles.css` (reescrito)
- Test: `web/src/test/smoke.test.tsx` já existe e deve continuar passando (o App renderiza).

**Interfaces:**
- Consumes: nada.
- Produces: as MESMAS classes já usadas pelos componentes (`.app`, `.sidebar`, `.main`, `.card`, `.badge`, `.status-*`, `button`, `button.ghost`, `input/select/textarea`) reestilizadas, MAIS utilitários novos: `.glass`, `.glass-strong`, `.modal-overlay`. Variáveis CSS novas: `--glass-bg`, `--glass-border`, `--glass-blur`, além das já existentes recolorizadas.

- [ ] **Step 1: Reescrever styles.css**

`web/src/styles.css` (substitui todo o conteúdo):
```css
:root {
  --bg: #0b0d16;
  --text: #eef0f8; --text-dim: #9aa0bd;
  --accent: #7c5cff; --accent-2: #5ee0a0;
  --ok: #5ee0a0; --warn: #f5c451; --err: #ff6b8b;
  --glass-bg: rgba(255,255,255,.06);
  --glass-bg-strong: rgba(255,255,255,.10);
  --glass-border: rgba(255,255,255,.14);
  --glass-blur: 14px;
  --radius: 16px;
}
* { box-sizing: border-box; }
body {
  margin: 0; color: var(--text); font-family: system-ui, -apple-system, sans-serif;
  background:
    radial-gradient(1200px 600px at 8% -8%, #3b2b6b 0%, transparent 58%),
    radial-gradient(1000px 620px at 108% 6%, #1e5f74 0%, transparent 55%),
    radial-gradient(900px 700px at 50% 120%, #2a1c4d 0%, transparent 60%),
    var(--bg);
  background-attachment: fixed;
}
.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
}
.glass-strong { background: var(--glass-bg-strong); }
.app { display: flex; height: 100vh; }
.sidebar {
  width: 250px; padding: 14px; overflow-y: auto;
  background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));
  border-right: 1px solid var(--glass-border);
}
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.status-idle { background: var(--text-dim); }
.status-working { background: var(--accent); box-shadow: 0 0 10px var(--accent); animation: pulse 1.2s infinite; }
.status-needs_attention { background: var(--warn); box-shadow: 0 0 10px var(--warn); }
.status-dead { background: var(--err); box-shadow: 0 0 10px var(--err); }
.status-stopped { background: #667; }
.status-starting { background: var(--accent); opacity: .5; }
@keyframes pulse { 50% { opacity: .4; } }
.badge { background: var(--err); color: #fff; border-radius: 12px; font-size: 11px; padding: 2px 8px; box-shadow: 0 0 10px rgba(255,107,139,.5); }
.card {
  background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border); border-radius: var(--radius); padding: 18px; cursor: pointer;
  box-shadow: 0 8px 32px rgba(0,0,0,.32); transition: transform .15s, background .15s;
}
.card:hover { background: var(--glass-bg-strong); transform: translateY(-3px); }
button {
  background: linear-gradient(135deg, var(--accent), #9a7bff); border: 0; color: #fff;
  border-radius: 10px; padding: 9px 16px; cursor: pointer; font-weight: 600; transition: filter .15s;
}
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: not-allowed; filter: none; }
button.ghost { background: transparent; border: 1px solid var(--glass-border); color: var(--text); font-weight: 500; }
input, select, textarea {
  background: rgba(0,0,0,.25); border: 1px solid var(--glass-border); color: var(--text);
  border-radius: 10px; padding: 9px 11px; font-family: inherit;
}
input:focus, textarea:focus { outline: none; border-color: var(--accent); }
.modal-overlay {
  position: fixed; inset: 0; background: rgba(5,6,12,.6); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
.markdown code { background: rgba(0,0,0,.35); padding: 1px 5px; border-radius: 5px; }
.markdown pre { background: rgba(0,0,0,.35); padding: 12px; border-radius: 10px; overflow-x: auto; }
```

- [ ] **Step 2: Rodar smoke + verificar visual**

Run: `npm test -w web`
Expected: PASS (smoke e demais continuam verdes — só CSS mudou).

- [ ] **Step 3: Commit**

```bash
git add web/src/styles.css
git commit -m "feat: tema glass/aurora no styles.css"
```

---

### Task 4: Migrar estilos-chave do chat para o tema

**Files:**
- Modify: `web/src/components/MessageBlock.tsx`, `web/src/components/ChatView.tsx`, `web/src/components/ToolCallCard.tsx`
- Test: `web/src/test/message-block.test.tsx` e `web/src/test/toolcall.test.tsx` já existem — devem continuar passando (mudança visual não altera texto/estrutura testada).

**Interfaces:**
- Consumes: classes/vars do tema (Task 3).
- Produces: nenhuma nova interface — apenas coesão visual.

- [ ] **Step 1: Ajustar superfícies inline para vidro**

Em `ToolCallCard.tsx`, no contêiner externo do card, trocar `background: 'var(--bg-panel)'` por `background: 'var(--glass-bg)'` e adicionar `backdropFilter: 'blur(8px)'` e `border: '1px solid var(--glass-border)'`. Nos `<pre>` de input/resultado, trocar `background: 'var(--bg)'` por `background: 'rgba(0,0,0,.3)'`.

Em `ChatView.tsx`, o header e a barra de input: trocar `borderBottom/borderTop: '1px solid var(--border)'` por `'1px solid var(--glass-border)'`.

Em `MessageBlock.tsx`, a bolha `user_text`: manter `background: 'var(--accent)'`; o `thinking` e o `turn_end` usam `var(--text-dim)`/`var(--border)` — trocar `var(--border)` por `var(--glass-border)`.

(Essas vars antigas `--bg-panel`/`--border` não existem mais após a Task 3; qualquer referência remanescente a elas renderiza transparente — este passo elimina as visíveis. Faça uma busca `grep -rn "var(--bg-panel)\|var(--border)\|var(--bg-hover)" web/src` e troque todas por equivalentes do tema: `--bg-panel`→`--glass-bg`, `--border`→`--glass-border`, `--bg-hover`→`--glass-bg-strong`, `--bg`→`rgba(0,0,0,.25)` conforme o contexto.)

- [ ] **Step 2: Rodar testes**

Run: `npm test -w web`
Expected: PASS (component tests inalterados).

- [ ] **Step 3: Verificar ausência de vars órfãs**

Run: `grep -rn "var(--bg-panel)\|var(--bg-hover)" web/src || echo "sem vars órfãs"`
Expected: `sem vars órfãs` (a `--border` pode permanecer só se você tiver decidido mantê-la; preferir `--glass-border`).

- [ ] **Step 4: Commit**

```bash
git add web/src/components
git commit -m "refactor: migra superfícies do chat para o tema glass"
```

---

### Task 5: FolderPicker

**Files:**
- Create: `web/src/components/FolderPicker.tsx`
- Test: `web/src/test/folder-picker.test.tsx`

**Interfaces:**
- Consumes: `fetchDir`/`DirListing` (Task 2), `.glass`/`.modal-overlay` (Task 3).
- Produces: `FolderPicker({ initialPath?: string; onSelect: (path: string) => void; onClose: () => void })`.

- [ ] **Step 1: Teste que falha**

`web/src/test/folder-picker.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderPicker } from '../components/FolderPicker'

const listing = (path: string, parent: string | null, dirs: string[]) =>
  new Response(JSON.stringify({ path, parent, entries: dirs.map((d) => ({ name: d, path: `${path}/${d}`, isDir: true })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
    const u = String(url)
    if (u.includes('sub-a')) return Promise.resolve(listing('/home/u/sub-a', '/home/u', []))
    return Promise.resolve(listing('/home/u', '/home', ['sub-a', 'sub-b']))
  })
})

describe('FolderPicker', () => {
  it('lista subpastas do diretório inicial', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('sub-a')).toBeTruthy())
    expect(screen.getByText('sub-b')).toBeTruthy()
  })

  it('clicar numa subpasta navega para ela', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    fireEvent.click(screen.getByText('sub-a'))
    await waitFor(() => expect(screen.getByText('/home/u/sub-a')).toBeTruthy())
  })

  it('"Selecionar esta pasta" devolve o caminho atual', async () => {
    const onSelect = vi.fn()
    render(<FolderPicker onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    expect(onSelect).toHaveBeenCalledWith('/home/u')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — módulo FolderPicker não existe.

- [ ] **Step 3: Implementar**

`web/src/components/FolderPicker.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { fetchDir, type DirListing } from '../api'

export function FolderPicker({ initialPath, onSelect, onClose }: {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')

  const load = (path?: string) => {
    fetchDir(path)
      .then((l) => { setListing(l); setError('') })
      .catch((e) => setError((e as Error).message))
  }

  useEffect(() => { load(initialPath) }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass" style={{ width: 520, maxHeight: '70vh', borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', cursor: 'default' }}
           onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Escolher pasta</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <button className="ghost" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>⬆ Subir</button>
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {listing?.path ?? '…'}
          </span>
        </div>
        {error && <div style={{ color: 'var(--err)', marginBottom: 8 }}>{error}</div>}
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--glass-border)', borderRadius: 10 }}>
          {listing?.entries.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)' }}>Nenhuma subpasta.</div>}
          {listing?.entries.map((e) => (
            <div key={e.path} onClick={() => load(e.path)}
                 style={{ padding: '9px 12px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
                 onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--glass-bg-strong)')}
                 onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}>
              <span>📁</span><span>{e.name}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost" onClick={onClose}>Cancelar</button>
          <button disabled={!listing} onClick={() => listing && onSelect(listing.path)}>Selecionar esta pasta</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FolderPicker.tsx web/src/test/folder-picker.test.tsx
git commit -m "feat: FolderPicker navegável servido pelo backend"
```

---

### Task 6: EmojiPicker + ColorField

**Files:**
- Create: `web/src/components/EmojiPicker.tsx`, `web/src/components/ColorField.tsx`
- Modify: `web/package.json` (dep `emoji-picker-react`)
- Test: `web/src/test/color-field.test.tsx` (o EmojiPicker é um wrapper fino de lib — teste só o wiring do callback com um mock da lib)

**Interfaces:**
- Consumes: `emoji-picker-react`.
- Produces:
  - `EmojiPicker({ onSelect: (emoji: string) => void; onClose: () => void })`
  - `ColorField({ value: string; onChange: (hex: string) => void })`

- [ ] **Step 1: Instalar dependência**

Run: `npm install emoji-picker-react -w web`
Expected: adicionada a `web/package.json` dependencies.

- [ ] **Step 2: Teste que falha (ColorField)**

`web/src/test/color-field.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ColorField } from '../components/ColorField'

describe('ColorField', () => {
  it('mostra o hex atual e emite mudança', () => {
    const onChange = vi.fn()
    render(<ColorField value="#ff0000" onChange={onChange} />)
    expect(screen.getByText('#ff0000')).toBeTruthy()
    const input = screen.getByLabelText('cor') as HTMLInputElement
    fireEvent.input(input, { target: { value: '#00ff00' } })
    expect(onChange).toHaveBeenCalledWith('#00ff00')
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — ColorField não existe.

- [ ] **Step 4: Implementar ambos**

`web/src/components/ColorField.tsx`:
```tsx
export function ColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Cor</span>
      <input aria-label="cor" type="color" value={value} onChange={(e) => onChange(e.target.value)}
             style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
      <span style={{ width: 22, height: 22, borderRadius: 6, background: value, border: '1px solid var(--glass-border)' }} />
      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{value}</span>
    </label>
  )
}
```

`web/src/components/EmojiPicker.tsx`:
```tsx
import Picker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'

export function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Picker
          emojiStyle={EmojiStyle.NATIVE}
          theme={Theme.DARK}
          onEmojiClick={(data: EmojiClickData) => { onSelect(data.emoji); onClose() }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS (ColorField). O EmojiPicker é validado no smoke da Task 8 (a lib renderiza em jsdom; não escrever teste que dependa do DOM interno da lib).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ColorField.tsx web/src/components/EmojiPicker.tsx web/package.json package-lock.json web/src/test/color-field.test.tsx
git commit -m "feat: EmojiPicker (native) e ColorField com swatch"
```

---

### Task 7: ProjectPreviewCard + NewProjectModal reformulado

**Files:**
- Create: `web/src/components/ProjectPreviewCard.tsx`
- Modify: `web/src/components/NewProjectModal.tsx`
- Test: `web/src/test/new-project-modal.test.tsx`

**Interfaces:**
- Consumes: `FolderPicker` (5), `EmojiPicker`/`ColorField` (6), `createProject`/`fetchProjects` (api), `useStore`.
- Produces: `ProjectPreviewCard({ name: string; icon: string; color: string })`.

- [ ] **Step 1: Teste que falha**

`web/src/test/new-project-modal.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewProjectModal } from '../components/NewProjectModal'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: any, init: any) => {
    const u = String(url)
    if (u.includes('/api/fs/list')) {
      return Promise.resolve(new Response(JSON.stringify({ path: '/home/u', parent: '/home', entries: [{ name: 'proj', path: '/home/u/proj', isDir: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    if (u.endsWith('/api/projects') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ id: 1, name: 'P', path: '/home/u/proj', color: '#7c5cff', icon: '📁' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })
})

describe('NewProjectModal', () => {
  it('preview reflete o nome digitado', () => {
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Meu App' } })
    // o preview mostra o nome
    expect(screen.getAllByText('Meu App').length).toBeGreaterThan(0)
  })

  it('escolher pasta pelo FolderPicker preenche o caminho e permite criar', async () => {
    const onClose = vi.fn()
    render(<NewProjectModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'P' } })
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    await waitFor(() => expect(screen.getByText('/home/u')).toBeTruthy())
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sem pasta escolhida, Criar fica desabilitado', () => {
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'P' } })
    expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — placeholder/estrutura nova não existe.

- [ ] **Step 3: Implementar ProjectPreviewCard**

`web/src/components/ProjectPreviewCard.tsx`:
```tsx
export function ProjectPreviewCard({ name, icon, color }: { name: string; icon: string; color: string }) {
  return (
    <div className="card" style={{ borderLeft: `4px solid ${color}`, cursor: 'default' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <strong style={{ flex: 1 }}>{name || 'Nome do projeto'}</strong>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>pré-visualização</div>
    </div>
  )
}
```

- [ ] **Step 4: Reescrever NewProjectModal**

`web/src/components/NewProjectModal.tsx`:
```tsx
import { useState } from 'react'
import { createProject, fetchProjects } from '../api'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { EmojiPicker } from './EmojiPicker'
import { ColorField } from './ColorField'
import { ProjectPreviewCard } from './ProjectPreviewCard'

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const setProjects = useStore((s) => s.setProjects)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [icon, setIcon] = useState('📁')
  const [color, setColor] = useState('#7c5cff')
  const [error, setError] = useState('')
  const [showFolder, setShowFolder] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)

  const submit = async () => {
    try {
      await createProject({ name, path, icon, color })
      setProjects(await fetchProjects())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass" style={{ width: 460, borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Novo projeto</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input placeholder="Nome do projeto" value={name} onChange={(e) => setName(e.target.value)} />

          <button className="ghost" style={{ textAlign: 'left' }} onClick={() => setShowFolder(true)}>
            {path ? `📁 ${path}` : 'Escolher pasta…'}
          </button>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="ghost" onClick={() => setShowEmoji(true)} style={{ fontSize: 20, width: 48 }}>{icon}</button>
            <ColorField value={color} onChange={setColor} />
          </div>

          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Prévia</div>
            <ProjectPreviewCard name={name} icon={icon} color={color} />
          </div>

          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={onClose}>Cancelar</button>
            <button disabled={!name || !path} onClick={submit}>Criar</button>
          </div>
        </div>
      </div>

      {showFolder && (
        <FolderPicker
          onSelect={(p) => { setPath(p); setShowFolder(false) }}
          onClose={() => setShowFolder(false)}
        />
      )}
      {showEmoji && (
        <EmojiPicker onSelect={(e) => setIcon(e)} onClose={() => setShowEmoji(false)} />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ProjectPreviewCard.tsx web/src/components/NewProjectModal.tsx web/src/test/new-project-modal.test.tsx
git commit -m "feat: novo modal de projeto com folder picker, emoji picker, cor e preview"
```

---

### Task 8: Smoke visual + verificação do incremento

**Files:**
- Nenhum de produção; possível `docs/superpowers/verificacao-redesign.md`.

- [ ] **Step 1: Suítes completas verdes**

Run: `npm test` (raiz: server + web)
Expected: tudo passa.

- [ ] **Step 2: Smoke visual (o controlador executa)**

Subir `npm run dev`, abrir `http://localhost:5173`, e verificar com navegador:
- Tema Glass/Aurora visível em dashboard, sidebar e chat (fundo aurora, cards de vidro).
- "+ Novo projeto": modal de vidro; "Escolher pasta…" abre o FolderPicker na home, navega e seleciona; o caminho preenche.
- Botão de emoji abre o EmojiPicker (nativo), busca funciona, selecionar fecha e atualiza.
- ColorField mostra swatch + hex e muda a cor; o ProjectPreviewCard reflete nome/ícone/cor ao vivo.
- Criar o projeto e vê-lo no dashboard com o novo visual.

- [ ] **Step 3: Registrar verificação**

`docs/superpowers/verificacao-redesign.md` com checklist marcado.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/verificacao-redesign.md
git commit -m "docs: verificação do redesign de frontend"
```

## Notas de execução
- Executar em ordem; cada task termina com testes verdes + commit.
- A Task 3 remove as vars antigas (`--bg-panel`, `--border`, `--bg-hover`); a Task 4 varre e substitui referências órfãs — não pular a Task 4 ou o chat fica com superfícies transparentes.
- `emoji-picker-react` sempre em `EmojiStyle.NATIVE` (sem rede). Se o build reclamar de tipos do pacote, garantir que a versão instalada exporta `EmojiStyle`/`Theme`/`EmojiClickData` (v4+).
- Não tocar em lógica de sessão/manager/ws — este plano é só apresentação/criação de projeto.
