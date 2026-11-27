# Link de pasta na conversa — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pastas citadas na conversa viram link, com um menu de Copiar caminho, Copiar caminho completo e Abrir a pasta.

**Architecture:** reaproveita o caminho dos links de arquivo. A detecção no texto (`web/src/files.ts`) passa a aceitar caminhos sem extensão. O servidor confirma diretórios por uma opção nova de `resolveInScope`, usada só pelas rotas resolve e reveal. O `FileOpenMenu` ganha um modo pasta quando `kind === 'folder'`.

**Tech Stack:** TypeScript; Fastify e Vitest no servidor (Node 24); React, Vitest e Testing Library no web.

**Spec:** `docs/superpowers/specs/2026-11-27-link-de-pasta-design.md`

## Global Constraints

- Só vira link o que o servidor confirma (`exists && inScope && kind`).
- Fora do escopo, para não-admin, a resposta é "não existe" (`{ exists: false, inScope: false }`), sem oráculo de existência.
- As rotas que leem conteúdo (content, raw, preview, write, list) continuam sem aceitar diretórios: não passam `allowDir`.
- "Abrir a pasta" só aparece com `isLocalHost()`, e a rota reveal continua barrando acesso não local (`isTrustedLocal`).
- Rótulos: pt-BR "Abrir a pasta", en "Open folder", es "Abrir la carpeta".
- `real` nunca vai ao cliente.
- Servidor: `PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run` e `npx tsc --noEmit` em `server/`. Web: `npx vitest run` e `npx tsc -b` em `web/`, apagando antes o `web/tsconfig.tsbuildinfo`.

## Review Focus

1. Caminho no fim da frase (`veja src/components.`): o candidato é `src/components`, sem o ponto final. Teste na Task 2.
2. Pasta fora do projeto para não-admin, inclusive por symlink que aponta para fora: responde "não existe". Teste na Task 1.
3. Conteúdo de pasta pedido às rotas de leitura (`GET /api/files/content?path=<pasta>`): continua recusado, sem erro 500 de EISDIR. Teste na Task 1.
4. Pasta com ponto no nome (`~/.claude`) já casa como "arquivo com extensão" no texto: o servidor responde `folder` e o menu fica em modo pasta. Testes nas Tasks 1 e 3.
5. Barra final (`docs/hoanglong/`): o servidor resolve a pasta mesmo com a `/` no fim. Teste na Task 1.

---

### Task 1: Servidor confirma e abre pastas

**Files:**
- Modify: `server/src/files/scope.ts` (`FileKind`, `resolveInScope`)
- Modify: `server/src/routes/files.ts` (rotas `/api/files/resolve` e `/api/files/reveal`)
- Test: `server/test/files-scope.test.ts`, `server/test/files-reveal.test.ts`, `server/test/files-routes.test.ts`

**Interfaces:**
- Produces: `export type FileKind = 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'binary' | 'folder'`
- Produces: `resolveInScope(raw: string, project: { id: number; path: string } | null, isAdmin: boolean, opts?: { allowDir?: boolean }): ScopeResult`. Com `allowDir` e um diretório, aplica a mesma regra de escopo dos arquivos (admin sem base removida: sim; senão `isUnderProjectRoot`; fora → `missing`) e devolve `{ path: raw, exists: true, inScope: true, kind: 'folder', real }`, sem `size`. Sem `allowDir`, o comportamento é o de hoje.

