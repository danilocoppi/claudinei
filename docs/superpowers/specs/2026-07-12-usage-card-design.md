# Card de uso na sidebar (barras do /usage + ritmo) — Design

**Data:** 2026-07-12
**Status:** Aprovado

## Objetivo

Card na sidebar, logo acima de "Terminal Interaction", com as mesmas barras do
`/usage` do Claude Code — Sessão atual, Todos os modelos (semana), Fable (semana) —
mais um **indicador de ritmo**: a cor da barra mostra se o ritmo de uso atual leva a
estourar o limite antes do reset. Barras futuras aparecem sozinhas (a fonte é dinâmica).

## Fonte dos dados (validada por spike em 2026-07-12)

`GET https://api.anthropic.com/api/oauth/usage` com headers
`Authorization: Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20`, onde o
token vem de `~/.claude/.credentials.json` (`.claudeAiOauth.accessToken`) — o mesmo
mecanismo do binário do claude (função interna "fetchUtilization"). A resposta traz
um array `limits` que É as barras do /usage:

```json
"limits": [
  { "kind": "session",       "group": "session", "percent": 10, "severity": "normal", "resets_at": "2026-07-12T13:20:00Z", "scope": null },
  { "kind": "weekly_all",    "group": "weekly",  "percent": 43, "severity": "normal", "resets_at": "2026-07-14T00:00:00Z", "scope": null },
  { "kind": "weekly_scoped", "group": "weekly",  "percent": 48, "severity": "normal", "resets_at": "2026-07-14T00:00:00Z", "scope": { "model": { "display_name": "Fable" } } }
]
```

Barras futuras = novas entradas do array (rótulo dinâmico via `scope.model.display_name`
ou kind). O token é renovado pelo próprio claude CLI no uso normal — 401 transitório
se auto-cura; não implementamos refresh.

## Backend — `GET /api/usage`

- `server/src/usage.ts`: `createUsageService(opts: { credentialsPath?, endpoint?, fetchFn?, cacheMs? })`:
  - lê o accessToken do credentials.json (path default `~/.claude/.credentials.json`,
    injetável p/ teste);
  - chama o endpoint (fetchFn injetável) e **normaliza** `limits` →
    `Array<{ kind: string; group: string; label: string | null; percent: number; severity: string; resetsAt: string }>`
    — `label` = `scope.model.display_name` quando houver; senão `null` (o front
    resolve `session`/`weekly_all` por i18n e usa `kind` como fallback p/ futuros);
  - **cache de 60s** (não martelar a API; o card e o refetch em foco compartilham);
  - qualquer falha (sem arquivo, 401, rede, shape inesperado) → `[]` + log warn
    (o card some; sem erro na UI).
- `server/src/routes/usage.ts`: `GET /api/usage` → `{ limits: [...] }`. Deps
  injetáveis no padrão das outras rotas; registrado no `app.ts` (condicional
  `deps.usage`, como `speech`).
- O token NUNCA vai ao navegador (proxy só devolve os números).

## Ritmo (front, helpers puros em `web/src/usage/pace.ts`)

- Janela por grupo: `session` → 5h com chunks de **20 min** (15 chunks);
  `weekly` → 7 dias com chunks de **1h** (168 chunks); grupo desconhecido → sem
  janela (ritmo neutro).
- `expectedPercent(resetsAt, windowMs, chunkMs, now)`: início da janela =
  `resets_at − windowMs`; chunks decorridos = `ceil((now − início) / chunkMs)`
  (clamp 1..total — o chunk atual conta cheio; evita divisão por zero no início);
  esperado = `chunksDecorridos / totalChunks × 100`.
- `paceRatio(percent, esperado)` = `percent / esperado`.
- Cor (`paceColor(ratio)`): razão ≤ 1 → verde (`--ok`); 1→2 → interpolação contínua
  de matiz HSL verde(140°)→vermelho(0°) passando pelo amarelo; ≥ 2 → vermelho
  (`--err`). Ritmo neutro (sem janela) → accent.
- Exemplos canônicos (viram testes literais):
  - sessão, 1h decorrida (3 chunks/15 = esperado 20%), usado 10% → razão 0,5 → verde;
  - sessão, 1h decorrida, usado 40% → razão 2,0 → vermelho;
  - semana, 84h decorridas (esperado 50%), usado 43% → razão 0,86 → verde.
- O PREENCHIMENTO da barra é sempre o `percent` usado; a COR é o ritmo.

## Front — `UsageCard` (`web/src/components/UsageCard.tsx`)

- Na `Sidebar`, imediatamente acima do bloco "Terminal Interaction", mesmo idioma
  visual dos cards glass da sidebar.
- Eyebrow "Uso" (i18n `usage.title`). Uma linha por limite:
  - rótulo (i18n: `usage.session` "Sessão atual", `usage.weeklyAll` "Todos os
    modelos"; `label` da API quando presente; fallback: kind formatado),
  - barra fina (trilho `rgba(0,0,0,.25)`, preenchimento `width: percent%`, cor do
    ritmo, raio cheio), `%` à direita,
  - linha pequena de reset: "reseta seg 00:00" (fuso local, i18n `usage.resets`),
  - `title` (tooltip): "48% usado · ritmo 1,4× do sustentável" (i18n `usage.pace`).
- Dados: `fetchUsage()` em `api.ts`; poll a cada 60s + refetch no `focus` da janela.
- `limits` vazio (erro/sem credenciais) → o card não renderiza.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Sem `~/.claude/.credentials.json` / 401 / rede | `[]` → card oculto; log warn no server |
| Início de janela (elapsed ~0) | 1º chunk conta cheio (esperado ≥ 6,7% / ≥ 0,6%) — sem explosão da razão |
| `resets_at` no passado (janela virou e a API ainda não) | esperado clampa em 100% → razão = percent/100 |
| Kind futuro desconhecido | barra aparece com rótulo do kind; grupo desconhecido → cor neutra |
| percent 0 | razão 0 → verde, barra vazia |

## Testes

- server: normalização (fixture da resposta real; scoped→label; shape inesperado→[]),
  cache 60s (fetchFn contado), falhas → []; rota 200 {limits} e vazio.
- web: `expectedPercent`/`paceRatio`/`paceColor` com os exemplos canônicos + bordas
  (início de janela, resets_at passado, grupo desconhecido); UsageCard renderiza
  barras/rótulos/cores com dados mock, some com []; i18n `usage.*` nas 3 línguas.
- Smoke real (controlador): card na sidebar com os números reais da conta.

## Fora de escopo (YAGNI)

- Refresh do token OAuth (o CLI cuida).
- Histórico/gráficos de uso; extra_usage/creditos.
- Configuração de intervalos de chunk pela UI.
