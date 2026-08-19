# Aparência: temas e customização visual

Data: 2026-08-18
Status: aprovado (aguardando plano de implementação)

## Problema

O visual do Claudinei é fixo: um tema escuro, largura de chat cheia, fonte do
sistema. Não há como usar em ambiente claro, ajustar a leitura em tela larga nem
adaptar o app ao gosto de quem passa o dia dentro dele.

## Solução

Um botão **⚙ Aparência** no topo da sidebar abre um painel com escolhas puramente
visuais, aplicadas ao vivo e guardadas **por usuário no servidor**.

## O coração: a camada de tokens

O CSS tem hoje 324 usos de token e **106 cores cravadas**. São essas 106 que
impedem um tema claro — `rgba(0,0,0,.25)` como fundo de campo vira sujeira num
fundo claro, e `rgba(255,255,255,.06)` de vidro simplesmente some.

O trabalho central desta entrega **não é escrever o tema claro**: é migrar essas
106 ocorrências para uma camada de tokens semânticos. Depois disso, um tema é um
bloco de ~20 declarações — que é o que torna barato criar os próximos pacotes.

```
--bg                          fundo base
--bg-blob-1 / -2 / -3         as três manchas do gradiente (a identidade "Fun")
--surface                     vidro normal          (era --glass-bg)
--surface-strong              vidro em hover        (era --glass-bg-strong)
--sunken                      campos e áreas afundadas (era rgba(0,0,0,.25))
--border                      (era --glass-border)
--text  --text-dim
--accent  --accent-2          o par que forma os gradientes de botão
--ok  --warn  --err
--engine-teal                 in_terminal, setor, mensagem agendada
--task-amber                  task de outro terminal
--subagent-violet             instrução a subagente
--shadow                      sombra dos cartões
--code-bg                     fundo de bloco de código
--scheme                      dark | light (alimenta `color-scheme`)
```

### Regras da migração

- Tinta de acento (`rgba(124,92,255,.08)`) → `color-mix(in srgb, var(--accent) 8%, transparent)`.
  O projeto já usa `color-mix` em grupos e setores; é o padrão da casa.
- Preto/branco com alfa → `--sunken`, `--surface` ou `--border`, conforme o papel.
  A escolha é pelo PAPEL, não pela cor: o mesmo `rgba(0,0,0,.18)` é fundo afundado
  num lugar e sombra em outro, e no tema claro os dois divergem.
- As três origens de mensagem injetada viram tokens. Elas carregam significado
  (teal = agendamento, âmbar = task de outro terminal, violeta = subagente); no
  tema claro precisam de versões com contraste suficiente sobre fundo claro.
- Cores de marca em TSX (o laranja do Claude, o preto da OpenAI) **não** viram
  token: são identidade de terceiros, não do tema.

## Os dois pacotes

**Dark Fun** — o atual, sem mudança visual perceptível. É o teste da migração: se
algo mudar de aparência, a migração errou.

**Light Fun** — a mesma personalidade (as três manchas de gradiente, o mesmo roxo)
com as superfícies invertidas:

| token | Dark Fun | Light Fun |
|---|---|---|
| `--bg` | `#0b0d16` | `#f4f5fb` |
| `--bg-blob-1/2/3` | `#3b2b6b` `#1e5f74` `#2a1c4d` | `#cdc0f7` `#bfe0ea` `#dbd0f2` |
| `--surface` | `rgba(255,255,255,.06)` | `rgba(255,255,255,.72)` |
| `--surface-strong` | `rgba(255,255,255,.10)` | `rgba(255,255,255,.92)` |
| `--sunken` | `rgba(0,0,0,.25)` | `rgba(20,22,44,.05)` |
| `--border` | `rgba(255,255,255,.14)` | `rgba(20,22,44,.14)` |
| `--text` / `--text-dim` | `#eef0f8` / `#9aa0bd` | `#1a1c2e` / `#5c6180` |
| `--accent` | `#7c5cff` | `#6338f0` |
| `--ok` / `--warn` / `--err` | `#5ee0a0` `#f5c451` `#ff6b8b` | `#0f8f57` `#a4740a` `#cf2f52` |
| `--scheme` | `dark` | `light` |

O fundo claro não é branco puro de propósito: as manchas do gradiente precisam de
onde aparecer, e é o gradiente que faz o tema ser "Fun" e não "genérico".

## Os controles

