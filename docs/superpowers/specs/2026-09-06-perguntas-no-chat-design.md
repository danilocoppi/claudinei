# Perguntas do agente no chat (AskUserQuestion) — design

Data: 2026-09-06. Status: aprovado (caminho A), aguardando plano de implementação.

## Problema

No terminal, quando o Claude Code precisa de decisões do operador ele usa a
ferramenta `AskUserQuestion`: um diálogo com abas por pergunta, opções com
descrição, "Type something" para resposta livre e Submit. No chat do Claudinei
isso não existe — e não por falta de UI: **a ferramenta nem é oferecida ao
modelo**. O Claudinei sobe a CLI sem `--permission-prompt-tool`, e sem ele a
`AskUserQuestion` fica fora da lista de tools do `init` (medido: o modelo
responde "não encontro uma ferramenta chamada AskUserQuestion"). O agente então
pergunta em prosa, e o operador responde em prosa.

Objetivo: o agente faz perguntas estruturadas no chat, o operador responde
escolhendo (ou digitando livremente), e o turno continua — com a mesma
fidelidade do terminal.

## O que a CLI faz de verdade (empírico, CLI 2.1.261, 2026-09-05)

Oito sondagens com `-p --input-format stream-json --output-format stream-json`
(streams crus em `/tmp/askq-*.jsonl` na máquina de desenvolvimento). Fatos:

1. **Sem** `--permission-prompt-tool stdio`: `AskUserQuestion` ausente de
   `init.tools`. **Com** o flag: presente.
2. Ao usar a tool, a CLI emite `assistant/tool_use(AskUserQuestion)` e, em
   seguida, no stdout:
   ```json
   {"type":"control_request","request_id":"<uuid>","request":{
     "subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
     "input":{"questions":[{"question":"Qual cor você prefere?","header":"Cor",
       "options":[{"label":"Azul","description":"Cor azul"},…],"multiSelect":false}]},
     "tool_use_id":"toolu_…","requires_user_interaction":true}}
   ```
   e **bloqueia o turno** até o host responder pelo stdin.
3. Resposta que a CLI aceita:
   ```json
   {"type":"control_response","response":{"subtype":"success","request_id":"<o mesmo>",
     "response":{"behavior":"allow","updatedInput":{"questions":[…],
       "answers":{"Qual cor você prefere?":"Azul","Quais frutas você gosta?":"Maçã, Banana"}}}}}
   ```
   A CLI injeta `user/tool_result` com o texto `Your questions have been
   answered: "Q"="A", …` e o modelo continua **no mesmo turno**. `answers` é
   chaveado pelo texto da pergunta; múltipla escolha vai como rótulos separados
   por `", "`; resposta livre é qualquer string no lugar do rótulo.
4. Negar (`{"behavior":"deny","message":"…"}`) → `tool_result` com
   `is_error:true` e a mensagem; o modelo segue e o turno fecha com
   `result/success`.
