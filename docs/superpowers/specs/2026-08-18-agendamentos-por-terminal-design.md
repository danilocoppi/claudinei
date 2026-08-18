# Agendamentos por terminal

Data: 2026-08-18
Status: aprovado (aguardando plano de implementação)

## Problema

Toda tarefa recorrente hoje depende de alguém lembrar de pedir. Não há como dizer
"todo dia ao meio-dia, procure o produto X e me diga as três lojas mais baratas" e
encontrar a resposta depois sem garimpar o chat.

## Solução

Cada terminal ganha uma lista de **agendamentos**. Cada agendamento guarda um texto
de tarefa, uma cadência, opcionalmente a engine/model/effort a usar, e — quando
espera retorno — o **histórico das últimas N execuções com seus resultados**.

O agendamento não é só um gatilho: é um relatório permanente. Isso decide a tela.
O que se abre todo dia é o *resultado*; a configuração fica atrás de "Editar".

## Visual (aprovado)

### Onde mora

Terceiro modo do terminal, ao lado dos existentes: **Chat · Terminal · Agendas**.
O botão `⏱ Agendas` entra na `chat-header`, vizinho do `🖥 Abrir no terminal`.

### A tela

```
┌ Agendas · Alpha ─────────────────────────────── + Novo ─┐
│ ⏱ Preços do produto X                       ⏸   ✎   🗑 │
│   todo dia 12:00 · próxima hoje 12:00                    │
│  ┌ hoje 12:00 ─────────────────────────── ✓ 42 s ──────┐ │
│  │ 1. Loja A — R$ 189,90                               │ │
│  │ 2. Loja B — R$ 194,00                               │ │
│  │ 3. Loja C — R$ 199,90                  → ver no chat│ │
│  ├─────────────────────────────────────────────────────┤ │
│  │ ontem 12:00   ✓ 38 s   1. Loja B — R$ 191,50      ⌄ │ │
│  │ 2 dias 12:00  ⚠ falhou — sessão não subiu         ⌄ │ │
│  └───────────────────────────── mostrando 10 de 10 ────┘ │
└──────────────────────────────────────────────────────────┘
```

**O último resultado vem aberto; os anteriores, uma linha cada.** Quem abre esta
tela quer saber "o que ele achou hoje?" — essa resposta não pode custar um clique.
O histórico serve para comparar, e comparação se lê bem em uma linha por dia.

O `→ ver no chat` mantém o feed enxuto: guarda-se a **resposta final** do turno, não
a conversa, e o link leva ao ponto exato no chat para quem quiser o caminho inteiro.

### O editor

O agendamento é lido como uma frase que se completa, não como cinco campos de cron:

```
  Repetir  [a cada ▾]  [15]  [minutos ▾]
    só em  (seg)(ter)(qua)(qui)(sex) sáb dom
    entre  [09:00]  e  [18:00]
  ▸ Próximas: hoje 09:00 · 09:15 · 09:30 · 09:45

  Retorno  (•) guardar o resultado      ( ) só disparar
           guardar os últimos [10] resultados

  Engine [manter atual ▾]  Model [manter ▾]  Effort [manter ▾]
```

Modos do seletor: **a cada** N min/horas · **todo dia** às HH:MM · **toda semana**
em ⟨dias⟩ · **todo mês** no dia N · **cron** (expressão crua).

A linha **"Próximas"** é a assinatura da tela: as próximas quatro execuções,
calculadas ao vivo. É o que torna uma interface de cron confiável — você vê o que
acabou de descrever em vez de descobrir amanhã que errou.

Engine, model e effort nascem em **"manter atual"**. Obrigar a escolher faria o
operador fixar um modelo sem querer e descobrir semanas depois.

### Estados que não podem ser silenciosos

- Sem retorno (`só disparar`): sem feed, só uma tira de carimbos — `disparado hoje
  12:00 · ontem 12:00`. Tem de dar para ver de longe que aquele agendamento é de
  outra natureza, senão se espera um resultado que nunca vem.
- Falhas seguidas: `⚠ 3 falhas seguidas` no cartão do agendamento, e o `⏱` do
  cartão do terminal na sidebar acende em âmbar — **estático, sem o ping**. O anel
  pulsante é a língua de "esperando você agora"; um agendamento quebrado é âmbar
  porque precisa de você, mas não é urgente do mesmo jeito. Cron quebrado que
  ninguém percebe é o modo clássico de falhar deste tipo de recurso.
- Pausado: linha dessaturada, `⏱` vira `⏸`.

### Fora da tela de Agendas

- **Cartão do terminal (sidebar)**: `⏱` discreto depois do nome quando há ao menos
  um agendamento **ativo** (pausado não conta); com vários, leva o número (`⏱3`).
  Tooltip: "3 agendamentos ativos · próximo hoje 14:15".
- **Mensagem no chat**: bolha **teal** com selo `⏱ PREÇOS DO PRODUTO X · TODO DIA
  12:00 · EXECUÇÃO #14`. Âmbar já é "task de outro terminal" e violeta é
  "subagente" — repetir o âmbar confundiria duas origens diferentes de injeção. O
  selo liga a mensagem de volta à regra que a produziu.