| Controle | Efeito |
|---|---|
| **Tema** | troca o bloco de tokens |
| **Largura do chat** | `--chat-max`: cheia · 800 · 1000 · 1200 px |
| **Fonte da interface** | `--font-ui`, ~10 stacks do sistema |
| **Fonte de código** | `--font-code`, lista mono própria |
| **Densidade** | `--density`: confortável (1) · compacta (0.85), multiplica os paddings |
| **Cor de destaque** | sobrescreve `--accent`/`--accent-2` (6 opções) |
| **Cantos** | `--radius`: reto (4px) · padrão (16px) · redondo (22px) |
| **Vidro** | liga/desliga `backdrop-filter` |
| **Movimento reduzido** | força o mesmo que `prefers-reduced-motion` |

**Fontes do sistema, não webfonts.** O Claudinei roda local e empacotado: baixar
de CDN quebraria o uso offline e vazaria uma requisição a cada carga; embutir dez
arquivos woff2 engorda um binário que já tem 133 MB.

**Vidro desligado não é só gosto**: `backdrop-filter` é o maior custo de GPU do
app, e em máquina fraca a sidebar inteira fica pesada por causa dele.

**Movimento reduzido** existe porque o ping do "esperando você" pulsa
continuamente — quem se incomoda precisa de um jeito de desligar sem mexer no
sistema operacional.

## Persistência

Fonte da verdade: **o servidor, por usuário**.

```sql
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY,   -- 0 = instalação sem auth
  appearance TEXT NOT NULL,      -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

`user_id = 0` cobre o modo sem auth (`authUser === undefined`, que é pré-setup em
loopback e o app de teste). Sem esse caso o recurso simplesmente não funcionaria
nessa instalação. Token de serviço não tem aparência: `GET` devolve o padrão e
`PUT` responde 403.

Sem FK para `users` por causa da linha 0; apagar um usuário limpa a linha dele no
mesmo caminho que já limpa os projetos.

### O cache de pintura

Prefs do servidor chegam depois de um fetch — sem cuidado, o app pinta escuro e
pisca para claro. Por isso o último valor aplicado também vai para o
`localStorage` e é aplicado **antes do React montar**; o servidor continua sendo a
verdade e reconcilia quando responde.

O cache é só antiflash: se ele discordar do servidor, o servidor vence.

## Contrato da API

```
GET /api/prefs    → { appearance: {...} }   (padrões quando não há linha)
PUT /api/prefs    { appearance: {...} } → { appearance: {...} }
```

Validação por campo, com **queda para o padrão em vez de 400**: um tema removido
num pacote futuro não pode deixar o usuário preso numa tela que não carrega. O
servidor devolve o objeto já saneado, e é ele que a UI aplica.

## Aplicação no cliente

Um módulo `appearance.ts` traduz o objeto em atributos e variáveis no
`<html>` — `data-theme`, `data-density`, `data-glass`, `--chat-max`, `--font-ui`,
`--font-code`, `--radius`, `--accent`. Nada de classes espalhadas por componente:
a tela inteira reage a um lugar só, e é isso que faz um pacote novo não exigir
tocar em componente nenhum.

## Onde fica

Botão **⚙** no `sidebar__top-actions`, ao lado do usuário e do idioma — é onde os
controles do app já moram. Abre um painel com preview ao vivo (aplica enquanto se
mexe) e **Restaurar padrões**.

Fechar sem salvar reverte para o que estava: preview ao vivo sem volta atrás vira
armadilha.

## Tratamento de erros

- `PUT` falha (rede fora): a escolha continua aplicada na tela e no cache, e o
  painel avisa que não deu para guardar. Reverter o visual por causa de uma falha
  de rede seria pior que o problema.
- JSON corrompido no banco: cai no padrão, e a linha é reescrita no próximo save.
- Tema desconhecido no cache (pacote removido): cai no Dark Fun.

## Testes

**Tokens**: nenhuma cor cravada resta no `styles.css` fora do bloco dos temas — é
o teste que impede a migração de ser desfeita aos poucos, lendo o CSS como texto
(o mesmo jeito que já se testa o ⋮ e a fonte de emoji).

**Temas**: todo tema declara o conjunto completo de tokens. Um pacote novo que
esqueça `--sunken` falha no teste em vez de aparecer quebrado na tela.

**Aplicação**: cada controle vira o atributo/variável esperado no `<html>`; valor
desconhecido cai no padrão.

**Persistência**: `GET` sem linha devolve padrões; `PUT` salva por usuário e um
usuário não lê a preferência do outro; modo sem auth grava na linha 0; token de
serviço toma 403 no `PUT`.

**Antiflash**: o cache é aplicado antes do fetch, e a resposta do servidor
sobrescreve o cache quando diverge.

## Fora de escopo

- **Tamanho de fonte** — descartado nesta rodada.
- Temas por terminal (o tema é do usuário, não do projeto).
- Editor de tema livre (escolher cada cor à mão); os pacotes são fechados.
- Sincronizar tema entre abas abertas em tempo real.
