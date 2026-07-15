# Autenticação multi-usuário (Sub-projeto 2) — Design

**Data:** 2026-07-13
**Status:** Aprovado

## Objetivo

Permitir expor o Claudinei na rede (`--host 0.0.0.0`) **sem** `--insecure`: sistema
de login multi-usuário com JWT, acesso por terminal (RBAC binário), painel de
administração na UI, troca de senha, lockout de força bruta e revogação global de
sessões. Com auth configurada, `assertExposureAllowed` recebe `authConfigured: true`.

## Decisões (do usuário)

- **JWT para toda autenticação** (usuários e serviço interno).
- **RBAC binário por terminal:** usuário vê e opera apenas os terminais/projetos da
  sua lista; fora dela o terminal nem aparece. `is_admin` é flag global.
- **Hermes autentica com token de serviço JWT** injetado via env (não isenção de loopback).
- **Cookie httpOnly** carrega o JWT no navegador (WS autentica no handshake).
- **Login sempre**, inclusive via localhost, depois que o master existe.
- **Primeiro acesso (0 usuários) só via loopback**, para criar o login master.
- **Revogar todas as sessões abertas** (botão no admin).
- **Lockout:** 5 senhas erradas → 15 min bloqueado. (Audit log e docs de HTTPS ficam fora.)
- Nomenclatura da UI em inglês (i18n como o resto do app).

## Restrições técnicas

- **Zero dependências nativas novas** (binário único): hash de senha com
  `scrypt` do `node:crypto`; JWT com `@fastify/jwt` (fast-jwt, JS puro) +
  `@fastify/cookie`.
- Segredo JWT: gerado no primeiro boot (32 bytes aleatórios) e persistido em
  `~/.claudinei/jwt-secret` (mode 0600). Boots seguintes reusam.
- JWT de usuário expira em **7 dias**; cookie `httpOnly`, `SameSite=Strict`,
  `Path=/` (sem `Secure` — TLS é responsabilidade de proxy externo, fora de escopo).

