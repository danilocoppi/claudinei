# Controles da sessão ativa (modelo + modo de permissão) — Design

**Data:** 2026-07-11
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Trocar o **modelo** e o **modo de permissão** de uma sessão **ativa**, a
quente (sem reiniciar o processo nem perder o contexto), por um controle ao
lado do botão Enviar. Cinco modos de permissão em paridade com o ciclo
shift+tab do terminal.

## Provas empíricas (claude 2.1.207, headless stream-json)

Validado ao vivo com o binário real:
- `control_request` `{subtype:'set_model', model}` → `control_response` success; o modelo troca no meio da sessão (processo iniciado com `--model opus` respondeu como Haiku após o control).
- `control_request` `{subtype:'set_permission_mode', mode}` → success para `default`, `auto`, `acceptEdits`, `plan`. `dontAsk`/`manual` mapeiam para `default`.
- **`bypassPermissions` só é aceito em runtime se o processo foi lançado com `--dangerously-skip-permissions`** (a FLAG, não `--permission-mode`). Com a flag, troca-se livremente entre os 5 modos.
- `--dangerously-skip-permissions` **sempre inicia em `bypassPermissions`** e ignora `--permission-mode`.

## Decisões

1. **Toda sessão passa a ser lançada com `--dangerously-skip-permissions`**
   (habilita o ciclo completo). Como isso força bypass inicial, se o modo
   escolhido ≠ `bypassPermissions`, o backend envia `set_permission_mode`
   logo após o `init`.
2. **Coluna evolui:** `skip_permissions` (bool) → **`permission_mode`** (texto,
   1 dos 5 modos; default `bypassPermissions`). Migração dos existentes:
   `permission_mode = skip_permissions=0 ? 'default' : 'bypassPermissions'`.
3. **Hot-swap:** `ClaudeSession.setModel`/`setPermissionMode` escrevem o
   control no stdin e resolvem no `control_response` de sucesso (timeout 10s
   → erro; `error` no response → rejeita com a mensagem).
4. **Persistência sempre:** viva → control **+** persiste; parada → só
   persiste (vale no próximo revive). O revive relança com a flag e reaplica
   o modo persistido pós-init.
5. **StartSessionModal:** o checkbox "Pular permissões" vira um seletor dos 5
   modos (default: Bypass — comportamento atual). O modelo já existe lá.
6. **Nota de segurança (declarada):** com a flag sempre presente, toda sessão
   *tem a capacidade* de bypass, mesmo que o modo ativo seja outro. Coerente
   com o Claudinei ser local-only (127.0.0.1) e ter bypass como padrão desde
   o MVP; é uma mudança real, por isso registrada.

## Os 5 modos

| Rótulo UI (chave i18n) | `mode` | Cor do chip |
|---|---|---|
| Manual (`perm.manual`) | `default` | âmbar |
| Auto (`perm.auto`) | `auto` | azul-claro |
| Aceitar edições (`perm.acceptEdits`) | `acceptEdits` | ciano |
| Plano (`perm.plan`) | `plan` | roxo |
| Pular permissões (`perm.bypass`) | `bypassPermissions` | verde |

## Backend

- **`session.ts`:**
  - `buildClaudeArgs`: remove `--permission-mode`; adiciona
    `--dangerously-skip-permissions` sempre. `opts` ganha `permissionMode`.
  - `ClaudeSession`: guarda `permissionMode` desejado; no `init`, se ≠
    `bypassPermissions`, envia `set_permission_mode`. Métodos
    `setModel(model): Promise<void>` e `setPermissionMode(mode): Promise<void>`
    — escrevem `{type:'control_request',request_id,request:{...}}`, registram
    um pending por `request_id`, resolvem/rejeitam quando o `control_response`
    correspondente chega (interceptado no handleEvent: `evt.kind==='raw' &&
    raw.type==='control_response'`). Timeout 10s limpa o pending e rejeita.
    Bloqueiam em `working`/`stopped`/`dead`.
