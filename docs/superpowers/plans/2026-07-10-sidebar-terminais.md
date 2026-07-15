# Sidebar "Terminais" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sidebar redesenhada: logo no topo, título "Terminais" + botão "+ Terminal", mini-cards de projeto (cor/ícone/status/reviver/editar/deletar) com drag & drop persistido, e Mural+Tarefas num card "Interação entre terminais" no rodapé.

**Architecture:** Backend ganha `sort_order` em projects + `PUT /api/projects/order`; `list()` passa a ordenar por ele. Front: `api.updateProject`/`reorderProjects`; `NewProjectModal` ganha modo edição; `Dashboard` perde o botão de criar; `Sidebar.tsx` é reescrita com os mini-cards e drag & drop HTML5 nativo (sem lib).

**Tech Stack:** Fastify 5 + better-sqlite3, vitest; React 18 + zustand, testing-library. Tema Glass/Aurora existente (vars `--glass-*`, `--accent`, `--text-dim`).

## Global Constraints

- Drag & drop **nativo HTML5** — nenhuma lib nova.
- `sort_order`: ALTER defensivo + backfill `= id`; `list()` ordena `sort_order ASC, id ASC`; `create()` usa `MAX(sort_order)+1`.
- `PUT /api/projects/order` body `{ ids: number[] }`; inválido → 400; ids desconhecidos ignorados (UPDATE no-op); o front sempre envia a lista completa.
- Edição via `PATCH /api/projects/:id` (rota existente); modal edita só name/color/icon — **path travado**.
- Ações do mini-card visíveis no hover **e** em `:focus-within` (teclado).
- ESM + TS strict, imports `.js` no server. Testes: vitest.
- Estética: coesa com Glass/Aurora — eyebrow uppercase com tracking largo, cards glass com barra de cor de 3px, hover eleva/revela, indicador de drop com `--accent`.

---

### Task 1: Backend — sort_order + PUT /api/projects/order

**Files:**
- Modify: `server/src/db.ts` (ALTER + backfill)
- Modify: `server/src/projects.ts` (list/create/reorder)
- Modify: `server/src/routes/projects.ts` (rota PUT /order)
- Test: `server/test/projects-order.test.ts` (create)

**Interfaces:**
- Produces:
  - `Project` (inalterado — sort_order não é exposto no tipo)
  - `svc.reorder(ids: number[]): Project[]` (retorna a lista já reordenada)
  - `PUT /api/projects/order` `{ ids: number[] }` → `200 Project[]`; body inválido → 400

- [ ] **Step 1: Testes (falhando)**

Create `server/test/projects-order.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { registerProjectRoutes } from '../src/routes/projects.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

const mk = (svc: ReturnType<typeof createProjectsService>, name: string) =>
  svc.create({ name, path: mkdtempSync(join(tmpdir(), 'tm-')) })

describe('ordenação de projetos', () => {
  it('create dá sort_order incremental e list respeita a ordem', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'Alpha')
    const c = mk(svc, 'Charlie')
    const b = mk(svc, 'Bravo')
    // ordem de criação, NÃO alfabética
    expect(svc.list().map((p) => p.id)).toEqual([a.id, c.id, b.id])
  })

  it('reorder persiste a nova ordem e ignora ids desconhecidos', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A'); const b = mk(svc, 'B'); const c = mk(svc, 'C')
    const out = svc.reorder([c.id, a.id, 999, b.id])
    expect(out.map((p) => p.id)).toEqual([c.id, a.id, b.id])
    expect(svc.list().map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  it('migração: projetos antigos (sort_order NULL) recebem sort_order = id', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A')
    db.prepare('UPDATE projects SET sort_order = NULL WHERE id = ?').run(a.id)
    // reabrir o schema roda o backfill
    db.exec(`UPDATE projects SET sort_order = id WHERE sort_order IS NULL`)
    expect(svc.list().map((p) => p.id)).toEqual([a.id])
  })
})

describe('PUT /api/projects/order', () => {
  const makeApp = async () => {
    const app = Fastify()
    registerProjectRoutes(app, { db, manager: { hasActiveSession: () => false } as any })
    return app
  }

  it('reordena e devolve a lista', async () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A'); const b = mk(svc, 'B')
    const app = await makeApp()
    const res = await app.inject({ method: 'PUT', url: '/api/projects/order', payload: { ids: [b.id, a.id] } })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: any) => p.id)).toEqual([b.id, a.id])
    await app.close()
  })

  it('body inválido → 400', async () => {
    const app = await makeApp()
    for (const payload of [{}, { ids: 'x' }, { ids: [1, 'dois'] }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/projects/order', payload })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- projects-order`