- [ ] **Step 1: Testes que falham**
  - `files-scope.test.ts`, describe `resolveInScope com allowDir`:
    - `'pasta do projeto vira folder'`: `resolveInScope('engine', proj, false, { allowDir: true })` → `{ exists: true, inScope: true, kind: 'folder' }` e `real` igual a `realpathSync(join(root,'engine'))`.
    - `'barra final resolve a mesma pasta'`: `'engine/'` → `kind: 'folder'`.
    - `'sem allowDir a pasta continua fora'`: `resolveInScope('engine', proj, false)` → `inScope: false`, sem `kind`.
    - `'pasta fora do projeto para não-admin é missing'`: um `mkdtempSync` fora da raiz → `{ exists: false, inScope: false }`.
    - `'symlink de pasta para fora é missing para não-admin'`: `symlinkSync(fora, join(root,'link'))` → `'link'` dá `{ exists: false, inScope: false }`.
    - `'admin vê pasta absoluta fora do projeto'`: `isAdmin: true` → `kind: 'folder'`.
  - `files-reveal.test.ts`: `'abre a PRÓPRIA pasta quando o caminho é uma pasta'`: `reveal({ path: 'engine', projectId: 1 })` → 200 e `revealed` igual a `[join(root,'engine')]`. Mesmo resultado para `'engine/'`.
  - `files-routes.test.ts`:
    - `'resolve responde folder para pasta, sem real'`: o POST `/api/files/resolve` com `['engine']` devolve `[{ path:'engine', exists:true, inScope:true, kind:'folder' }]`, sem a chave `real`.
    - `'content de pasta continua recusado'`: `GET /api/files/content?path=engine&projectId=1` dá status 4xx, nunca 500.
- [ ] **Step 2:** rodar `npx vitest run test/files-scope.test.ts test/files-reveal.test.ts test/files-routes.test.ts` e conferir que os testes novos falham (o de content pode já passar, e isso documenta o comportamento).
- [ ] **Step 3:** implementar `allowDir` em `resolveInScope`. Trocar a linha `if (!st.isFile())` por: diretório com `allowDir` segue para a regra de escopo com `kind: 'folder'`; qualquer outro não-arquivo mantém o retorno de hoje. A rota resolve passa `{ allowDir: true }`. A rota reveal passa `{ allowDir: true }` e abre `r.kind === 'folder' ? r.real : dirname(r.real)`.
- [ ] **Step 4:** rodar a suíte do servidor inteira e `npx tsc --noEmit`, ambos sem falhas.
- [ ] **Step 5:** commit `feat(arquivos): servidor confirma pastas e o reveal abre a própria pasta`.

### Task 2: Detecção de pastas no texto

**Files:**
- Modify: `web/src/files.ts` (regexes, `candidateRanges`, `FileKind`, `kindOfPath`)
- Test: `web/src/test/files.test.ts`

**Interfaces:**
- Consumes: `'folder'` em `FileKind` (espelho do servidor, Task 1).
- Produces: `extractCandidatePaths` e `splitCandidatePaths` também devolvem caminhos sem extensão, e `kindOfPath(p)` devolve `'folder'` quando `p` termina em `/`.

- [ ] **Step 1: Testes que falham.** Os testes `'ignora trechos tipo a/b sem extensão'` e `'ignora path absoluto sem extensão'` contradizem a opção (b) aprovada. Eles viram:
  - `'a/b sem extensão vira candidato (o servidor decide)'`: `extractCandidatePaths('a relação entre a/b')` → `['a/b']`.
  - `'absoluto sem extensão vira candidato'`: `'olha em /usr e /home/user/docs'` → `['/usr', '/home/user/docs']`.

  Novos:
  - `'pasta relativa com barra final'`: `'pasta docs/hoanglong/ pronta'` → `['docs/hoanglong/']`.
  - `'pasta com ~'`: `'em ~/.claudinei/uploads/'` → `['~/.claudinei/uploads/']`.
  - `'ponto final da frase não entra'`: `'veja src/components.'` → `['src/components']`.
  - `'arquivo com extensão continua igual'`: `'src/components/App.tsx e /home/u/a.ts'` → `['/home/u/a.ts', 'src/components/App.tsx']`. A ordem segue a posição no texto quando se usa `splitCandidatePaths`; com `extractCandidatePaths`, compare com `toEqual(expect.arrayContaining(...))` e o tamanho.
  - `'URL continua ignorada'`: `'https://site.com/a/b'` → `[]`.
  - `'kindOfPath de barra final é folder'`: `kindOfPath('docs/x/')` → `'folder'`.
