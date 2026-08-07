# Filtro "somente ativos" na sidebar

Data: 2026-08-07
Status: aprovado (aguardando plano de implementação)

## Problema

A sidebar lista todos os terminais e grupos, ativos ou não. Com muitos terminais
cadastrados, achar onde há um agente de pé exige varrer a lista inteira olhando as
bolinhas de status.

## Solução

Um toggle na sidebar que esconde tudo que não tem agente de pé. É **estado de visão**:
não altera nada no servidor, não reordena, não mexe em grupos — mesma natureza do
`collapsedGroups` que já existe.

## Definição de "ativo"

Um terminal é ativo quando tem **ao menos uma sessão viva**, reusando o `LIVE_STATUSES`
de `web/src/engineSession.ts`:

| Status            | Ativo |
|-------------------|-------|
| `starting`        | sim   |
| `idle`            | sim   |
| `working`         | sim   |
| `needs_attention` | sim   |
| `in_terminal`     | sim   |
| `stopped`         | não   |
| `dead`            | não   |
| (sem sessão)      | não   |

Reusar `LIVE_STATUSES` é deliberado: o filtro passa a coincidir exatamente com a
bolinha colorida que o card já mostra. Se a noção de "vivo" mudar um dia, filtro e
bolinha mudam juntos, sem divergir.

**Exceção — pin do aberto:** o terminal atualmente aberto permanece visível mesmo sem
sessão viva, enquanto estiver aberto. Sem isso, terminar um agente faria o card sumir
da sidebar por baixo do usuário, que continua lendo o chat dele.

"Aberto" aqui é a mesma condição que já acende o card como `active` no `Sidebar.tsx`:
`s.localId === activeLocalId && (view === 'chat' || view === 'terminal')`. Ou seja, no
Dashboard ou no Board não há pin — o `activeLocalId` sobrevive à navegação, e sem a
checagem de `view` um terminal parado ficaria pinado indefinidamente depois de visitado
uma vez.

## Comportamento com grupos

- Grupo **sem nenhum** filho ativo: some inteiro, cabeçalho junto. Isso inclui os
  grupos vazios, hoje visíveis para admin como alvo de arraste — com o filtro ligado
  o arraste está desabilitado, então eles não teriam função.
- Grupo **com algum** filho ativo: aparece, exibindo apenas os filhos ativos.
- Estado de colapso preservado: o filtro não expande nem colapsa nada.
- Contador do cabeçalho (`term-group__count`): `ativos/total` (`3/8`) com o filtro
  ligado; `total` (`8`) com ele desligado. Um contador que caísse de `8` para `3` sem
  explicação pareceria bug — a barra comunica que há itens ocultos ali.

## Arquitetura

Módulo novo `web/src/sidebarEntries.ts`, consumido pelo `Sidebar.tsx`:

**Movidos do `Sidebar.tsx`, sem mudança de comportamento** — o tipo `Entry` precisa ser
compartilhado para a função de filtro viver fora do componente, e um módulo de lógica
importar tipos do componente que ele serve seria acoplamento invertido:

- `type Entry` — grupo com filhos, ou terminal solto
- `entryKey(e)`, `entryOrder(e)`

**Novos:**

- `isProjectActive(projectId, sessions, pinnedLocalId?): boolean`
  Verdadeiro se `liveSessionsOf(projectId, sessions).length > 0`, ou se alguma sessão
  do projeto tem `localId === pinnedLocalId` (o pin).

- `filterEntries(entries, sessions, pinnedLocalId?): Entry[]`
  Terminais soltos ativos, e grupos com ao menos um filho ativo já com `items`
  reduzido aos ativos.

O `pinnedLocalId` é calculado pelo componente, não pelo módulo:
`(view === 'chat' || view === 'terminal') ? activeLocalId : undefined`. As funções
puras ficam sem conhecer o conceito de `view`, e a regra de "o que conta como aberto"
mora num lugar só.

O `Sidebar.tsx` ganha o estado `activeOnly` e aplica `filterEntries` apenas na
renderização. A lista `entries` completa continua existindo — é dela que o
`applyOrder` deriva a estrutura persistida.

