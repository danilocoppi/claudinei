# Binário único auto-extraível (`npm run package`) — Design

**Data:** 2026-07-12
**Status:** Aprovado (spikes empíricos abaixo)

## Objetivo

`npm run package` gera **um único executável por plataforma** com **tudo dentro**
(servidor + SPA + libs nativas de voz/sqlite/pty + libstdc++ portátil). O usuário
roda um arquivo; a 1ª execução extrai as libs para um cache e baixa o modelo
Parakeet (630MB) para `~/.claudinei/speech`. Depois é só subir na porta 9105.

## Spikes (empíricos, 2026-07-12, Node 24 real)

- `@yao-pkg/pkg` 6.21 tem base **Node 24** ✅.
- Binário com sherpa embutido como asset: no 1º run **extrai as libs do snapshot →
  cache real → transcreve o JFK**; 2º run pula a extração e transcreve de novo ✅.
  Truque validado: re-exec único do próprio binário com `LD_LIBRARY_PATH` apontando
  para o cache (o `dlopen` exige arquivo real em disco; não carrega do snapshot).
- Pendente (de-risk = Task 1): o hermes MCP roda como subprocesso que o `claude`
  spawna; num binário sem Node, o `command` do mcp-config precisa apontar para o
  **próprio binário com `--hermes`** (modo runtime). Provar antes de construir o resto.

## O que vai DENTRO do binário (pkg assets)

- `web/dist` (o SPA buildado).
- Os 3 nativos: `better_sqlite3.node`, `pty.node`, `sherpa-onnx-<plat>` (+ `.so`).
- O libstdc++ portátil (Linux de glibc antiga).
- FORA: o modelo Parakeet (download no 1º uso — binário leve, re-baixável).

## Componentes

### `server/src/pkg-runtime.ts` (novo — só usado dentro do binário)
Funções puras + o orquestrador de extração:
- `isPackaged(): boolean` — detecta o binário pkg (`process.pkg` / `__dirname`
  começando com o prefixo de snapshot). Fora do pkg, tudo isto é no-op.
- `cacheRoot(version: string): string` — `~/.cache/claudinei/native-<version>`
  (respeita `XDG_CACHE_HOME`; fallback `os.tmpdir()`), versionado p/ invalidar no bump.
- `extractTree(srcSnapshot, destReal): void` — copia recursivo via
  `readFileSync`/`writeFileSync` (o `copyFileSync` pode não ler o snapshot); pula
  arquivos já presentes (idempotente).
- `ensureNativeCache(): { nativeDir, webDir, ldPath }` — no 1º run extrai
  `assets/native` e `assets/web` do snapshot para o cache; devolve os caminhos reais
  + o `LD_LIBRARY_PATH` (stdcxx + dir do sherpa). Se o cache já está completo, só
  devolve os caminhos.
- `reexecWithEnv(ldPath): void` — se o `LD_LIBRARY_PATH` ainda não contém o cache,
  re-exec do próprio binário com o env certo e `process.exit`. (o re-exec é o que
  faz o `dlopen` das `.so` funcionar — provado no spike.)

### `server/src/index.ts` (entry, agora multi-modo)
- Se `--hermes` no argv → carrega e roda o hermes MCP (a lógica do
  `hermes-mcp.mjs`, agora importável) via stdio, e sai — NÃO sobe o servidor.
- Senão (modo servidor): se `isPackaged()`, chama `reexecWithEnv` e
  `ensureNativeCache` ANTES de qualquer `require` nativo; usa `nativeDir`/`webDir`
  do cache para o LD_LIBRARY_PATH do sherpa, o `webDist` do static e o speechDir.
  Em dev (não-pkg) nada muda (usa `node_modules` e `web/dist` como hoje).
- O `speechDir` continua `~/.claudinei/speech`; o first-run do modelo passa a ser
  disparado pelo servidor quando o 🎤 é usado sem modelo (ou por um passo do bin)
  — reusa `setup-speech` (que também vira importável, não só script).

### `server/src/hermes/` (tornar o hermes importável)
- Extrair a lógica de `server/hermes/hermes-mcp.mjs` para um módulo TS
  (`runHermes(config)`), chamado tanto pelo modo `--hermes` do binário quanto
  (em dev) pelo `.mjs` fino existente. O mcp-config passa a usar, quando empacotado,
  `command: <caminho-do-binário>, args: ['--hermes', ...]`; em dev, `node <script>`
  como hoje. Um `hermesCommand` no config decide qual.

### `scripts/package.mjs` (raiz — o build)
1. `npm run build -w web` (garante `web/dist`).
2. **esbuild** bundla `server/src/index.ts` → `dist-pkg/server.cjs`, `platform: node`,
   `format: cjs`, `target: node24`, com os 3 nativos + `@fastify/*` que exijam como
   *external* (não bundláveis) — a lista exata sai da 1ª execução do esbuild (ele
   aponta o que não resolve).
3. Monta `dist-pkg/assets/native/` (os `.node`/`.so`/stdcxx da plataforma atual) e
   `dist-pkg/assets/web/` (= `web/dist`).
4. `@yao-pkg/pkg dist-pkg/server.cjs --targets node24-<plat> --output
   release/claudinei-<plat>` com `pkg.assets` = `dist-pkg/assets/**`.
5. Imprime o caminho do binário e o tamanho.
- `package.json` (raiz): `"package": "node scripts/package.mjs"` + devDeps
  `@yao-pkg/pkg`, `esbuild`.

## Fluxo (usuário final)

```
./claudinei-linux-x64
  → 1ª vez: extrai libs+web do binário p/ ~/.cache/claudinei/native-<v>
  → re-exec com LD_LIBRARY_PATH
  → sobe em http://127.0.0.1:9105 (UI servida do cache)
  → 1º uso do 🎤 sem modelo: baixa o Parakeet p/ ~/.claudinei/speech
./claudinei-linux-x64 --host 0.0.0.0 --insecure   # guarda de exposição já existe
```

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Cache não-gravável | erro claro (aponte `XDG_CACHE_HOME` p/ um dir gravável) |
| Bump de versão | cache novo (`native-<v>` versionado); o antigo fica órfão (limpeza manual) |
| Antivírus bloqueia auto-extração | documentado no README (usar o modo dev/`npm start` como alternativa) |
| Build p/ outra plataforma | os prebuilts são da máquina atual; win/mac exigem buildar lá (ou CI) — documentado, não cross-build |
| Hermes: máquina sem `node` | o binário É o runtime (`--hermes`); mcp-config aponta p/ ele |
| Modelo sem rede no 1º uso | 🎤 avisa "modelo não instalado" (como hoje) |

## Testes

- `pkg-runtime`: `cacheRoot` (XDG/tmp/versão), `extractTree` (copia árvore, pula
  existente — com dirs temp), `isPackaged` (false fora do pkg). Puros/mockáveis.
- `hermes`: `runHermes` isolado responde às tools (reusa os testes de rota do hermes;
  o dispatch por `--hermes` é smoke).
- `index` multi-modo: `--hermes` não sobe o servidor (teste do dispatch de argv).
- Smoke (controlador): `npm run package` → rodar `release/claudinei-linux-x64` num
  dir limpo → UI na 9105 + voz (após 1º download) + Board/Tasks (hermes) reais.

## Fora de escopo (YAGNI)

- Cross-build multiplataforma numa máquina só (usar CI matrix quando precisar).
- Assinatura/notarização de binários (macOS/Windows).
- Embutir o modelo de 630MB (decidido: download no 1º uso).
- Auto-update do binário.