- [ ] **Step 2:** rodar `npx vitest run src/test/files.test.ts` e conferir que os novos falham.
- [ ] **Step 3:** implementar. Rodar duas regexes de pasta *depois* das de arquivo, pulando sobreposições:
  - absoluta: `/(?<!\w)(?:~\/|\/)[\w.\-+@]+(?:\/[\w.\-+@]+)*\/?/g`;
  - relativa: `/\b[\w.\-]+(?:\/[\w.\-]+)+\/?/g`.

  Tirar do fim de cada casamento os `.` e `-` soltos, ajustando o `end`. `FileKind` ganha `'folder'`, e `kindOfPath` devolve `'folder'` para barra final.
- [ ] **Step 4:** rodar `npx vitest run src/test/files.test.ts src/test/messageblock-files.test.tsx`, que passam.
- [ ] **Step 5:** commit `feat(arquivos): pastas citadas no texto viram candidatas a link`.

### Task 3: Menu em modo pasta

**Files:**
- Modify: `web/src/components/FileOpenMenu.tsx`
- Modify: `web/src/i18n/pt-BR.ts`, `web/src/i18n/en.ts`, `web/src/i18n/es.ts` (chave `fileViewer.openFolder`)
- Test: `web/src/test/file-open-menu.test.tsx`, `web/src/test/messageblock-files.test.tsx`

**Interfaces:**
- Consumes: `FileMenu.kind === 'folder'` (Tasks 1 e 2). O `MessageBlock` já repassa o `kind` resolvido, e ele não muda.

- [ ] **Step 1: Testes que falham**
  - `file-open-menu.test.tsx`, describe `'FileOpenMenu — pasta'`:
    - `'mostra só copiar, copiar completo e abrir a pasta'`: com `kind: 'folder'` e acesso local, os itens são exatamente `['Copiar caminho', 'Copiar caminho completo', 'Abrir a pasta']`, sem popup nem inline, mesmo com `localId`.
    - `'abrir a pasta chama revealFile com o caminho da pasta'`: espiar `revealFile` e esperar a chamada com `('docs/hoanglong/', 1)`.
    - `'sem acesso local, só os dois de copiar'`.
  - `messageblock-files.test.tsx`: `'pasta confirmada vira link e abre o menu em modo pasta'`. Texto do assistente `'pasta \`docs/hoanglong/\`'`; o resolve (mock) responde `kind: 'folder'`; clicar no link deixa `useStore.getState().fileMenu.kind` igual a `'folder'`.
- [ ] **Step 2:** rodar esses dois arquivos e conferir que os novos falham.
- [ ] **Step 3:** no `FileOpenMenu`, com `menu.kind === 'folder'`, não montar `popup` nem `inline` (nem `reference`), e o item de reveal usa o rótulo `t('fileViewer.openFolder')`. Acrescentar a chave nos três idiomas.
- [ ] **Step 4:** rodar a suíte web inteira e `npx tsc -b`, ambos sem falhas. Tratar no `tsc` qualquer `switch` exaustivo em `FileKind` que reclame de `'folder'`.
- [ ] **Step 5:** commit `feat(arquivos): menu da pasta com copiar caminho e abrir a pasta`.

### Task 4: Conferência no navegador

- [ ] Subir uma instância de teste numa porta separada, com o CLI falso e um projeto cuja pasta contenha `docs/hoanglong/`. Mandar o CLI falso responder um texto com `docs/hoanglong/`, `src/components` (inexistente) e `docs/hoanglong/a.md`. No Chromium, conferir:
  - a pasta vira link, e o caminho inexistente não;
  - o clique na pasta abre o menu com os três itens;
  - "Copiar caminho completo" copia o caminho absoluto;
  - o clique no arquivo continua mostrando o menu completo.

  Desligar a instância pelo PID.