**Total do contador.** `filterEntries` devolve `items` já filtrado, então o total real
não sai dela. O `renderGroup` calcula o total direto do store, que é a fonte da verdade
e está à mão: `projects.filter((p) => p.groupId === g.id).length`. Com o filtro
desligado esse total coincide com `items.length`, e o cabeçalho exibe só ele.

## Fluxo de dados

`sessions` já chega pelo store via WebSocket e re-renderiza a sidebar a cada mudança de
status. O filtro é derivado dessa mesma fonte, então a lista se atualiza sozinha quando
um agente sobe ou cai. Nenhuma chamada de API nova, nenhum polling.

## UI

- **Toggle:** `switch switch--sm` (o mesmo do `UsageCard`), no `term-header`, à direita,
  ao lado de "Terminais" e do botão de adicionar. Visível para todos os usuários — é
  visão, não mutação, então não depende de `isAdmin`.
- **Persistência:** `localStorage`, chave `claudinei:activeOnly`, seguindo o padrão de
  `claudinei:collapsedGroups`.
- **Lista vazia com filtro ligado:** chave nova `sidebar.emptyActive`. O `sidebar.empty`
  atual ("crie o primeiro terminal com + Terminal") diria a coisa errada para quem tem
  terminais, todos inativos.
- **i18n:** chaves novas (`sidebar.activeOnly` para label/`title`/`aria-label`, e
  `sidebar.emptyActive`) nos três idiomas: `pt-BR`, `en`, `es`.

## Arraste desabilitado enquanto filtrado

Com o filtro ligado, `draggable` fica desligado nos cards e cabeçalhos, a *endzone* do
fim da lista não renderiza, e os handlers de drop retornam cedo.

**Motivo** — `server/src/groups.ts:60`, `applySidebarOrder`:

```js
let seq = 0
for (const e of entries) {
  if (e.kind === 'group') {
    db.prepare(`UPDATE project_groups SET sort_order=? WHERE id=?`).run(seq++, e.id)
```

Só as entradas recebidas são atualizadas, com `seq` recomeçando do zero. O
`applyOrder` do cliente envia a estrutura derivada de `entries`; se essa lista
estivesse filtrada, os visíveis receberiam `0,1,2…` enquanto os escondidos manteriam
`sort_order` antigos que colidem com esses valores. Ao desligar o filtro, a ordem
apareceria embaralhada — e a ordenação é manual, então seria perda de trabalho do
usuário.

Alternativa considerada e descartada: reconstruir a ordem completa reinserindo os
escondidos nas posições originais. Resolve, mas exige mapear posições entre lista
filtrada e completa para um ganho pequeno (arrastar enquanto se filtra é gesto raro),
e erra em silêncio se a lógica tiver bug. Desabilitar é honesto e reversível: basta
desligar o filtro.

## Tratamento de erros

`localStorage` inacessível (modo restrito do navegador) cai em `try/catch` e o filtro
apenas não persiste — mesmo tratamento do `loadCollapsed` atual. Não há caminho de rede
novo, logo nenhum modo de falha de rede novo.

## Testes

`web/src/test/sidebar-active-filter.test.tsx`, no padrão do `sidebar.test.tsx`
(Vitest + Testing Library, store populado via `useStore.setState`):

- terminal sem sessão viva some com o filtro ligado
- terminal com sessão viva permanece
- grupo sem filhos ativos some inteiro
- grupo misto aparece só com os filhos ativos
- contador exibe `1/2` filtrado e `2` sem filtro
- terminal aberto em `view: 'chat'` permanece visível mesmo `stopped` (pin)
- o mesmo terminal `stopped` some em `view: 'dashboard'` (pin não vale fora do chat/terminal)
- estado persiste em `localStorage` e é lido no mount
- cards não são arrastáveis com o filtro ligado

Unitários de `isProjectActive`: cada status de `LIVE_STATUSES` conta como ativo,
`stopped`/`dead` não, projeto sem sessão não, e o pin vale mesmo com sessão parada
quando `pinnedLocalId` é passado.

## Fora de escopo

- Filtro equivalente no Dashboard. A regra fica isolada em `sidebarEntries.ts`, então
  promover para o store depois é trivial se a necessidade aparecer.
- Filtros por engine, por texto ou por status específico (só `working`, só
  `needs_attention`).
- Qualquer mudança no backend. Esta feature é inteiramente cliente.
