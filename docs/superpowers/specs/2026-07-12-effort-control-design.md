# Effort no popover ⚙ — Design

**Data:** 2026-07-12
**Status:** Aprovado

## Objetivo

Trocar o reasoning effort da sessão pelo mesmo popover ⚙ de modelo/permissão.

## Fatos (spikes 2026-07-12, claude 2.1.207 real)

- NÃO existe `control_request` de effort (allowlist: set_model, set_permission_mode,
  interrupt, set_max_thinking_tokens, rename_session, …).
- `--effort <low|medium|high|xhigh|max>` existe no launch, mas não é necessário aqui.
- **`/effort <nível>` funciona headless**: responde `result` de sucesso com o texto
  `Set effort level to <tier> (this session only): …` e a sessão segue viva.
  Níveis: `low | medium | high | xhigh | max | ultracode | auto`.
- `/effort` sem argumento só imprime o usage (não há getter do valor atual).
- Effort é por PROCESSO ("this session only"): revive/restart volta ao padrão (auto).

## Design (só front — zero backend)

### Estado (store)
- `sessionEffort: Record<localId, string>` (ausente = `auto`).
- Fareja os eventos de chat: `result`/texto começando com `Set effort level to <tier>`
  atualiza o valor — funciona tanto via popover quanto quando o usuário digita
  `/effort` na mão.
- `init` de uma sessão (processo novo: primeira mensagem, revive, restart) **resets**
  o valor para ausente (padrão auto) — espelha o "this session only" do CLI.

### UI (SessionControls)
- Nova seção **Effort** no popover (eyebrow `controls.effort`), itens na ordem:
  `auto (padrão)`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`.
- Clicar envia a mensagem `/effort <nível>` pela infra existente
  (`ws.send send_message` + `addLocalUserText`, como o ChatInput) e dá o flash ✓ no
  pill; a confirmação real aparece no chat e o ✓ do item se move quando o farejador
  atualizar o store (~1s).
- ✓ marca o valor atual do store (default `auto`).
- Pill continua desabilitado em `working` (consistente com modelo/permissão).
- Nomes dos tiers não são traduzidos (termos técnicos); só o rótulo do auto ganha
  sufixo i18n ("auto (padrão)").

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Usuário digita `/effort high` no chat | farejador atualiza o ✓ do popover igual |
| Revive/restart da sessão | init reseta para auto (fiel ao CLI) |
| `/effort` com nível inválido | o CLI responde o usage; farejador não casa; ✓ não muda |
| Sessão working | pill desabilitado (regra existente) |

## Testes

- store: result com "Set effort level to xhigh …" → `sessionEffort` atualiza;
  init → reset; texto não relacionado → intacto.
- SessionControls: seção com 7 itens; clique envia `{type:'send_message', text:'/effort xhigh'}`
  + addLocalUserText; ✓ segue o store (auto default).
- i18n: `controls.effort` + `session.effortAuto` nas 3 línguas.

## Fora de escopo (YAGNI)

- Persistir/reaplicar effort após revive (o CLI define como per-processo; respeitamos).
- `--effort` no launch/StartSessionModal (muda-se pelo ⚙ quando quiser).
- Descrições longas por tier no popover.