Expected: FAIL — `reorder` não existe; list vem alfabética.

- [ ] **Step 3: Migração no `db.ts`**

Em `server/src/db.ts`, junto dos ALTERs defensivos existentes, adicionar:
```ts
  try { db.exec(`ALTER TABLE projects ADD COLUMN sort_order INTEGER`) } catch { /* já existe */ }
  db.exec(`UPDATE projects SET sort_order = id WHERE sort_order IS NULL`)
```
(o UPDATE roda sempre — é idempotente e cobre rows antigas.)

- [ ] **Step 4: Service `projects.ts`**

Em `server/src/projects.ts`:
- `list()` passa a: `SELECT * FROM projects ORDER BY sort_order ASC, id ASC`
- `create()`: antes do INSERT, calcular a posição e incluir a coluna:
```ts
      const nextOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM projects`).get() as any).n
      const info = db
        .prepare(`INSERT INTO projects (name, path, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)`)
        .run(input.name, input.path, input.color ?? '#7c5cff', input.icon ?? '📁', nextOrder)
```
- Novo método (após `update`):
```ts
    /** Persiste a ordem dada (índice = posição). Ids desconhecidos são no-op; o front envia a lista completa. */
    reorder(ids: number[]): Project[] {
      const upd = db.prepare(`UPDATE projects SET sort_order = ? WHERE id = ?`)
      const tx = db.transaction((list: number[]) => {
        list.forEach((id, i) => upd.run(i + 1, id))
      })
      tx(ids)
      return this.list()
    },
```

- [ ] **Step 5: Rota em `routes/projects.ts`**

Adicionar após o `app.post('/api/projects', ...)` (e ANTES do `app.patch('/api/projects/:id', ...)` por clareza — métodos diferentes, sem conflito de rota):
```ts
  app.put('/api/projects/order', async (req, reply) => {
    const body = req.body as { ids?: unknown }
    if (!Array.isArray(body?.ids) || !body.ids.every((n) => Number.isInteger(n))) {
      return reply.code(400).send({ error: 'ids deve ser uma lista de números' })
    }
    return svc.reorder(body.ids as number[])
  })
```

- [ ] **Step 6: Rodar tudo**

Run: `npm test -w server -- projects-order && npm test -w server && npx tsc -p server --noEmit`
Expected: novos testes PASS; suíte inteira verde (nenhum teste existente depende da ordem alfabética — se algum quebrar por ordem, ajustá-lo para ordem de criação e anotar no report); tsc limpo.

- [ ] **Step 7: Commit**

```bash
git add server/src/db.ts server/src/projects.ts server/src/routes/projects.ts server/test/projects-order.test.ts
git commit -m "feat(server): sort_order em projects + PUT /api/projects/order"
```

---

### Task 2: api front + NewProjectModal modo edição + Dashboard sem botão

**Files:**
- Modify: `web/src/api.ts` (`updateProject`, `reorderProjects`)
- Modify: `web/src/components/NewProjectModal.tsx` (prop `editProject`)
- Modify: `web/src/components/Dashboard.tsx` (remove botão/modal de criar)
- Test: `web/src/test/new-project-modal.test.tsx` (caso de edição), `web/src/test/dashboard.test.tsx` (sem botão)

**Interfaces:**
- Consumes: `PUT /api/projects/order` → `Project[]`; `PATCH /api/projects/:id` → `Project` (Task 1 / rota existente).
- Produces:
  - `updateProject(id: number, patch: { name?: string; color?: string; icon?: string }): Promise<Project>`
  - `reorderProjects(ids: number[]): Promise<Project[]>`
  - `NewProjectModal({ onClose, editProject? })` — com `editProject`: título "Editar terminal", path exibido travado, botão "Salvar" → PATCH.

- [ ] **Step 1: api.ts**

Adicionar após `deleteProject`:
```ts
export const updateProject = (id: number, patch: { name?: string; color?: string; icon?: string }) =>
  req<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const reorderProjects = (ids: number[]) =>
  req<Project[]>('/api/projects/order', { method: 'PUT', body: JSON.stringify({ ids }) })