5. `interrupt` com pergunta pendente → a **própria CLI** emite
   `{"type":"control_cancel_request","request_id":"<o da pergunta>"}`, responde
   o interrupt, injeta o `tool_result` de rejeição ("The user doesn't want to
   proceed…"), um `user/text` "[Request interrupted by user for tool use]" e
   `result/error_during_execution`. O host **não** precisa negar antes.
6. O flag **não** faz Bash e os outros tools pedirem permissão ao host: nem em
   bypass, nem com `set_permission_mode default` aplicado pós-init (como o
   Claudinei faz). Só pedidos com `requires_user_interaction` chegam.
7. Em `-p`, o `init` só sai quando chega a primeira mensagem (irrelevante para
   o Claudinei, que já manda a mensagem sem esperar; relevante para sondas).

## Decisão: caminho A — nativo do protocolo

Ligar o flag, tratar o `can_use_tool` de `AskUserQuestion` na sessão, publicar
a pergunta pendente para a UI pelo `session_status` e responder pelo stdin.

Rejeitados:
- **Detectar perguntas na prosa** e desenhar chips: heurístico e invisível
  para o modelo (ele não sabe que existe, então não pode contar com isso).
- **Tool própria via o MCP hermes** (`ask_user`, bloqueia até a UI responder):
  é o caminho certo para levar o mesmo painel a Codex/OpenCode/Kimi **depois**
  — o componente de UI desta spec é reaproveitável —, mas o Claude não a
  escolheria espontaneamente como escolhe a nativa, e são mais peças.

## Arquitetura e fluxo

```
CLI (stdout) ─control_request/can_use_tool─▶ ClaudeSession.pendingQuestion
                                              │ emit('status')  (re-broadcast)
                                              ▼
                                  manager.infoOf() → session_status { pendingQuestion }
                                              │ WS broadcast / sessions_snapshot
                                              ▼
                                  store.sessions[id].pendingQuestion → <QuestionPanel/>
                                              │ ws.send({type:'answer_question', answers})
                                              ▼
                        ws.ts → manager.answerQuestion → session.answerQuestion
                                              │ control_response allow (stdin)
                                              ▼
                        CLI injeta tool_result e continua o turno; pendência limpa,
                        status re-emitido, painel some em todos os clientes.
```

A pergunta pendente é **estado do processo vivo**, como `backgroundTasks` e
`authExpired`: só memória, nunca banco. Reload e outras abas a recebem pelo
snapshot; restart do servidor mata a CLI junto, então não há o que restaurar.

## Servidor

### `session.ts`
- `buildClaudeArgs` inclui `--permission-prompt-tool stdio`.
- Tipos exportados: `Question { question, header, options: {label, description}[], multiSelect }`
  e `PendingQuestion { toolUseId, questions }`. O `request_id` fica privado.
- `handleEvent`, no ramo `raw` (ao lado do `control_response`):
  - `control_request` com `subtype:'can_use_tool'`:
    - `tool_name === 'AskUserQuestion'` → guarda a pendência e `emit('status', this.status)`
      (mesmo mecanismo do `completeAuth` para rebroadcastar o `session_status`).
    - outro pedido com `requires_user_interaction` → responde `deny` com
      "O Claudinei ainda não exibe este pedido (<tool>)". O modelo fica sabendo,
      em vez de esperar para sempre.
    - sem `requires_user_interaction` → responde `allow` com `updatedInput: input`
      (espelha o bypass). Defensivo: nas sondas nunca ocorreu.
    - outros `subtype` de `control_request` seguem ignorados (comportamento atual).
  - `control_cancel_request` cujo `request_id` é o da pendência → descarta e re-emite status.
  - Nenhum dos dois vaza como evento de chat (`return`, como o `control_response`).
- `answerQuestion(answers: Record<string,string>)`: exige pendência; valida que
  toda pergunta tem resposta não vazia; escreve o `control_response` allow com
  `updatedInput: { ...input, answers }`; limpa; re-emite status.
- `dismissQuestion()`: exige pendência; `deny` com "O usuário vai responder
  pelo chat."; limpa; re-emite status.
- `interrupt()` inalterado (a CLI cancela sozinha — fato 5).
- Fechamento do processo limpa a pendência (junto do `pendingControls`).
- `readonly pendingQuestion?: PendingQuestion` como getter público.

### `engine/types.ts`
`pendingQuestion?`, `answerQuestion?(answers)`, `dismissQuestion?()` opcionais
em `EngineSession` — só o Claude implementa, como `startAuth`/`completeAuth`.

### `manager.ts`
- `SessionInfo.pendingQuestion?: PendingQuestion`; `infoOf` lê da sessão viva.
- `answerQuestion(localId, answers)` e `dismissQuestion(localId)`: erro claro se
  a sessão não está viva ou a engine não suporta.
- Melhoria pontual: os três broadcasts de `session_status` montados à mão em
  `wire()` viram um helper (`statusMsg(localId, session, overrides?)`), para um
  campo novo não ter que ser copiado em três lugares (revive passa por aqui
  também, via `wire()` → `session.start()`).
- Fora do `wire()`, cada `session_status` montado à mão precisa continuar
  carregando `pendingQuestion` explicitamente: o store do front não tem
  fallback (campo ausente é lido como "nenhuma pendência", não como "mantém a
  anterior") — omitir o campo em qualquer broadcast alcançável com uma
  AskUserQuestion pendente derruba o painel na cara do operador enquanto a CLI
  segue bloqueada esperando resposta. `setSessionOptions` é o caso alcançável:
  o guard de `working` só cobre model/permissionMode, então um PATCH de effort
  passa (e broadcasta sem o campo) com uma pergunta aberta — bug real, corrigido
  no wave de revisão final. Os três broadcasts manuais de `openInTerminal`
  seguem sem o campo, cada um com um comentário explicando por que ali
  `pendingQuestion` não pode existir (o `stop()` da sessão já zera a pendência
  antes de resolver, e a entrada já saiu de `live`).

### `routes/ws.ts`
Mensagens cliente→servidor `answer_question { localId, answers }` e
`dismiss_question { localId }`, ao lado de `interrupt`: mesma guarda de acesso
por projeto; erro volta como `{ type:'error', localId, message }`. WS em vez de
REST porque é ação de chat sem payload de retorno.

### `test/fake-claude.mjs`
Gatilho `pergunta`: emite `assistant/tool_use(AskUserQuestion)` e o
`control_request` (fato 2) com duas perguntas, a segunda `multiSelect`. Ao
receber o `control_response` daquele `request_id`: `allow` → `user/tool_result`
"Your questions have been answered: …" + `assistant` "eco: <respostas>" +
`result` (usage normal); `deny` → `tool_result is_error` com a mensagem +
`assistant` + `result`. `interrupt` com pendência → `control_cancel_request` e
a sequência do fato 5. Nada de `/compact`-like: o gatilho é uma palavra que
nenhum teste existente manda.

## Interface

### Estado
- `web/src/types.ts`: `Question`, `PendingQuestion`, `SessionInfo.pendingQuestion?`.
- `store.ts`, `session_status`: `pendingQuestion: msg.pendingQuestion` — **sem**
  fallback para o valor anterior (ausente = não há pergunta). `sessions_snapshot`
  já espalha o `SessionInfo`. Ao **aparecer** uma pendência onde não havia,
  dispara `notifyQuestion(projectName)` (bipe + Notification "tem uma pergunta
  para você"), no molde de `notifySessionChange`.

### `QuestionPanel` (novo, `web/src/components/QuestionPanel.tsx`)
Renderizado no `ChatView` acima da caixa de mensagem (onde fica o
`ReauthBanner`), só enquanto `session.pendingQuestion` existe.
- Cabeçalho: "O agente tem uma pergunta para você" / "… N perguntas …", e abas
  com o `header` de cada pergunta (✓ nas respondidas). Uma pergunta = sem abas.
- Corpo: o texto da pergunta; opções como linhas selecionáveis (rótulo forte,
  descrição discreta) — rádio ou caixa conforme `multiSelect`; a linha extra
  **"Outra resposta…"** abre um campo de texto. Na simples, o texto substitui a
  escolha; na múltipla, soma-se às marcadas.
- Rodapé: **"Responder pelo chat"** (secundário → `dismiss_question`) e
  **"Enviar respostas"** (primário, habilitado só com todas as perguntas
  respondidas → `answer_question`). Na pergunta única, Enter no campo livre
  envia.
- `answers`: `{ [question.question]: rótulo | "rótulo1, rótulo2" | texto livre }`.
- Estado local `busy` após enviar; a confirmação é o `session_status` seguinte
  sem pendência (o painel some). Sem retorno em 5 s — pergunta já respondida em
  outra aba, WS caiu — os botões destravam para tentar de novo; não há canal de
  erro inline.
- Visual: painel de vidro como o `.reauth`, mas no tom de destaque (`--accent`),
  não de aviso — é um pedido, não um alerta. Linhas de opção de largura total
  (celular), foco visível, semântica nativa de rádio/checkbox.
- Textos em pt-BR, en e es.

### "Esperando você"
- `engineSession.ts`: `isWaitingForYou()` também é verdadeiro com
  `pendingQuestion`; `dotClassOf` devolve o âmbar de `needs_attention`.
  Card da sidebar, aba de engine e `AgentFace` seguem sem mudança própria.

### Caixa de mensagem
Continua ativa (mensagem digitada ali é orientação do turno, comportamento
atual), mas com o placeholder trocado enquanto há pergunta: "Responda acima —
ou escreva aqui para orientar o agente". Sem isso, quem digita a resposta na
caixa deixa a pergunta aberta sem entender por quê.

### `ToolCallCard`
Para `AskUserQuestion`: resumo com os `header`s; aberto, lista as perguntas do
`input` e o `result` (as respostas). É o que sobra no histórico do transcript,
onde o painel não existe.

## Casos de borda

| Situação | Comportamento |
|---|---|
| Responder o que já foi respondido (outra aba, clique duplo) | servidor devolve erro ao socket; o painel já sumiu (ou some) pelo status; se nada voltar, os botões destravam em 5 s |
| Interromper com pergunta aberta | CLI manda `control_cancel_request`; pendência limpa; chat mostra a rejeição como hoje |
| Stop / processo morre | pendência limpa no fechamento |
| Restart do servidor | CLI morre junto; nada a restaurar |
| Sessão `in_terminal` | o TUI tem o próprio diálogo; painel não aparece (a caixa nem é renderizada) |
| Histórico do transcript | só os `ToolCallCard`s; painel só nasce do status vivo |
| Outras engines | campo ausente; nada muda |
| Validação | toda pergunta respondida; texto livre não vazio; múltipla com ≥1 |
| Pedido interativo que não é `AskUserQuestion` | negado com mensagem explicativa |

## Testes

Servidor (vitest + fake-claude):
- `buildClaudeArgs` inclui `--permission-prompt-tool stdio`.
- `session.test.ts` / `session-control.test.ts`: `pergunta` popula `pendingQuestion`
  (perguntas + `toolUseId`) e re-emite status; `answerQuestion` escreve o allow e a
  pendência some com o `result`; `dismissQuestion` nega; `interrupt` com pendência
  limpa via cancel; `answerQuestion` sem pendência lança; morte do processo limpa;
  pedido interativo de outra tool é negado.
- `manager.test.ts` / `ws.test.ts`: `session_status` e snapshot carregam
  `pendingQuestion`; `answer_question`/`dismiss_question` chegam à sessão; a
  guarda de projeto vale para elas.

Web (vitest + RTL):
- `store.test.ts`: status com/sem `pendingQuestion` seta/limpa; snapshot inclui;
  notificação dispara só na chegada.
- `question-panel.test.tsx`: abas; rádio vs. caixa; Enviar travado até completar;
  "Outra resposta…" vira a resposta; `answers` no formato certo (múltipla com
  `", "`); "Responder pelo chat" manda `dismiss_question`; `answerOf` puro
  (livre substitui na simples, soma na múltipla; vazio não conta).
- `engineSession`: `isWaitingForYou`, `dotClassOf` e `displayStatusKey` com pendência; `faceStateOf` vira `attention`.
- `ChatView`: painel só com pendência; placeholder trocado.

## Fora de escopo (candidatos a seguir)

- **Permitir/Negar** de permissões de tools no chat: o canal é o mesmo
  (`can_use_tool`), mas hoje nenhum pedido desses chega (fato 6). Fica para
  quando o Claudinei oferecer modos não-bypass de verdade.
- O mesmo painel para Codex/OpenCode/Kimi via tool própria no MCP hermes.
- Aprovação de plano (`ExitPlanMode`) em modo plan: se um dia chegar como
  pedido interativo, cai na negação explicativa até ganhar UI.