- **`manager.ts`:** `setSessionOptions(localId, {model?, permissionMode?})` —
  valida (allowlist de modelo + os 5 modos), aplica no processo vivo se
  houver, persiste na row, faz broadcast do `session_status` com os novos
  campos. Sessão parada → só persiste.
- **`db.ts`:** ALTER defensivo `permission_mode TEXT` + backfill.
- **rota:** `PATCH /api/sessions/:localId/options` body `{model?,
  permissionMode?}`; modelo inválido → ignora (vira default); modo inválido →
  400.
- **`SessionInfo`** ganha `model: string | null` e `permissionMode: string`.
  `list()`/`infoOf` leem da row.

## Frontend

- **`api.ts`:** `setSessionOptions(localId, {model?, permissionMode?})` → PATCH.
- **`SessionControls.tsx`** (novo): pill à esquerda do Enviar mostrando
  `⚙ <modelo>` + chip do modo (cor por modo). Clique abre **popover glass
  para cima** (Portal): seção Modelo (Padrão/Fable/Opus/Sonnet/Haiku, ✓ no
  atual) e seção Permissão (os 5 modos, ✓ no atual, aviso ao sair do bypass).
  Cada clique aplica **na hora** (PATCH); flash "✓" no pill; erro → linha de
  aviso no popover. Desabilitado quando `status==='working'` (tooltip).
  Fecha com Esc/clique fora.
- **`ChatInput.tsx`:** renderiza `<SessionControls>` na barra, à esquerda do
  botão Enviar; recebe o `localId`.
- **`StartSessionModal.tsx`:** substitui o checkbox skip por um seletor dos 5
  modos (default Bypass); envia `permissionMode` no start.
- **`store`/`types`:** `SessionInfo` ganha `model`/`permissionMode`; o
  `session_status` do WS os carrega.
- **i18n:** chaves `perm.*` e `controls.*` nas 3 línguas.

## Fluxo (hot-swap)

```
sessão idle (bypassPermissions, Opus)
  → operador abre o popover, clica "Plano"
  → PATCH /api/sessions/:id/options { permissionMode: 'plan' }
  → manager: session.setPermissionMode('plan')
       → stdin: {type:'control_request',request_id:'c1',request:{subtype:'set_permission_mode',mode:'plan'}}
       → aguarda control_response(c1) success (10s)
  → persiste permission_mode='plan'; broadcast; pill mostra chip "Plano" + flash ✓
  (troca de modelo idem, subtype:'set_model')
```

## Tratamento de erros

| Situação | Comportamento |
|---|---|
| control_response com `error` | rota 400 com a mensagem; pill não muda |
| timeout (10s sem response) | rejeita "sem resposta do Claude"; estado inalterado |
| troca durante `working` | botão desabilitado no front; backend também recusa (409) |
| modo/modelo inválido | modo → 400; modelo fora do allowlist → vira "Padrão" (sem troca) |
| sessão parada | persiste; aplica no próximo revive (pós-init) |

## Testes

- **`session.ts` (fake-claude respondendo control_response):** `setModel`/
  `setPermissionMode` escrevem o JSON certo e resolvem no response; timeout
  rejeita; `init` com modo ≠ bypass dispara o control automático.
  `buildClaudeArgs` inclui `--dangerously-skip-permissions` e não inclui mais
  `--permission-mode`.
- **`manager`/rota:** aplica+persiste na viva; só persiste na parada; PATCH
  valida (400 em modo inválido); broadcast com os campos.
- **Front:** pill mostra modelo+modo atuais; clicar modelo/modo → PATCH;
  desabilitado em `working`; StartSessionModal envia `permissionMode`.

## Fora de escopo (YAGNI)

- Aprovação interativa de permissão pela web (permanece via handoff — D18).
- Persistir histórico de trocas de modo.
- Atalho de teclado (shift+tab) na web.