```

- [ ] **Step 2: Teste do modo edição (falhando)**

Adicionar em `web/src/test/new-project-modal.test.tsx` (conferir imports existentes do arquivo; adicionar `vi` se faltar):
```tsx
it('modo edição: pré-preenche, trava o path e salva via PATCH', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ id: 7, name: 'Novo Nome', path: '/tmp/x', color: '#111111', icon: '🚀' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
  render(<NewProjectModal onClose={() => {}} editProject={{ id: 7, name: 'Velho', path: '/tmp/x', color: '#222222', icon: '📁' }} />)
  expect(screen.getByText('Editar terminal')).toBeTruthy()
  expect((screen.getByPlaceholderText('Nome do projeto') as HTMLInputElement).value).toBe('Velho')
  expect(screen.getByText('/tmp/x')).toBeTruthy() // path visível mas não clicável p/ trocar
  fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Novo Nome' } })
  fireEvent.click(screen.getByText('Salvar'))
  await vi.waitFor(() =>
    expect(spy).toHaveBeenCalledWith('/api/projects/7', expect.objectContaining({ method: 'PATCH' })))
  spy.mockRestore()
})
```

- [ ] **Step 3: Rodar para ver falhar**

Run: `npm test -w web -- new-project-modal`
Expected: FAIL — prop `editProject` não existe.

- [ ] **Step 4: NewProjectModal com modo edição**

Reescrever o cabeçalho e o submit de `web/src/components/NewProjectModal.tsx`:
```tsx
import { useState } from 'react'
import type { Project } from '../types'
import { createProject, updateProject, fetchProjects } from '../api'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { EmojiPicker } from './EmojiPicker'
import { ColorField } from './ColorField'
import { ProjectPreviewCard } from './ProjectPreviewCard'

export function NewProjectModal({ onClose, editProject }: { onClose: () => void; editProject?: Project }) {
  const setProjects = useStore((s) => s.setProjects)
  const [name, setName] = useState(editProject?.name ?? '')
  const [path, setPath] = useState(editProject?.path ?? '')
  const [icon, setIcon] = useState(editProject?.icon ?? '📁')
  const [color, setColor] = useState(editProject?.color ?? '#7c5cff')
  const [error, setError] = useState('')
  const [showFolder, setShowFolder] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)

  const submit = async () => {
    try {
      if (editProject) await updateProject(editProject.id, { name, icon, color })
      else await createProject({ name, path, icon, color })
      setProjects(await fetchProjects())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
```
No JSX: título `{editProject ? 'Editar terminal' : 'Novo projeto'}`; o botão de pasta vira, no modo edição, um texto travado:
```tsx
          {editProject ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '8px 2px' }}>📁 <span>{path}</span></div>
          ) : (
            <button className="ghost" style={{ textAlign: 'left' }} onClick={() => setShowFolder(true)}>
              {path ? <>📁 <span>{path}</span></> : 'Escolher pasta…'}
            </button>
          )}
```
E o botão de confirmar: `{editProject ? 'Salvar' : 'Criar'}` com `disabled={!name || !path}` inalterado. O resto (EmojiPicker, ColorField, Prévia, FolderPicker) permanece.

- [ ] **Step 5: Dashboard sem o botão**

Em `web/src/components/Dashboard.tsx`: remover `useState`, o botão `+ Novo projeto`, o `{showModal && <NewProjectModal .../>}` e o import de `NewProjectModal`/`useState`. O header vira só `<h2 style={{ margin: 0 }}>Projetos</h2>`. Ajustar `web/src/test/dashboard.test.tsx` se ele referenciar o botão (verificar com grep e remover a asserção correspondente).

- [ ] **Step 6: Rodar e commitar**

Run: `npm test -w web && npm run build -w web`
Expected: tudo PASS; build limpo.

```bash
git add web/src/api.ts web/src/components/NewProjectModal.tsx web/src/components/Dashboard.tsx web/src/test/new-project-modal.test.tsx web/src/test/dashboard.test.tsx
git commit -m "feat(web): NewProjectModal com modo edição; api update/reorder; Dashboard sem botão de criar"
```

---

### Task 3: Sidebar reescrita — mini-cards, drag & drop, card de interação

**Files:**
- Modify: `web/src/components/Sidebar.tsx` (reescrita completa)
- Modify: `web/src/styles.css` (classes novas + flex na .sidebar)
- Test: `web/src/test/sidebar.test.tsx` (create)

**Interfaces:**
- Consumes: `reviveSession`, `deleteProject`, `reorderProjects`, `fetchProjects` (api); `NewProjectModal` com `editProject` (Task 2); `StartSessionModal({ project, onClose })`; `ConfirmDialog` existente; store (`projects, sessions, unread, activeLocalId, view, openSession, openTerminal, openDashboard, openMural, openTasks, setProjects`).

- [ ] **Step 1: Testes (falhando)**

Create `web/src/test/sidebar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { SessionInfo } from '../types'

