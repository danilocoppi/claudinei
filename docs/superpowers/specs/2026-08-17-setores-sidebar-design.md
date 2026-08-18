# Setor: um nível de agrupamento acima de Grupo

Data: 2026-08-17
Status: aprovado (aguardando plano de implementação)

## Problema

A sidebar tem dois níveis: grupos e terminais soltos, ambos na raiz. Com muitos
terminais, os grupos sozinhos não bastam para organizar — falta um nível acima
que junte grupos afins.

## Solução

**Setor**: um contêiner que aceita **grupos e terminais**, seguindo o mesmo padrão
visual e de manipulação que o grupo já tem (nome, ícone, cor, colapso, contador,
arrastar).

Hierarquia resultante:

```
Setor
├── Grupo
│   └── Terminal
└── Terminal          (direto no setor, sem grupo)
Grupo                 (raiz, como hoje)
Terminal              (raiz, como hoje)
```

## Decisões

**Setor é opcional.** A raiz continua aceitando grupos e terminais soltos; setor é
mais um tipo de entrada ali. Os dados atuais seguem válidos sem migração de
conteúdo, e a adoção é gradual — sem um setor "Geral" artificial.

**Exclusão não apaga conteúdo.** Apagar um setor promove seus grupos e terminais
para a raiz, espelhando o `remove()` de grupo, que hoje devolve os terminais para
a lista raiz.

Apagar um **grupo que está dentro de um setor** deixa os terminais dele NO SETOR —
não na raiz. Hoje o `remove()` limpa só o `group_id`, o que mandaria o terminal
para a raiz e faria o operador perder o contexto que ele mesmo montou; com setores,
o grupo apagado precisa repassar seu `sector_id` aos filhos.

**Arrastar é completo.** Terminal entre grupo/setor/raiz, grupo para dentro e fora
de setor, setor reordenado na raiz.

## Modelo de dados

Tabela nova, espelhando `project_groups`:

```sql
CREATE TABLE sectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🏢',
  color TEXT NOT NULL DEFAULT '#58c4dc',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
ALTER TABLE project_groups ADD COLUMN sector_id INTEGER REFERENCES sectors(id)
ALTER TABLE projects       ADD COLUMN sector_id INTEGER REFERENCES sectors(id)
```

Migração puramente aditiva: as colunas nascem nulas e todo o conteúdo existente
continua na raiz, exatamente onde está hoje.

### Pertencimento único

Um terminal está em **exatamente um** lugar:

| group_id | sector_id | onde está        |
|----------|-----------|------------------|
| X        | —         | no grupo X       |
| null     | Y         | direto no setor Y|
| null     | null      | na raiz          |

Mover para um grupo limpa o `sector_id`; mover para um setor limpa o `group_id`.
A invariante é imposta pelo serviço, não deixada como convenção — duas colunas
representando pertencimento é fonte clássica de estado inconsistente que só
aparece na tela, tarde.

## Ordenação

Mantém-se o espaço único de `sort_order` que já existe, agora atribuído numa
travessia em PROFUNDIDADE da árvore: setor, seus filhos, o próximo setor, e assim
por diante. Cada entidade guarda o seu valor; a leitura ordena dentro do próprio
nível. É a extensão natural do `applySidebarOrder` atual.

## Contrato da API

`SidebarEntry` ganha um nível; grupo e terminal permanecem como hoje:

```ts
type SidebarEntry =
  | { kind: 'sector';  id: number; children: Array<
      | { kind: 'group'; id: number; children: number[] }
      | { kind: 'project'; id: number }> }
  | { kind: 'group';   id: number; children: number[] }
  | { kind: 'project'; id: number }
```

O mesmo `PUT /api/sidebar-order` continua servindo: a estrutura enviada define o
pertencimento. CRUD de setor espelha o de grupo (`/api/sectors`), mais
`PATCH /api/projects/:id/sector` e `PATCH /api/groups/:id/sector`.

**Cuidado central.** O `applySidebarOrder` só atualiza as entradas que recebe, com
`seq` recomeçando do zero — foi por isso que o arraste precisou ser desabilitado
com o filtro "somente ativos" ligado (uma lista filtrada gravaria ordens colidindo
com as dos itens escondidos). Com três níveis, uma travessia errada embaralha a
ordenação manual do operador, que é trabalho dele perdido. É onde os testes se
concentram.

## Frontend

- `sidebarEntries.ts`: o tipo `Entry` ganha `sector`, com filhos `group`/`project`.
- `Sidebar.tsx`: renderiza três níveis reusando o visual do grupo (ícone, cor,
  colapso persistido, contador, menu de opções).
- Arraste: alvos novos (soltar em setor, tirar de setor) sobre o mesmo mecanismo.
- Menu do card ganha "Mover para setor…", como já tem "Grupo".

### Filtro "somente ativos"

`filterEntries` precisa entender setor: **setor sem nenhum terminal ativo some
inteiro**, como já acontece com grupo. Sem isso, ligar o filtro passaria a mostrar
setores vazios — o oposto do que ele existe para fazer.

O contador do setor segue o padrão `ativos/total` já usado no grupo, contando
TODOS os terminais do setor — inclusive os que estão dentro de grupos dele, não só
os soltos. Um setor que mostra `0/9` quando tem nove terminais em grupos seria
mais confuso que útil.

## Tratamento de erros

- Mover para setor inexistente: rejeitado no serviço, como `setProjectGroup` já faz
  com grupo (`grupo X não existe`).
- Entrada malformada no `PUT /api/sidebar-order`: 400, mantendo a validação atual.
- Ciclos são impossíveis por construção — setor não aninha em setor, grupo não
  aninha em grupo.

## Testes

Serviço:
- `applySidebarOrder` com três níveis: mover terminal entre grupo/setor/raiz, mover
  grupo para dentro e para fora de setor, reordenar setores.
- Ordem preservada dentro de cada nível após a travessia.
- Pertencimento único: mover para grupo limpa `sector_id` e vice-versa.
- Apagar setor promove grupos e terminais à raiz, sem apagar nada.
- Apagar grupo DENTRO de setor deixa os terminais no setor (não os manda à raiz).
- Mover para setor inexistente falha.

Frontend:
- `filterEntries`: setor sem ativo some; setor misto mantém só os ativos; contador
  `ativos/total`.
- Sidebar: renderiza os três níveis; arrasta terminal para setor; tira grupo do
  setor.

## Fora de escopo

- Mais de três níveis (setor dentro de setor).
- Permissões por setor (a autorização segue por projeto).
- Mover em massa (selecionar vários terminais de uma vez).
