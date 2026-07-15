# Comando único (empacotamento) — Design

**Data:** 2026-07-12
**Status:** Aprovado (Sub-projeto 1 de 2; o 2 é auth/multiusuário)

## Objetivo

Rodar o Claudinei como **um processo numa única porta** (o Fastify serve o SPA
buildado + a API), com **first-run automático do Parakeet**, flags `--host/--port`,
e uma **guarda de exposição** que impede abrir na rede sem autenticação até o
Sub-projeto 2 existir.

## Decisões

- Portas padrão: **9105** (backend/app) e **9100** (Vite em dev, proxy → 9105).
- Sem dependências novas além de `@fastify/static` (servir o SPA).
- Comando único = um `bin` Node fino (`.mjs`) que importa o `index.ts` via `tsx`
  (o backend não tem etapa de build; só o `web/dist` precisa existir).

## Componentes

### `server/src/config.ts` (portas + host por flag/env)
- Default port **9105** (`CLAUDINEI_PORT` mantém precedência).
- Novo: `host` configurável — `CLAUDINEI_HOST ?? '127.0.0.1'`.
- `parseCliArgs(argv: string[]): { host?: string; port?: number; insecure?: boolean }`
  — parser puro e testável: reconhece `--host <v>`, `--port <n>`, `--insecure`
  (e `--host=v`/`--port=n`); ignora o resto. Precedência final (no index): flag > env > default.

### `server/src/static.ts`
- `registerStatic(app, webDist: string): Promise<void>` — registra `@fastify/static`
  com `root: webDist`, `wildcard: false`; e um `setNotFoundHandler` que:
  - deixa passar (404 normal) requisições a `/api/*` e `/ws/*`;
  - para qualquer outra, devolve `index.html` (fallback SPA).
- Só é registrado se `existsSync(webDist)`; senão o app sobe só com a API (dev usa
  o Vite) — o `bin` é quem alerta sobre o build faltando.

### `server/src/expose-guard.ts`
- `isLoopbackHost(host: string): boolean` — `127.0.0.1`, `::1`, `localhost`.
- `assertExposureAllowed(host: string, opts: { insecure: boolean; authConfigured: boolean }): void`
  — se o host NÃO é loopback e `!authConfigured && !insecure`, **lança** um Error
  com a mensagem de orientação (expor sem auth = shell aberto; use `--insecure`
  por sua conta e risco, ou aguarde a auth). Loopback nunca bloqueia.
  `authConfigured` é `false` fixo neste sub-projeto (o Sub-projeto 2 passa o valor real).

### `server/src/index.ts` (wiring)
- `const cli = parseCliArgs(process.argv.slice(2))`.
- host/port efetivos = `cli ?? env ?? default` (via config).
- `assertExposureAllowed(host, { insecure: !!cli.insecure, authConfigured: false })`
  ANTES do listen; se lançar, loga a mensagem e `process.exit(1)`.
- Registrar `registerStatic(app, join(__dirname, '..', '..', 'web', 'dist'))` (o
  caminho real do dist relativo ao server compilado/rodando — confirmar na task).
- Log de arranque: `Claudinei em http://<host>:<port>` + aviso vermelho se `insecure`.

### `bin/claudinei.mjs` + `package.json` (raiz)
- `"bin": { "claudinei": "bin/claudinei.mjs" }`.
- O script: (1) se `web/dist` não existe → mensagem clara pedindo `npm run build -w web`
  e sai; (2) garante o Parakeet — se o modelo não está em `speechDir`, executa o
  `server/scripts/setup-speech.mjs` (mesmo do `npm run setup:speech`) com aviso
  "baixando ~630MB, só desta vez"; falha de rede → segue mesmo assim; (3) sobe o
  servidor rodando `tsx server/src/index.ts` (repassando argv), herdando as flags.
- `npm scripts`: `start` = `node bin/claudinei.mjs` (produção local, um comando).

### `web/vite.config.ts`
- `server.port: 9100`, `strictPort`; proxy `/api` e `/ws` → `http://127.0.0.1:9105`
  e `ws://127.0.0.1:9105`.

## Fluxo

```
npm run build -w web        # gera web/dist (1×, ou quando o front muda)
claudinei                   # (ou node bin/claudinei.mjs / npm start)
  → migra ~/.termaster (já existe)
  → 1ª vez: baixa o Parakeet (~630MB)
  → Fastify serve web/dist + API em http://127.0.0.1:9105
claudinei --host 0.0.0.0    # recusa (sem auth) com orientação
claudinei --host 0.0.0.0 --insecure   # sobe com aviso (rede confiável, risco seu)
```

## Erros / bordas

| Situação | Comportamento |
|---|---|
| `web/dist` ausente | bin: erro claro + `npm run build -w web`; (o servidor puro sobe só API p/ dev) |
| Parakeet sem rede no 1º run | setup falha, servidor sobe; 🎤 avisa "modelo não instalado" |
| `--host 0.0.0.0` sem auth, sem `--insecure` | recusa subir com orientação; exit 1 |
| `--host 0.0.0.0 --insecure` | sobe + aviso vermelho no log |
| `--port` inválido / porta ocupada | EADDRINUSE já explícito |
| Rota SPA (ex.: `/algo`) | fallback devolve index.html |
| `/api/inexistente` | 404 normal (não vira index.html) |

## Testes

- `parseCliArgs`: `--host/--port/--insecure`, forma `--x=v`, ausência → {}, precedência.
- `config`: default port 9105; `CLAUDINEI_HOST`/`CLAUDINEI_PORT` respeitados.
- `registerStatic`: `GET /` → index.html; `GET /rota-spa` → index.html; `GET /api/x`
  inexistente → 404 (não index.html); sem `web/dist` → não registra (app só-API sobe).
- `expose-guard`: loopback sempre ok; não-loopback sem auth/insecure → lança;
  com insecure → não lança; com authConfigured → não lança.
- Smoke (controlador): `npm run build -w web` + subir e abrir a UI na 9105 servida
  pelo próprio backend; `--host 0.0.0.0` recusando; `--insecure` subindo.

## Fora de escopo (Sub-projeto 2)

- Autenticação/JWT, usuários, permissões por terminal, painel admin — quando
  existirem, `authConfigured=true` dispensa o `--insecure`.
- Binário único autocontido (inviável pelos módulos nativos node-pty/better-sqlite3/
  sherpa-onnx que exigem `.node`/`.so` em disco).
- HTTPS/TLS (fica para a exposição "de verdade" do Sub-projeto 2).