const sess = (localId: string, projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId, status, claudeSessionId: 'c', updatedAt: 'x' })

beforeEach(() => {
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '🅰️' },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '🅱️' },
    ],
    sessions: { s1: sess('s1', 1, 'stopped') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined,
  })
})
afterEach(() => cleanup())

describe('Sidebar Terminais', () => {
  it('lista TODOS os projetos (com e sem sessão) e o card de interação', () => {
    render(<Sidebar />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText(/Interação entre terminais/i)).toBeTruthy()
    expect(screen.getByText('Mural')).toBeTruthy()
    expect(screen.getByText('Tarefas')).toBeTruthy()
    expect(screen.getByText('Terminais')).toBeTruthy()
  })

  it('sessão stopped mostra Reviver e chama POST /revive', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ localId: 's1', status: 'starting' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Reviver'))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/sessions/s1/revive', expect.objectContaining({ method: 'POST' })))
    spy.mockRestore()
  })

  it('projeto sem sessão mostra Iniciar (abre o StartSessionModal)', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Iniciar sessão'))
    expect(screen.getByText(/Nova sessão/)).toBeTruthy()
  })

  it('lápis abre o modal em modo edição', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getAllByTitle('Editar')[0])
    expect(screen.getByText('Editar terminal')).toBeTruthy()
  })

  it('"+ Terminal" abre o modal de criação', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Terminal'))
    expect(screen.getByText('Novo projeto')).toBeTruthy()
  })

  it('drop persiste a nova ordem via PUT /order', async () => {
    const reordered = [
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '🅱️' },
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '🅰️' },
    ]
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(reordered), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(<Sidebar />)
    const cards = screen.getAllByTestId('term-card')
    fireEvent.dragStart(cards[0])
    fireEvent.dragOver(cards[1])
    fireEvent.drop(cards[1])
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/projects/order', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ids: [2, 1] }) })))
    expect(useStore.getState().projects.map((p) => p.id)).toEqual([2, 1])
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w web -- sidebar`
Expected: FAIL — a Sidebar atual não tem nada disso.

- [ ] **Step 3: Reescrever `web/src/components/Sidebar.tsx`**

```tsx
import { useState } from 'react'
import type { Project, SessionInfo } from '../types'
import { STATUS_LABEL } from '../types'
import { deleteProject, fetchProjects, reorderProjects, reviveSession } from '../api'
import { useStore } from '../store'
import { NewProjectModal } from './NewProjectModal'
import { StartSessionModal } from './StartSessionModal'
import { ConfirmDialog } from './ConfirmDialog'