## Modelo de dados

```sql
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  cadence TEXT NOT NULL,            -- JSON, ver abaixo
  engine TEXT,                      -- null = manter a atual
  model TEXT,                       -- null = manter
  effort TEXT,                      -- null = manter
  expects_result INTEGER NOT NULL DEFAULT 1,
  keep_results INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,                 -- ISO; null quando pausado
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)

CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,             -- o "#14" do selo e do feed
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,             -- running | ok | error | timeout | skipped
  result TEXT,                      -- resposta final, truncada
  error TEXT,
  local_id TEXT,                    -- sessão que executou (para o "ver no chat")
  late INTEGER NOT NULL DEFAULT 0   -- recuperada após o servidor ficar fora
)
CREATE INDEX idx_runs_schedule ON schedule_runs(schedule_id, seq DESC)
```

`next_run_at` mora no banco de propósito: é o que torna o agendador reinicializável
sem perder o horário nem disparar tudo de novo no boot. Pausar zera o campo; retomar
o recalcula a partir de agora — um agendamento pausado por uma semana não deve
acordar devendo execuções.

`seq` é por agendamento e nunca é reusado — o `#14` do selo tem de bater com o feed
mesmo depois de a poda apagar as execuções antigas.

### Poda

Depois de cada execução, apaga-se o que passar de `keep_results` naquele
agendamento. `só disparar` guarda os carimbos com `result` nulo, sob o mesmo limite.

## Cadência

Armazenada como JSON, numa forma que compila para conjuntos:

```ts
type Cadence =
  | { kind: 'every'; n: number; unit: 'minutes' | 'hours'; weekdays?: number[]; from?: string; to?: string }
  | { kind: 'daily'; at: string; weekdays?: number[] }
  | { kind: 'weekly'; weekdays: number[]; at: string }
  | { kind: 'monthly'; day: number; at: string }
  | { kind: 'cron'; expr: string }
```

Todas as formas — inclusive a crua — compilam para o mesmo alvo interno:
conjuntos de minutos, horas, dias da semana e dias do mês. Sobre ele roda um
avaliador único:

```ts
matches(when: Date): boolean
nextRun(after: Date, count = 1): Date[]
describe(): string          // "a cada 15 min · seg–sex · 09:00–18:00"
```

`nextRun` percorre dia a dia (não minuto a minuto) e, dentro do dia, o primeiro
horário que casa; teto de 366 dias devolve vazio (cadência impossível, ex.: 31 de
fevereiro), que a API rejeita na gravação.

**O preview vem do servidor** (`POST /api/schedules/preview`), não de uma cópia do
avaliador no front. Um preview que discorda do agendador é pior que preview nenhum,
e é exatamente o que duas implementações produzem com o tempo.

### Fuso e horário de verão

Tudo é hora local do servidor — "todo dia 12:00" quer dizer 12:00 na máquina que
roda o Claudinei. Numa virada de horário de verão, o horário que deixa de existir é
pulado e o que acontece duas vezes executa uma só (o `next_run_at` gravado impede a
segunda). Não há suporte a fuso por agendamento; é uma ferramenta local.

## O agendador

Um laço único, acordando a cada 30 s:

1. Seleciona `enabled = 1 AND next_run_at <= agora`.
2. Para cada um, dispara (abaixo) e recalcula `next_run_at = nextRun(agora)`.

Vive ao lado do `SessionManager`, criado no boot depois dele, e é parado no
shutdown. Nasce recalculando `next_run_at` de todo agendamento habilitado cujo
valor esteja nulo ou no passado — é o que trata as execuções perdidas.

### Execução

1. **Engine alvo**: se o agendamento fixa uma, procura-se a sessão daquela engine no
   projeto; senão, a sessão viva do projeto (a mesma prioridade que o resto do app
   usa). Sem sessão viva, **inicia/revive** — é o caso "mesmo morto, ele sobe".
2. **Ajustes antes de invocar**, e só quando divergem do atual:
   - `model`: `setModel` (control_request, sem custo de turno).
   - `effort`: **não existe control_request** para ele. Quando a execução é que sobe
     a sessão, o effort vai como flag de lançamento — sem turno extra. Com a sessão
     já de pé, manda-se `/effort <nível>` e **espera-se o `result` dele antes** de
     enviar a tarefa, descartando esse primeiro resultado. Sem esse descarte
     explícito, o resultado gravado no feed seria a resposta do `/effort`, e não a
     da tarefa — que é o defeito que este parágrafo existe para prevenir.

   Cada ajuste que falha é registrado no erro da execução, e a execução segue.
3. **Envio**: `session.send('[Agendamento: <nome> #<seq>]: <tarefa>', { echoToClients: true })`.
   Mesmo mecanismo do `[Task from …]`: o CLI não ecoa e ninguém inseriu localmente,
   então sem o eco a mensagem só apareceria depois de um refresh.
