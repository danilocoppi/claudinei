# Excluir projeto + correção dos emojis — Plano

> Executar via subagente + revisão adversarial, mesmo rito.

**Goal:** (1) Permitir excluir um projeto pela UI, com diálogo de confirmação e bloqueio quando há sessão ativa; (2) corrigir os emojis que aparecem como tofu (□) no Chrome/Linux adicionando a fonte de emoji ao stack de `font-family`.

**Decisões do usuário:**
- Excluir: BLOQUEAR enquanto houver sessão ativa do projeto (não encerrar automaticamente).
- Confirmação: diálogo "Excluir 'Nome'? Remove o projeto da lista (não apaga arquivos no disco)." com Cancelar/Excluir.
- Emojis: tofu no Chrome com Noto Color Emoji instalada → causa é a `font-family` não listar a fonte de emoji; corrigir via CSS.

## Global Constraints
- TS strict; ESM `.js` (server). Testes offline com fake-claude. Commits convencionais com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- "Sessão ativa" = status ∈ {starting, idle, working, needs_attention} (mesma definição do manager). Sessões dead/stopped NÃO bloqueiam a exclusão.
- Excluir remove o projeto e suas linhas de sessão do banco (o schema já tem ON DELETE CASCADE); NÃO apaga arquivos no disco nem os transcripts JSONL do claude.

## Contrato de interfaces
- `SessionManager` ganha `hasActiveSession(projectId: number): boolean`.
- `registerProjectRoutes(app, deps: { db: Db; manager: SessionManager })` — assinatura muda (hoje recebe só `db`). DELETE checa `manager.hasActiveSession(id)` → 409 `{ error }` se ativa; senão remove e 204.
- Front: `deleteProject(id: number): Promise<void>` no api.ts; novo `ConfirmDialog`; `ProjectCard` ganha botão excluir.

---

### Task 1 — Backend: bloquear exclusão com sessão ativa

**Files:** `server/src/claude/manager.ts`, `server/src/routes/projects.ts`, `server/src/app.ts`; teste `server/test/routes-projects.test.ts`.

**manager.ts** — adicionar ao objeto retornado por `createSessionManager`:
```ts
hasActiveSession(projectId: number): boolean {
  for (const [, entry] of live) {
    if (entry.projectId === projectId && ACTIVE.has(entry.session.status)) return true
  }
  return false
},
```
(`ACTIVE` e `live` já existem no escopo.)

**routes/projects.ts** — mudar a assinatura e a rota DELETE:
```ts
import type { SessionManager } from '../claude/manager.js'
// ...
export function registerProjectRoutes(app: FastifyInstance, deps: { db: Db; manager: SessionManager }) {
  const svc = createProjectsService(deps.db)
  // ... rotas GET/POST/PATCH usam deps.db via svc, inalteradas ...
  app.delete('/api/projects/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (deps.manager.hasActiveSession(id)) {
      return reply.code(409).send({ error: 'projeto tem uma sessão ativa; finalize-a antes de excluir' })
    }
    svc.remove(id)
    return reply.code(204).send()
  })
}
```
(As outras rotas do arquivo passam a usar `deps.db` em vez de `db`.)

**app.ts** — trocar `registerProjectRoutes(app, deps.db)` por `registerProjectRoutes(app, { db: deps.db, manager: deps.manager })`.

**Testes (TDD)** — adicionar a `routes-projects.test.ts` (que já monta o app com um manager; usar o sessionFactory fake, como em routes-sessions.test.ts, para poder criar uma sessão ativa):
- DELETE de projeto SEM sessão → 204 (mantém o teste atual, ajustando a construção do app para a nova assinatura se necessário).
- DELETE de projeto COM sessão ativa → 409 `{error}`.
- DELETE de projeto cuja sessão foi parada (stop) → 204.

NOTA: `routes-projects.test.ts` hoje cria o app com `createSessionManager({ db, broadcast: () => {} })` (sem fake). Para o teste de sessão ativa, crie o manager com `sessionFactory` fake (copie o padrão de `routes-sessions.test.ts`: `process.execPath` + `fake-claude.mjs`, `waitUntil` status idle) e crie uma sessão via `POST /api/projects/:id/sessions` antes do DELETE.

---

### Task 2 — Frontend: botão excluir + ConfirmDialog