export function Sidebar() {
  const { projects, sessions, unread, activeLocalId, view, openSession, openDashboard, openMural, openTasks, setProjects } = useStore()
  const openTerminal = useStore((s) => s.openTerminal)
  const [showNew, setShowNew] = useState(false)
  const [startFor, setStartFor] = useState<Project | null>(null)
  const [editFor, setEditFor] = useState<Project | null>(null)
  const [deleteFor, setDeleteFor] = useState<Project | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  // sessão mais recente do projeto (o backend já lista só a relevante + vivas)
  const sessionOf = (projectId: number): SessionInfo | undefined =>
    Object.values(sessions)
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]

  const onDrop = async (to: number) => {
    const from = dragIndex
    setDragIndex(null); setOverIndex(null)
    if (from === null || from === to) return
    const next = [...projects]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setProjects(next) // otimista
    try { setProjects(await reorderProjects(next.map((p) => p.id))) }
    catch { setProjects(await fetchProjects()) } // falhou: volta à ordem do servidor
  }

  const onDelete = async () => {
    if (!deleteFor) return
    try {
      await deleteProject(deleteFor.id)
      setProjects(await fetchProjects())
      setDeleteFor(null)
    } catch (err) {
      setDeleteError((err as Error).message)
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar__logo" onClick={openDashboard} title="Visão geral">
        <span className="sidebar__logo-star">✳</span> Claudinei
      </div>

      <div className="term-header">
        <span className="eyebrow">Terminais</span>
        <button className="ghost term-header__add" onClick={() => setShowNew(true)}>+ Terminal</button>
      </div>

      <div className="term-list">
        {projects.map((p, i) => {
          const s = sessionOf(p.id)
          const active = !!s && s.localId === activeLocalId && (view === 'chat' || view === 'terminal')
          const canOpen = !!s && s.status !== 'stopped' && s.status !== 'dead'
          const revivable = !!s && (s.status === 'stopped' || s.status === 'dead')
          const badge = s ? (unread[s.localId] ?? 0) : 0
          return (
            <div
              key={p.id}
              data-testid="term-card"
              className={[
                'term-card',
                active ? 'active' : '',
                dragIndex === i ? 'dragging' : '',
                overIndex === i && dragIndex !== null && dragIndex !== i ? 'drop-target' : '',
              ].filter(Boolean).join(' ')}
              style={{ ['--term-color' as string]: p.color }}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => { e.preventDefault(); setOverIndex(i) }}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null) }}
              onDrop={(e) => { e.preventDefault(); void onDrop(i) }}
              onClick={() => {
                if (!s || !canOpen) return
                if (s.status === 'in_terminal') openTerminal(s.localId)
                else openSession(s.localId)
              }}
            >
              <div className="term-card__title">
                <span className="term-card__icon">{p.icon}</span>
                <span className="term-card__name">{p.name}</span>
                {badge > 0 && <span className="badge">{badge}</span>}
              </div>
              <div className="term-card__status">
                {s ? (
                  <><span className={`status-dot status-${s.status}`} /><span>{STATUS_LABEL[s.status]}</span></>
                ) : (
                  <><span className="status-dot status-none" /><span>sem sessão</span></>
                )}
              </div>
              <div className="term-card__actions">
                {revivable && (
                  <button className="ghost" title="Reviver"
                          onClick={(e) => { e.stopPropagation(); void reviveSession(s!.localId).then(() => openSession(s!.localId)).catch(() => {}) }}>
                    ▶
                  </button>
                )}
                {!s && (
                  <button className="ghost" title="Iniciar sessão"
                          onClick={(e) => { e.stopPropagation(); setStartFor(p) }}>
                    ▶
                  </button>
                )}
                <button className="ghost" title="Editar"
                        onClick={(e) => { e.stopPropagation(); setEditFor(p) }}>
                  ✏️
                </button>
                <button className="ghost" title="Excluir"
                        onClick={(e) => { e.stopPropagation(); setDeleteError(''); setDeleteFor(p) }}>
                  🗑
                </button>
              </div>
            </div>
          )
        })}
        {projects.length === 0 && (
          <div className="term-list__empty">Nenhum terminal ainda — crie o primeiro no “+ Terminal”.</div>
        )}
      </div>

      <div className="sidebar__footer">
        <div className="eyebrow sidebar__footer-title">Interação entre terminais</div>
        <div className={`sidebar__footer-row ${view === 'mural' ? 'active' : ''}`} onClick={openMural}>
          <span>📌</span><span>Mural</span>
        </div>
        <div className={`sidebar__footer-row ${view === 'tasks' ? 'active' : ''}`} onClick={openTasks}>
          <span>🗂️</span><span>Tarefas</span>
        </div>
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
      {startFor && <StartSessionModal project={startFor} onClose={() => setStartFor(null)} />}
      {editFor && <NewProjectModal editProject={editFor} onClose={() => setEditFor(null)} />}
      {deleteFor && (
        <ConfirmDialog
          title={`Excluir ${deleteFor.name}?`}
          message="Isso remove o terminal da lista do Claudinei. Não apaga os arquivos no disco nem o histórico de conversas."
          confirmLabel="Excluir"
          error={deleteError}
          onConfirm={onDelete}
          onClose={() => setDeleteFor(null)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: CSS**

Em `web/src/styles.css`, ALTERAR a regra `.sidebar` existente para virar flex column:
```css
.sidebar {
  width: 250px; padding: 14px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur)); -webkit-backdrop-filter: blur(var(--glass-blur));
  border-right: 1px solid var(--glass-border);
}
```
E ADICIONAR ao fim do arquivo:
```css
/* Sidebar Terminais */
.sidebar__logo { font-size: 15px; font-weight: 600; letter-spacing: .02em; cursor: pointer; margin: 2px 4px 14px; }
.sidebar__logo-star { color: var(--accent); }
.eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); }
.term-header { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 6px; }
.term-header__add { font-size: 12px; padding: 3px 10px; }
.term-list { display: flex; flex-direction: column; gap: 6px; }
.term-list__empty { color: var(--text-dim); font-size: 12px; padding: 8px 4px; }
.term-card {
  position: relative; border-radius: 10px; padding: 8px 10px 8px 14px; cursor: pointer;
  border: 1px solid transparent;
  transition: background .15s ease, border-color .15s ease;
}
.term-card::before {
  content: ''; position: absolute; left: 4px; top: 9px; bottom: 9px; width: 3px; border-radius: 3px;
  background: var(--term-color, var(--accent));
}
.term-card:hover { background: var(--glass-bg-strong); }
.term-card.active { background: var(--glass-bg-strong); border-color: var(--glass-border); }
.term-card.dragging { opacity: .45; }
.term-card.drop-target { box-shadow: 0 -2px 0 0 var(--accent); }
.term-card__title { display: flex; align-items: center; gap: 7px; }
.term-card__icon { font-size: 16px; }
.term-card__name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.term-card__status { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 12px; margin-top: 3px; }
.status-none { background: transparent; border: 1px solid var(--text-dim); }
.term-card__actions { display: flex; gap: 2px; justify-content: flex-end; opacity: 0; transition: opacity .15s ease; margin-top: 2px; }
.term-card:hover .term-card__actions, .term-card:focus-within .term-card__actions { opacity: 1; }
.term-card__actions button { font-size: 12px; padding: 1px 7px; }
.sidebar__footer {
  margin-top: auto; border-radius: 12px; padding: 10px 12px;
  background: var(--glass-bg); border: 1px solid var(--glass-border);
}
.sidebar__footer-title { margin-bottom: 6px; }
.sidebar__footer-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.sidebar__footer-row:hover { background: var(--glass-bg-strong); }
.sidebar__footer-row.active { background: var(--glass-bg-strong); }
```

- [ ] **Step 5: Rodar tudo**

Run: `npm test -w web && npm run build -w web`
Expected: suíte inteira PASS (o `smoke.test.tsx` renderiza o App inteiro — se alguma asserção dele citar “Mural” duplicado ou o layout antigo, ajustar a asserção e anotar no report); build limpo.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Sidebar.tsx web/src/styles.css web/src/test/sidebar.test.tsx
git commit -m "feat(web): sidebar Terminais — mini-cards com cor/status/ações, drag&drop e card de interação"
```

---

## Self-Review

**1. Spec coverage:** sort_order+backfill+order route → Task 1 ✅; updateProject/reorderProjects + modal edição + Dashboard sem botão → Task 2 ✅; logo/eyebrow/+Terminal/mini-cards (cor/ícone/status/badge/▶ contextual/✏/🗑)/drag&drop otimista com revert/card Interação/empty state → Task 3 ✅; erros (400 revert, PATCH erro no modal, DELETE 409 no ConfirmDialog, revive catch silencioso) ✅; estética Glass/Aurora nas classes novas ✅; YAGNI respeitado ✅.
**2. Placeholder scan:** nenhum TBD/TODO; código completo em todo passo. ✅
**3. Type consistency:** `reorder(ids)→Project[]` (service) = rota = `reorderProjects` (api) = uso na Sidebar; `editProject?: Project` (Task 2) = uso na Sidebar (Task 3); `sessionOf` retorna `SessionInfo|undefined` e os guards usam `!!s`; títulos dos botões ("Reviver", "Iniciar sessão", "Editar", "Excluir") casam com os testes. ✅

## Nota para o executor (visual)

Depois do merge, o controlador faz um smoke visual com navegador (screenshot) para validar a estética: logo dim com ✳ em accent, eyebrow com tracking, barra de cor visível em cada card, ações aparecendo no hover, indicador de drop em accent, card do rodapé destacado. Ajustes cosméticos finos podem ser feitos pelo controlador nesse passo.