4. **Retorno**: com `expects_result`, escuta o `result` da sessão com timeout de
   30 min, exatamente como o `askAgent` já faz. Sem ele, a execução fecha como `ok`
   assim que o envio sai.
5. **Gravação**: `status`, `result` truncado em 8 KB (com marca de corte), duração,
   `local_id`. Sucesso zera `consecutive_failures`; falha incrementa.

### As três decisões

**Sobreposição** — chegou a hora (ou clicou-se em "executar agora") e a execução
anterior ainda roda: **pula**, e a
execução pulada aparece no feed (`⏭ pulada — execução anterior ainda rodando`).
Interromper destruiria trabalho; enfileirar empilharia sem limite. Pular é a única
que não faz estrago, e aparecer no feed é o que impede que o silêncio engane.

**Execuções perdidas** (servidor fora no horário): **uma recuperação, marcada como
atrasada**, e depois salta para a próxima ocorrência futura. Perder o relatório
diário porque a máquina reiniciou é pior que recebê-lo tarde; receber catorze de
uma vez é pior que os dois.

**Tamanho do resultado**: 8 KB, cortando o fim. O feed é resumo; o texto inteiro
está no chat, a um clique pelo `→ ver no chat`.

### Corrida conhecida

Se o operador mandar uma mensagem na mesma sessão entre o envio agendado e o
`result`, o resultado capturado pode ser o do operador. Dispara-se só com a sessão
ociosa, o que torna a janela estreita. Não vale sincronizar a UI inteira por isso;
fica documentado.

## Contrato da API

```
GET    /api/schedules                     todos (sem execuções) — alimenta o ⏱ da sidebar
GET    /api/projects/:id/schedules        do terminal, com as últimas execuções
POST   /api/projects/:id/schedules        cria
PATCH  /api/schedules/:id                 edita (inclui enabled: pausar/retomar)
DELETE /api/schedules/:id
POST   /api/schedules/:id/run             executa agora (não mexe no next_run_at)
GET    /api/schedules/:id/runs?limit=     feed
POST   /api/schedules/preview             { cadence } → { next: string[], describe: string }
```

Acesso por projeto (`canAccessProject`), não admin-only: o agendamento é do
terminal de quem o usa.

Validação: nome 1..60; tarefa 1..8000; `keep_results` 1..50; cadência válida e com
próxima execução dentro de 366 dias; `engine` existente; caso contrário 400.

### WebSocket

Broadcast de `schedule_run` ao começar e ao terminar uma execução, e de
`schedules_changed` nas mutações. É o que faz o feed atualizar sozinho com a tela
aberta e o `⏱` da sidebar acender sem refresh.

## Frontend

- `store`: `schedules` (lista enxuta, global, para o `⏱`) e `scheduleRuns` por
  agendamento aberto.
- `SchedulesView`: a tela acima; `view` do store ganha `'schedules'`.
- `ChatView`: botão `⏱ Agendas` na header.
- `Sidebar`: `⏱` no cartão a partir de `schedules`; âmbar com falhas seguidas.
- `applyEvent`: prefixo `[Agendamento: <nome> #<n>]:` vira `ChatItem`
  `scheduled_message` — mesmo caminho do `task_message`, que já existe.
- `MessageBlock`: bolha teal com o selo.
- i18n nos três idiomas.

## Tratamento de erros

- Sessão não sobe: execução `error` com a mensagem, `consecutive_failures++`.
- `setModel`/effort falham: registrado no erro da execução, que segue mesmo assim —
  falhar a tarefa inteira porque o effort não trocou seria pior que executá-la com
  o effort anterior.
- Timeout de 30 min: `timeout`, que conta como falha.
- Projeto apagado: `ON DELETE CASCADE` leva agendamentos e execuções junto.
- Cadência sem próxima execução: 400 na gravação, nunca um agendamento morto-vivo.

## Testes

**Cadência** (o núcleo): cada modo produz os horários esperados; `nextRun` salta
corretamente sobre fins de mês, dias da semana e janelas de hora; cron cru compila
para os mesmos conjuntos que a forma estruturada equivalente; cadência impossível
devolve vazio.

**Agendador**: dispara no horário e recalcula; pausado não dispara; sobreposição
pula e registra; perdida recupera uma vez e marca `late`; `next_run_at` sobrevive ao
reinício sem disparar de novo.

**Execução**: sobe sessão morta; aplica model/effort só quando divergem; grava
resultado e duração; `só disparar` fecha sem esperar; timeout vira falha; poda
respeita `keep_results` sem reusar `seq`.

**Rotas**: RBAC por projeto; validações; preview bate com o que o agendador faria.

**Frontend**: `⏱` aparece só com agendamento ativo e conta certo; bolha teal com o
selo; último resultado aberto e anteriores fechados; pausar/retomar; `só disparar`
mostra carimbos em vez de feed.

## Fora de escopo

- Painel global "Agenda" com todos os terminais (segunda tela, depois desta).
- Fuso por agendamento e cadências relativas ("30 min depois da anterior").
- Encadear agendamentos (um dispara o outro).
- Notificação externa (e-mail/webhook) com o resultado.
