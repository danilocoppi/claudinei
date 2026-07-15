# Grupos de terminais na sidebar — Design

**Data:** 2026-07-15
**Status:** Aprovado pelo pedido ("agrupar visualmente os terminais; UX o mais top e amigável possível"). Sessão não-interativa: decisões de mecânica tomadas com a recomendação registrada — todas reversíveis/ajustáveis.

## Objetivo

Agrupar terminais na lista da esquerda (ex.: 3 terminais do projeto X — frontend,
backend, infra — sob um grupo "Projeto X"), com seções colapsáveis, sem mudar nada
do comportamento dos cards (abrir, reviver, badge, engines).

## Decisões

- **Atribuição: drag & drop + menu ⚙** — arrastar um card sobre o cabeçalho do grupo
  o move pra dentro (highlight de drop); o menu ⚙ do card ganha a seção "Grupo"
  (lista com ✓, "Sem grupo", "Novo grupo…" com input inline). Card-sobre-card
  continua REORDENANDO (semântica atual intocada).
- **Persistência: servidor (DB)** — grupos são globais como projetos; valem em
  qualquer navegador e para todos os usuários. Não-admin vê um grupo apenas se
  acessa ≥1 terminal dele; mutações são admin-only (como projetos).
- **Colapso: por navegador** (localStorage) — é estado de visão, não de dados.
- **Ordem:** grupos primeiro (na ordem de criação), terminais soltos depois; dentro
  do grupo vale a ordem global (`sort_order`) que o drag de reordenar já mantém.

## Visual (tema Glass)

- **Cabeçalho do grupo:** caret ▸/▾ (gira ao abrir), nome, contagem de terminais e
  badge somando os não-lidos dos filhos. Colapsado, mostra os status-dots dos filhos
  (visão de relance sem abrir). Admin: ⚙ no hover (renomear inline / excluir).
- **Filhos:** os mesmos term-cards, com leve indent + trilho à esquerda
  (`border-left` sutil) marcando o pertencimento.
- **Drop:** cabeçalho acende (borda accent) quando um card é arrastado sobre ele.

## Modelo / API

- Tabela `project_groups (id, name, sort_order)`; `projects.group_id` NULLABLE
  (migração idempotente `ALTER TABLE ADD COLUMN`). Excluir grupo NÃO exclui
  terminais — eles voltam pra raiz (`group_id=NULL` antes do DELETE).
- `Project` ganha `groupId: number | null`.
- Rotas (`server/src/routes/groups.ts`): `GET /api/groups` (autenticado; não-admin
  filtrado por acesso), `POST /api/groups {name}` / `PATCH /api/groups/:id {name}` /
  `DELETE /api/groups/:id` (admin), `PATCH /api/projects/:id/group {groupId|null}`
  (admin). Nome: trim, 1..60 chars.
- Sem broadcast novo: o cliente que muda refetcha (mesma semântica de criar/editar
  projeto hoje).

## Fora de escopo (YAGNI)

Reordenar grupos entre si (ordem de criação basta por ora); cor/ícone de grupo;
grupos aninhados; colapso sincronizado entre máquinas.

## Testes

Service (CRUD + delete solta os filhos + setGroup), rotas (RBAC: GET filtrado,
mutação 403 p/ não-admin), Sidebar (render agrupado + contagem, colapso persiste,
drop no cabeçalho chama a API, menu move/cria grupo, soltos seguem na raiz).