**Files:** `web/src/api.ts`, `web/src/components/ConfirmDialog.tsx` (novo), `web/src/components/ProjectCard.tsx`; testes `web/src/test/confirm-dialog.test.tsx`, `web/src/test/project-card-delete.test.tsx`.

**api.ts** — adicionar:
```ts
export const deleteProject = (id: number) =>
  req<void>(`/api/projects/${id}`, { method: 'DELETE' })
```

**ConfirmDialog.tsx** (novo, genérico, estilo glass):
```tsx
export function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', onConfirm, onClose, error }: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  error?: string
}) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass" style={{ width: 400, borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p style={{ color: 'var(--text-dim)' }}>{message}</p>
        {error && <p style={{ color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="ghost" onClick={onClose}>Cancelar</button>
          <button style={{ background: 'linear-gradient(135deg,#ff6b8b,#c0563b)' }} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
```

**ProjectCard.tsx** — adicionar estado `showDelete` e `deleteError`, um botão de excluir (ícone "🗑", `className="ghost"`, `title="Excluir projeto"`) no cabeçalho do card (à direita, ao lado do badge), com `e.stopPropagation()`; e renderizar o `ConfirmDialog` quando `showDelete`. Ao confirmar:
```tsx
const onDelete = async () => {
  try {
    await deleteProject(project.id)
    setProjects(await fetchProjects())   // recarrega a lista
    setShowDelete(false)
  } catch (err) {
    setDeleteError((err as Error).message)  // ex.: 409 sessão ativa
  }
}
```
Importar `deleteProject`, `fetchProjects` de `../api` e `setProjects` de `useStore`. O botão de excluir fica sempre visível no card (canto superior direito); o diálogo mostra `title="Excluir ${project.name}?"`, `message="Isso remove o projeto da lista do Termaster. Não apaga os arquivos no disco nem o histórico de conversas."`, `confirmLabel="Excluir"`.

**Testes:**
- ConfirmDialog: renderiza título/mensagem; "Cancelar" chama onClose; "Confirmar" chama onConfirm; mostra `error` quando passado.
- ProjectCard delete: clicar 🗑 abre o diálogo; confirmar com fetch mockado (DELETE 204 + fetchProjects []) chama DELETE na URL certa e fecha; um DELETE que responde 409 mostra a mensagem de erro no diálogo (não fecha).

---

### Task 3 — Correção dos emojis (font-family)

**Files:** `web/src/styles.css`; possível ajuste no wrapper do `EmojiPicker.tsx`.
**Test:** difícil em jsdom; validar por (a) um teste que confirma que o `body`/`:root` inclui a fonte de emoji no stack, e (b) smoke visual no Chrome.

**styles.css** — adicionar uma var e anexar aos stacks de fonte:
```css
:root {
  /* ...vars existentes... */
  --emoji: "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Twemoji Mozilla", sans-serif;
}
body { /* ... */ font-family: system-ui, -apple-system, sans-serif, var(--emoji); }
```
E anexar `, var(--emoji)` (ou os nomes) ao fim de QUALQUER outra declaração de `font-family` que renderize emoji — em especial as `font-family: ui-monospace, monospace` usadas nos tool cards / breadcrumb, que hoje não têm emoji e podem mostrar tofu nos ícones 💻 📝. Faça `grep -rn "font-family\|fontFamily" web/src` e, para cada stack mono, acrescente a fonte de emoji ao final.

**EmojiPicker.tsx** — garantir que o picker herde a fonte de emoji: no wrapper interno do `Picker`, adicionar `style={{ fontFamily: 'var(--emoji)' }}` no `<div onClick={stopPropagation}>` para que os emojis nativos do picker usem a fonte correta.

**Teste (leve):**
`web/src/test/emoji-font.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const css = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'styles.css'), 'utf8')

describe('fallback de emoji no CSS', () => {
  it('body inclui uma fonte de emoji no font-family', () => {
    expect(css).toMatch(/Noto Color Emoji/)
    expect(css).toMatch(/--emoji/)
  })
})
```

---

### Task 4 — Smoke visual + revisão

- Subir dev servers; verificar no Chrome real:
  - Emojis renderizam coloridos (não tofu) nos cards, no chat (tool calls 💻 📝) e no emoji picker.
  - Botão 🗑 no card abre o diálogo; excluir um projeto sem sessão remove o card; tentar excluir um com sessão ativa mostra o aviso (409) e não exclui.
- Suítes verdes; revisão adversarial das tasks; revisão final da branch.
