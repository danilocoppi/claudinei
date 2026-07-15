# Sidebar "Terminais" — Design

**Data:** 2026-07-10
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Redesenhar a barra lateral do Claudinei: o projeto vira o cidadão de primeira
classe ("terminal"), com mini-cards ricos (cor, ícone, status, ações de
reviver/editar/deletar), criação pelo "+ Terminal", ordenação por arrastar e
soltar, e Mural+Tarefas agrupados num card "Interação entre terminais" no
rodapé. Estética coesa com o tema Glass/Aurora, aplicando a skill
frontend-design na implementação.

## Decisões do brainstorming

1. **A sidebar lista TODOS os projetos** (hoje lista só sessões não-stopped).
   Cada projeto = um terminal, um mini-card.
2. **Ordenação: drag & drop nativo HTML5** (sem lib nova), persistida no
   banco (`sort_order`).
3. **"+ Terminal"** ao lado do título "Terminais" abre o NewProjectModal; o
   botão "+ Novo projeto" sai do Dashboard (o Dashboard permanece como visão
   geral).
4. **Edição** (lápis ✏): NewProjectModal em **modo edição** — título/cor/
   ícone editáveis, path travado — via `PATCH /api/projects/:id` (já existe).
5. **Logotipo:** "✳ Claudinei" no topo, pequeno, como marca; clique volta ao
   Dashboard (comportamento atual mantido).
6. **"Interação entre terminais":** card glass fixo no rodapé da sidebar com
   as entradas Mural (📌) e Tarefas (🗂️) — mesmos destinos de hoje.

## Layout

```
┌────────────────────────┐
│  ✳ Claudinei           │  logotipo (dim, marca)
│                        │
│  TERMINAIS         [+] │  eyebrow/título + botão "+ Terminal"
│  ┌───────────────────┐ │
│  │▌ 🖥️ FXNfinity   ③ │ │  mini-card arrastável:
│  │▌ ● ociosa         │ │  ▌ barra 3px da cor do projeto
│  │▌      [▶] [✏] [🗑] │ │  ações reveladas no hover
│  └───────────────────┘ │
│  ...mais cards...      │
│        (flex spacer)   │
│  ┌───────────────────┐ │
│  │ INTERAÇÃO ENTRE    │ │  card fixo no rodapé
│  │ TERMINAIS          │ │
│  │  📌 Mural          │ │
│  │  🗂️ Tarefas   (n)  │ │
│  └───────────────────┘ │
└────────────────────────┘
```

## Comportamento do mini-card

| Elemento | Regra |
|---|---|
| Barra de cor | 3px à esquerda, `project.color` |
| Ícone + título | `project.icon` + `project.name` (ellipsis) |
| Status | bolinha `status-dot` + rótulo (`STATUS_LABEL`); sem sessão → "sem sessão" (dot apagado) |
| Badge | não-lidas da sessão ativa do projeto (comportamento atual) |
| Clique no card | sessão ativa → abre chat (`openSession`) ou terminal (`openTerminal` se `in_terminal`); sem sessão ativa → nada (usa o ▶) |
| ▶ (ação contextual) | sessão `stopped`/`dead` → **Reviver** (`POST /revive` + abre o chat); sem sessão → **Iniciar** (abre StartSessionModal do projeto); sessão ativa → botão oculto |
| ✏ | abre NewProjectModal em modo edição (nome/cor/ícone; path readonly) → `PATCH /api/projects/:id` |
| 🗑 | ConfirmDialog (existente); bloqueado se o projeto tem sessão ativa (regra atual do backend, 409) |
| Ações | visíveis apenas no hover do card (e sempre em foco por teclado) |
| Drag & drop | card `draggable`; indicador de drop entre cards; ao soltar → `PUT /api/projects/order` com a lista completa de ids na nova ordem |

## Backend

- **`sort_order INTEGER`** em `projects` (ALTER defensivo; default = `id` para
  os existentes — `UPDATE projects SET sort_order = id WHERE sort_order IS NULL`).
- `list()` ordena por `sort_order ASC, id ASC`. `create()` dá `sort_order` =
  `max(sort_order)+1`.
- **`PUT /api/projects/order`** body `{ ids: number[] }` — valida que é array
  de números; atualiza `sort_order` = índice na lista (ids desconhecidos são
  ignorados; ids ausentes mantêm a ordem relativa após os listados). Responde
  a lista reordenada. Body inválido → 400.
- `PATCH /api/projects/:id` (existe) segue aceitando name/color/icon.

## Frontend

- **`Sidebar.tsx`** reescrita: seções logo / terminais (header + lista) /
  card de interação. Lista = `projects` (ordem do servidor) com join do
  estado da sessão mais relevante por projeto (a mais recente ativa; senão a
  mais recente).
- **`NewProjectModal.tsx`**: prop opcional `editProject?: Project` — título
  "Editar terminal", path readonly, botão "Salvar" → `PATCH`; sem a prop,
  comportamento atual (criar).
- **`api.ts`**: `updateProject(id, {name,color,icon})` (PATCH) e
  `reorderProjects(ids: number[])` (PUT /order).
- **`store.ts`**: `setProjects` já existe; reorder otimista (aplica a ordem
  local, depois confirma com a resposta).
- **Dashboard.tsx**: remove o botão "+ Novo projeto" e o modal associado (a
  criação vive na sidebar).
- **Drag & drop:** `draggable` + `onDragStart/onDragOver/onDrop` nos cards;
  estado local `dragIndex`/`overIndex` para o indicador; sem lib.
- **Estética (frontend-design, tema Glass/Aurora):** logotipo dim com peso
  leve; "TERMINAIS" como eyebrow (uppercase, tracking largo, dim); mini-cards
  glass com barra de cor, hover eleva + revela ações; drag com opacidade no
  origem e linha de inserção no destino; card do rodapé com título eyebrow e
  divisória sutil.

## Tratamento de erros

| Situação | Comportamento |
|---|---|
| PUT /order com body inválido | 400; front reverte para a ordem anterior |
| PATCH falha | modal mostra o erro (padrão atual do NewProjectModal) |
| DELETE com sessão ativa | 409 do backend → ConfirmDialog mostra o erro |
| Reviver falha | alerta discreto no card (title/tooltip) e status permanece |

## Testes

- **Backend:** `sort_order` na criação (incremental) e na migração (=id);
  `list()` ordenado; `PUT /order` persiste, ignora ids desconhecidos, 400 em
  body inválido.
- **Front:** Sidebar renderiza todos os projetos (com e sem sessão) +
  estados; ▶ Reviver chama `/revive`; ▶ Iniciar abre o modal; ✏ abre modal
  em modo edição e envia PATCH; drop chama `reorderProjects` com a nova
  ordem; Dashboard sem o botão de criar.

## Fora de escopo (YAGNI)

- Remover o Dashboard (fica como visão geral).
- Ordenação automática/agrupamento por status.
- Colapsar/expandir o card de interação.
- Editar o path do projeto.