## Dados (migração no boot, better-sqlite3)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,        -- scrypt: salt+hash serializados
  is_admin INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,               -- epoch ms; NULL = não bloqueado
  created_at INTEGER NOT NULL
);
CREATE TABLE user_projects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
```

- `authConfigured` ⇔ `COUNT(users) > 0`.
- Payload do JWT de usuário: `{ sub: <userId>, ver: <token_version> }`, exp 7d.
- Payload do JWT de serviço: `{ sub: 'service' }`, assinado a cada boot (validade
  até o próximo boot na prática; exp 30d por segurança).

## Componentes

### `server/src/auth/` (módulo novo)

- **`passwords.ts`** — `hashPassword(plain)` / `verifyPassword(plain, stored)` com
  `scrypt` (N=16384, salt 16B aleatório, hash 32B; formato `scrypt:<saltB64>:<hashB64>`),
  comparação com `timingSafeEqual`.
- **`users.ts`** — serviço CRUD sobre `users`/`user_projects`: create, list (sem
  hash), update (senha/admin/projetos), delete, `allowedProjects(userId)`,
  lockout (`registerFailure`, `clearFailures`, `isLocked` → ms restantes),
  `bumpTokenVersion(userId)` e `revokeAll()` (incrementa todos), `count()`.
  Regra: não é possível excluir/des-adminar o último admin.
- **`plugin.ts`** — plugin Fastify: registra `@fastify/cookie` + `@fastify/jwt`
  (cookie `claudinei_token`); hook `onRequest` global:
  1. Rotas públicas passam: `POST /api/auth/login`, `POST /api/auth/setup`,
     `GET /api/auth/me` (responde estado mesmo sem login: `{setupRequired}` ou 401)
     e tudo que NÃO começa com `/api/` nem é `/ws` (assets do SPA — a tela de
     login precisa carregar).
  2. Com 0 usuários: requisição não-loopback a QUALQUER rota (inclusive assets)
     → 403 `{ error: 'setup_required_localhost_only' }`.
  3. Demais: extrai JWT do cookie ou `Authorization: Bearer`; inválido/expirado → 401.
     Token de usuário: carrega o user, confere `ver === token_version` (senão 401 —
     é a revogação), anexa `req.user = { id, username, isAdmin, projectIds }`.
     Token de serviço (`sub:'service'`): `req.user = { service: true }` e só passa
     em `/api/hermes/*` (resto → 403).
- **`guards.ts`** — `requireAdmin(req, reply)` e
  `requireProjectAccess(req, reply, projectId)` (admin sempre passa; service não
  usa). Retornam boolean e respondem 403 sozinhos.
- **`routes.ts`** — `/api/auth/*`:
  - `POST /setup` (só loopback + só com 0 usuários) → cria admin master + já loga (cookie).
  - `POST /login` → lockout check (429 + `retryAfterMs`), verify, 5 falhas → +15 min,
    sucesso limpa falhas e seta cookie.
  - `POST /logout` → limpa cookie.
  - `GET /me` → `{ setupRequired }` sem auth; logado → `{ id, username, isAdmin, projectIds }`.
  - `POST /password` → troca a própria senha (exige a atual) e bumpa `token_version`
    (reloga o próprio via novo cookie na resposta; outros dispositivos caem).
  - Admin: `GET/POST/PATCH/DELETE /users` (CRUD, lista de projetos, flag admin,
    reset de senha) e `POST /revoke-all` → `revokeAll()` + derruba todos os sockets WS.

### Enforcement nas rotas existentes

- **Admin-only:** rotas de criar/editar/excluir terminal (`projects.ts`/`sessions.ts`
  de escrita estrutural), `/api/fs/*` e `/api/usage`.
- **Qualquer usuário autenticado:** uploads (anexos de chat) e transcrição de voz
  (`/api/transcribe`) — o envio da mensagem em si já é barrado pelo RBAC da sessão.
- **Filtrado por lista:** listagem de sessões/projetos e todas as operações por
  `localId` resolvem o projeto e chamam `requireProjectAccess`. Rotas de terminal
  PTY idem.
- **`/api/hermes/*`:** aceita token de serviço OU usuário (admin vê tudo; não-admin
  filtrado pela lista onde aplicável).
- **WS (`routes/ws.ts`):** handshake exige JWT válido do cookie (senão fecha com
  1008). O hub guarda `{ socket, userId, isAdmin, projectIds }`; `broadcast` ganha
  filtro por `projectId` do evento (eventos sem projeto — ex.: usage — só admin).
  `sessions_snapshot` filtrado. `send_message`/`interrupt`/`mark_read` conferem
  acesso ao projeto da sessão. `revoke-all`/mudança de `token_version` fecha os
  sockets do(s) usuário(s) afetado(s).

### Wiring

- **`index.ts`:** `authConfigured` real (users.count() > 0) no
  `assertExposureAllowed`; cria o serviço, assina o token de serviço e injeta
  `CLAUDINEI_SERVICE_TOKEN` no env do hermes (via `hermesArgs`/env do mcp-config
  em `claude/session.ts`).
- **`server/src/hermes/run-hermes.ts`:** lê `CLAUDINEI_SERVICE_TOKEN` do env e
  manda `Authorization: Bearer` em todas as chamadas à API.

### Frontend (`web/`, padrão Glass, i18n)

- **Gate de boot:** o app chama `GET /api/auth/me` antes de abrir o WS.
  `setupRequired` → tela **Create master account** (username+senha+confirmação);
  401 → tela **Sign in** (username+senha; erro de lockout mostra contagem);
  ok → app normal (o store guarda `me`).
- **Menu 👤 ao lado do logo:** *Change password* (modal: atual + nova + confirmação),
  *Manage users* (só admin), *Sign out*.
- **Manage users (modal admin):** lista de usuários (username, admin?, terminais);
  criar/editar (username, senha opcional no edit, flag admin, checkboxes dos
  terminais existentes); excluir (confirmação); botão **Revoke all sessions**
  (confirmação; ao concluir o próprio admin também relogará).
- **Não-admin:** sidebar sem botões de criar/editar/excluir terminal, sem usage
  card, sem file browser; vê apenas os terminais permitidos.
- 401 em qualquer fetch/WS após logado → volta para a tela de login (cookie
  expirado/revogado).

## Erros / bordas

| Situação | Comportamento |
|---|---|
| 0 usuários + acesso da rede | 403 `setup_required_localhost_only` em tudo |
| 5 senhas erradas | 429 com `retryAfterMs`; zera após sucesso pós-desbloqueio |
| JWT com `ver` antigo (revogado/senha trocada) | 401 → tela de login; WS fechado |
| Excluir/des-adminar o último admin | 400 `last_admin` |
| Excluir usuário logado | seus JWTs morrem (user não existe → 401) |
| Projeto excluído | `user_projects` fica órfão inofensivo (join não retorna); limpeza no delete do projeto |
| Token de serviço fora de `/api/hermes/*` | 403 |
| Segredo JWT apagado do disco | novo segredo no boot → todos deslogados (aceitável) |

## Testes

- Unit: `passwords` (hash/verify/formato inválido), `users` (CRUD, lockout com
  clock injetado, last-admin, revokeAll), `guards`, filtro do broadcast.
- Integração (Fastify inject): setup só loopback/só com 0 usuários; login seta
  cookie; 401 sem/como token inválido; 403 não-admin em rota admin; 403 fora da
  lista; revoke-all mata JWT antigo; bearer de serviço passa em hermes e 403 fora;
  WS sem cookie fecha 1008.
- Smoke real (máquina do usuário): criar master via localhost, expor
  `--host 0.0.0.0` sem `--insecure`, logar de outro dispositivo, usuário
  não-admin restrito, revoke-all derruba tudo.

## Fora de escopo (YAGNI)

- Audit log e tela de consulta.
- HTTPS/TLS embutido ou documentação de reverse proxy.
- Nível read-only por terminal (acesso é binário).
- Refresh token / expiração deslizante (JWT fixo de 7 dias).
- Recuperação de senha esquecida (admin reseta; se o master esquecer:
  apagar `users` no sqlite via shell — documentado no README).
