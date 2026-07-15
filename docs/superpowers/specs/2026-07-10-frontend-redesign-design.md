# Redesign do frontend do Termaster — Design

**Data:** 2026-07-10
**Status:** Aprovado pelo usuário (brainstorm concluído)

## Problema

O frontend atual funciona mas é visualmente básico e a criação de projeto é friccional: o caminho da pasta é digitado à mão (fácil de errar), o ícone é um campo de texto sem opções para escolher, e a cor não é exibida após selecionada.

## Objetivo

1. Aplicar uma direção visual arrojada e coesa — **Glass/Aurora** — ao app inteiro.
2. Substituir o campo de caminho por um **seletor de pastas navegável** que devolve o caminho absoluto real.
3. Substituir o campo de ícone por um **seletor de emojis completo** (categorias + busca).
4. **Exibir a cor** selecionada e oferecer um **preview ao vivo** do card do projeto no modal de criação.

## Decisões (do brainstorm)

| Tema | Decisão |
|---|---|
| Direção visual | Glass/Aurora (vidro fosco translúcido sobre gradiente aurora), aplicada ao **app inteiro** |
| Seletor de pastas | Navegador de diretórios **servido pelo backend**, iniciando na **home (`~`)** |
| Seletor de ícones | Picker de **emojis completo** (lib `emoji-picker-react`, modo emoji **nativo** — sem rede) |
| Cor | Swatch + hex visível ao lado do seletor |
| Preview | **Mini-card ao vivo** no modal, refletindo nome/ícone/cor em tempo real |

## Por que o seletor de pastas precisa do backend

Um navegador não expõe o caminho absoluto real de uma pasta do sistema (`<input webkitdirectory>` e a File System Access API bloqueiam isso por segurança). Como o Termaster é local, o backend — que tem acesso ao filesystem — expõe a navegação de diretórios e o frontend a renderiza. Isso não adiciona risco material: o app é localhost-only, single-user, e já executa o `claude` com acesso total à máquina; listar diretórios é estritamente menos poderoso.

## Componentes

### Backend

**`server/src/routes/fs.ts`** — `GET /api/fs/list?path=<abs>`:
- Sem `path` (ou vazio): usa o home do usuário (`os.homedir()`).
- Resolve o path para absoluto; valida que existe e é diretório legível.
- Resposta: `{ path: string, parent: string | null, entries: Array<{ name: string, path: string, isDir: boolean }> }`, com `entries` contendo **apenas diretórios** (arquivos omitidos), ordenados por nome, ignorando entradas ocultas por padrão (nomes iniciando com `.`) exceto quando já se está dentro de uma pasta oculta.
- `parent` é `null` na raiz do filesystem (`/`).
- Erros: path inexistente/não-diretório/sem permissão → HTTP 400 com `{ error }`.

Registrado em `buildApp` junto às demais rotas.

### Frontend

**Tema (`web/src/styles.css`, reescrito):** variáveis para o gradiente aurora de fundo, superfícies de vidro (`--glass-bg`, `--glass-border`, blur), texto, e os estados de status já existentes recolorizados para a paleta. Classes utilitárias `.glass`, `.glass-strong`. As classes atuais (`.app`, `.sidebar`, `.card`, `.badge`, `.status-*`, `button`, `input`) são reestilizadas. Estilos inline visíveis nos componentes de chat (`MessageBlock`, `ToolCallCard`, `ChatView`, `DiffView`) migram para classes temáticas onde afetam a coesão; detalhes finos podem permanecer inline.

**`web/src/components/FolderPicker.tsx`** — painel de vidro:
- Props: `{ initialPath?: string, onSelect: (path: string) => void, onClose: () => void }`.
- Carrega `/api/fs/list` (sem path → home) ao montar; mantém `current`, `entries`, `parent`, `error`.
- Breadcrumb do caminho atual; botão "⬆ subir" (desabilitado quando `parent === null`); lista de subpastas clicáveis (clicar navega para ela); botão "Selecionar esta pasta" → `onSelect(current)`.
- Erro de navegação é exibido e o painel permanece no diretório anterior válido.

**`web/src/components/EmojiPicker.tsx`** — wrapper sobre `emoji-picker-react`:
- Props: `{ onSelect: (emoji: string) => void, onClose: () => void }`.
- `<EmojiPicker emojiStyle="native" onEmojiClick={(e) => { onSelect(e.emoji); onClose() }} />`, dentro de um popover de vidro. `theme="dark"`.

**`web/src/components/ColorField.tsx`** — `{ value: string, onChange: (hex: string) => void }`: `<input type="color">` + swatch quadrado com a cor + o código hex em texto mono.

**`web/src/components/ProjectPreviewCard.tsx`** — `{ name, icon, color }`: renderiza um card idêntico ao `ProjectCard` do dashboard (borda colorida, ícone, nome), sem sessão/ações — só o preview.

**`web/src/components/NewProjectModal.tsx` (reformulado):**
- Campo de nome (texto).
- Botão "Escolher pasta…" mostrando o path atual (ou placeholder); abre o `FolderPicker`; ao selecionar, guarda o path.
- Botão de ícone mostrando o emoji atual; abre o `EmojiPicker`.
- `ColorField` para a cor.
- `ProjectPreviewCard` ao vivo com os valores atuais.
- "Criar" chama `createProject` (validação de diretório existente já ocorre no backend) e recarrega a lista; erros exibidos no modal.

## Fluxo de dados

Sem mudança no modelo (`Project { id, name, path, color, icon }`). O modal apenas captura `path` via FolderPicker e `icon` via EmojiPicker em vez de texto livre. O endpoint `fs/list` é só-leitura e não persiste nada.

## Tratamento de erros

- `fs/list`: path inválido/sem permissão → 400 `{ error }`; o FolderPicker mostra a mensagem e mantém o diretório válido anterior.
- Criação de projeto: diretório inexistente já é rejeitado pelo backend (comportamento atual preservado); o path agora vem do picker, então o caso comum não erra.
- `emoji-picker-react` em modo nativo não faz requisições de rede; sem dependência externa em runtime.

## Estratégia de testes

- **Backend:** `fs/list` lista apenas subdiretórios de um tmp dir (com arquivos e subpastas misturados), retorna `parent` correto, usa home quando `path` ausente, e responde 400 para path inexistente.
- **Frontend:** FolderPicker navega (mock de `fetch`) e chama `onSelect` com o path; EmojiPicker chama `onSelect` ao clicar num emoji; ColorField reflete/emite o hex; NewProjectModal mostra o preview refletindo nome/ícone/cor e cria com os valores capturados; smoke de que o tema carrega sem erro.

## Fora de escopo

- Digitar caminho manualmente (substituído pelo picker; um fallback de digitação não é necessário para uso local).
- Upload/ícones customizados além de emojis.
- Mudanças de layout estrutural (a disposição dashboard/sidebar/chat permanece; muda o visual, não a arquitetura de telas).
