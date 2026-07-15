# Controle do turno: parar e editar mensagem — Design

**Data:** 2026-07-12
**Status:** Aprovado (Leva A das 4 features de 2026-07-12)

## Objetivo

1. **Parar:** abortar o turno em andamento do Claude (hoje não há como).
2. **Editar:** recuperar uma das suas últimas 5 mensagens para o campo, corrigir e
   reenviar — interrompendo o turno antes, se estiver rodando.

## Fato validado (spike 2026-07-11, claude real)

`control_request {subtype:"interrupt"}` no stream-json: `control_response success` em
~0,1s; o turno aborta na hora (`result subtype=error_during_execution, is_error=true`);
a **sessão continua viva** (mensagem seguinte funciona normal). O que o turno já tinha
produzido permanece no histórico; o que estava em voo se perde — comportamento honesto
e esperado de um "parar".

## Decisões do usuário

- Botão **■** no grupo de ações do campo (padrão `input-action` 44px), visível SÓ
  durante `working`; **Esc** no campo também para (quando o menu de slash não estiver
  aberto — Esc do slash tem precedência).
- Enviar continua livre durante o turno (steering/adendos preservados).
- Editar: lápis ✏ no hover das **últimas 5 mensagens do usuário** + **↑ no campo
  vazio** navega essas 5 (↑ mais antiga, ↓ mais recente/limpa).
- Mecânica do editar: interrompe (se `working`) + texto no campo + reenvio manual.
  Sem reescrita retroativa (o protocolo não permite).

## Backend

### `session.ts`
- `interrupt(): Promise<void>` → `sendControl('interrupt', {})`, MAS o guard atual de
  `sendControl` rejeita `working` — e interrupt só faz sentido em `working`. Mudança:
  `sendControl(subtype, payload, opts?: { allowWorking?: boolean })`; `interrupt()`
  passa `allowWorking: true` e além disso EXIGE `working` (interrupt fora de turno é
  no-op silencioso — resolve sem mandar nada, evita corrida com um result que chegou
  no meio do clique).
- O `result` emitido pelo aborto já flui pelo `handleEvent` existente
  (`working → needs_attention`) — sem mudança de status machine.

### `manager.ts`
- `interrupt(localId): Promise<void>` → delega à sessão viva (erro claro se não houver).

### `ws.ts`
- Novo tipo de mensagem do cliente: `{ type: 'interrupt', localId }` → `manager.interrupt`.
  Falha vira log (padrão dos outros handlers), não derruba o socket.

### `fake-claude.mjs` (teste)
- Ganha modo: mensagem de usuário `"demorada"` → responde `assistant` e NÃO emite
  `result` (turno fica aberto). `control_request {subtype:'interrupt'}` →
  `control_response success` + `result {subtype:'error_during_execution', is_error:true}`.

## Frontend

### Parar
- `ChatInput`: quando `session.status === 'working'`, renderiza o botão ■
  (`input-action` com cor `--err`, title `chat.stop`) à ESQUERDA do 🎤. Clique →
  `ws.send({ type: 'interrupt', localId })`. Sem estado local: o feedback é o status
  mudando via WS (~0,1s). Tecla **Esc** no textarea: se o slash menu estiver aberto,
  fecha o menu (comportamento atual, precedência); senão, se `working`, envia interrupt.
- i18n: `chat.stop` ("Parar o turno" / "Stop the turn" / "Detener el turno") nas 3 línguas.

### Editar
- Store: `requestEdit(localId, text)` → grava `editRequest: { localId, text, seq }`
  (seq incrementa para o mesmo texto disparar de novo). AÇÃO COMPOSTA no ChatView/
  MessageBlock: se `status === 'working'`, envia interrupt ANTES de `requestEdit`.
- `ChatInput`: effect observa `editRequest` da sua sessão → `setText(text)` + focus +
  cursor no fim (e consome/ignora seq repetido).
- `MessageBlock`/`ChatView`: as últimas 5 mensagens `user_text` (não `fromSubagent`)
  da sessão ativa ganham ✏ no hover (canto da bolha, padrão dos botões ghost).
  O cálculo "é uma das 5 últimas do usuário?" é helper puro testável
  (`lastUserTexts(items, 5): string[]` + índice).
- **↑ histórico:** no textarea, `ArrowUp` com campo VAZIO (e slash fechado) entra no
  modo histórico: mostra a mais recente das 5; ↑ sobe para mais antigas; ↓ desce e,
  passando da mais recente, limpa o campo e sai do modo. Digitar qualquer coisa sai
  do modo. Helper puro `historyStep(list, index, dir): { index, text }`.
- i18n: `chat.edit` ("Editar esta mensagem" etc.) nas 3 línguas.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| ■ clicado quando o turno JÁ acabou (corrida) | backend: interrupt fora de working é no-op |
| Esc com slash aberto | fecha o slash (precedência); segundo Esc para o turno |
| Editar com turno rodando | interrupt primeiro; o texto entra no campo mesmo se o interrupt falhar (edição não é refém do abort) |
| Editar com campo já contendo texto | sobrescreve (ação explícita do usuário) |
| ↑ com campo não-vazio | comportamento nativo do textarea (mover cursor) — não intercepta |
| Menos de 5 mensagens | usa as que houver; nenhuma → ↑ não faz nada |

## Testes

- server: session.interrupt (working → control ok + result de aborto → needs_attention;
  idle → no-op), guard allowWorking não afeta setModel/setPermissionMode; manager.interrupt;
  ws type interrupt.
- web: ■ aparece só em working e envia interrupt; Esc para (e não para com slash aberto);
  lápis nas 5 últimas (e só nelas) → interrupt (se working) + texto no campo;
  ↑/↓ navegam o histórico e saem certo; helpers puros (lastUserTexts, historyStep);
  i18n paridade (chat.stop, chat.edit).
- Smoke real (controlador+usuário): mandar tarefa longa real, parar com ■, ver o
  status voltar; editar a mensagem com ✏ e reenviar.

## Fora de escopo (YAGNI)

- Reescrita retroativa de histórico / fork de conversa (protocolo não suporta).
- Fila de mensagens pendentes com edição antes do envio (steering já cobre adendos).
- Parar tool calls individuais (o interrupt aborta o turno inteiro).
