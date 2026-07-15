# Visualizador de arquivos — Design

**Data:** 2026-07-14
**Status:** Aprovado (3 decisões do usuário + default do path relativo)

## Objetivo

Paths de arquivos locais que aparecem no chat (texto do agente, resultados de tool)
viram **clicáveis**; clicar abre um **modal no app** que renderiza o conteúdo conforme
o tipo: imagem→imagem, PDF→PDF, `.md`→markdown formatado, texto/código→texto com
highlight, binário→"sem preview" + baixar.

## Decisões

- **Escopo (segurança):** não-admin só abre arquivos sob os diretórios dos projetos que
  ele acessa (`canAccessProject`); **admin** abre qualquer arquivo legível. Enforçado por
  `realpath` sob uma raiz permitida.
- **UI:** modal dentro da SPA (usa o cookie de auth; fecha com Esc/clique-fora; botão baixar).
- **Detecção:** só paths que **existem no disco e estão no escopo** (verificado no backend)
  viram link — sem links quebrados.
- **Paths relativos:** resolvidos contra a pasta do projeto da **sessão ativa** (o projeto
  da mensagem). Sem projeto resolvível → relativo ignorado; absolutos/`~` seguem.

## Componentes

### Backend — `server/src/routes/files.ts` (novo), atrás da auth

- `POST /api/files/resolve` — body `{ paths: string[], projectId?: number }`. Para cada path:
  normaliza (`~`→home; relativo→`join(project.path, p)` se projectId acessível, senão marca
  não-resolvível); `realpathSync` (segue symlink) e checa que o **path real** está sob a raiz
  permitida (project.path real p/ não-admin; qualquer p/ admin); `statSync` (só arquivo).
  Responde `[{ path, exists, inScope, kind, size }]`. **Nunca devolve conteúdo aqui.**
- `GET /api/files/content?path=…&projectId=…` — revalida escopo idêntico ao resolve; serve o
  arquivo com `Content-Type` por tipo. Imagem/PDF: stream. Texto/markdown/código: lê com teto
  (ex.: 2 MB) — acima disso responde 413/"grande demais". Binário/desconhecido: `application/
  octet-stream` com `Content-Disposition: attachment`.
- **Segurança (o cerne):** um helper `resolveInScope(rawPath, projectId, authUser)` compartilhado
  pelas duas rotas — única fonte de verdade do escopo. Regras: path final absoluto; `realpathSync`
  do arquivo E da raiz, comparados por prefixo com separador (`real.startsWith(root + sep)` ou
  igual) p/ barrar traversal/symlink pra fora; `canAccessProject` no projectId; só `isFile()`;
  admin (`isAdmin`) fura o escopo de projeto mas ainda exige que o arquivo exista/seja legível.
  Nada de `shell`; só `node:fs`. Caps de tamanho. Espelha o gate admin do `/api/fs/list`.
- **`kind`** por extensão: `image` (png/jpg/jpeg/gif/webp/svg/avif/bmp), `pdf`, `markdown` (md/
  markdown), `code` (ts/tsx/js/jsx/py/go/rs/json/yaml/toml/sh/css/html/…), `text` (txt/log/csv/
  outros textuais), `binary` (resto). Sem extensão → `text` (o modal mostra como texto; se vier
  ilegível, o usuário baixa).

### Frontend

- **`web/src/files.ts`** — `extractCandidatePaths(text): string[]` (regex apertado: absolutos `/…`,
  `~/…`, e relativos `a/b.ext` com extensão; ignora URLs `http(s)://`), + client `resolveFiles`/
  `fileContentUrl(path, projectId)`.
- **Detecção no `MessageBlock`** — um plugin `rehype` (`rehypeFilePaths`) varre nós de texto do
  markdown já renderizado e quebra candidatos em nós `<a data-file="…">`; ReactMarkdown renderiza
  via `components.a`. Um efeito por mensagem faz **um** `resolve` em lote dos candidatos daquela
  mensagem (cacheado num store por path); só os `inScope && exists` viram clicáveis (abrem o
  modal), o resto degrada pra texto. projectId = o do `activeLocalId`/da sessão da mensagem.
- **`web/src/components/FileViewerModal.tsx`** — overlay Glass; header com nome/caminho/tamanho +
  baixar + fechar (Esc/clique-fora). Corpo por `kind`: `image`→`<img>`; `pdf`→`<iframe>` same-origin;
  `markdown`→reusa `ReactMarkdown + remarkGfm + rehypeHighlight`; `text`/`code`→`<pre>` + highlight;
  `binary`→"sem preview" + baixar. Estados: carregando, erro (sumiu/403/grande demais).
- **i18n** (en/pt-BR/es): rótulos do modal (fechar, baixar, sem preview, grande demais, erro).

## Bordas

| Situação | Comportamento |
|---|---|
| Arquivo sumiu entre resolve e abrir | modal mostra erro amigável (revalida no content) |
| Fora de escopo | 403 no content; no resolve vem `inScope:false` (nem vira link) |
| Symlink pra fora do escopo | barrado pelo `realpath` (real fora da raiz → inScope:false/403) |
| Texto grande demais | 413 → "grande demais, baixar"; imagem/PDF streamam até um teto maior |
| Path relativo sem projeto | ignorado (não vira candidato) |
| `opencode`/binário exposto na LAN | escopo por projeto vale p/ não-admin; admin assume o risco (documentado) |

## Testes

- `resolveInScope`/rotas: dentro do projeto → ok; fora do projeto (não-admin) → inScope:false;
  admin fora → ok; traversal `../../etc/passwd` → barrado; symlink dentro→fora → barrado; dir →
  rejeitado; relativo resolve contra project.path; kind por extensão; caps de tamanho (content).
- `extractCandidatePaths`: pega absolutos/`~`/relativos-com-extensão; ignora URLs e texto comum.
- `FileViewerModal`: cada `kind` renderiza o elemento certo; erro/loading; fecha no Esc.
- Detecção no MessageBlock: candidato confirmado vira link e abre o modal; não-confirmado fica texto.
- Regressão: chat/markdown atuais intactos; suíte verde.

## Fora de escopo (YAGNI)

Editar arquivos; navegar entre arquivos/árvore de diretórios no modal; diff; thumbnails na
timeline; watch/refresh ao vivo. Só visualizar 1 arquivo sob demanda.
