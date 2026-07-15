# Upload de arquivos/imagens no chat — Design

**Data:** 2026-07-10
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Arrastar arquivos ou colar imagens do clipboard direto no campo de mensagem do
chat. O arquivo sobe para o servidor (pasta única com rotação circular dos
últimos **100 arquivos**, global para todos os projetos/sessões) e a mensagem
enviada ao Claude contém o **path absoluto** no lugar onde o anexo foi
colado — o Claude abre o arquivo com a ferramenta Read (bypassPermissions já
ativo nas sessões).

## Decisões do brainstorming

1. **UX: token inline na posição do cursor.** Ao colar/arrastar, o arquivo
   sobe e um token de texto `[📎 017-print.png]` é inserido onde está o
   cursor do textarea. O usuário escreve antes/depois, move e **apaga o token
   como texto normal** (apagou = anexo não vai). No Enviar, cada token
   conhecido é substituído pelo path real, mantendo o texto ao redor.
2. **Abordagem A: `@fastify/multipart`** (FormData nativo do browser,
   streaming para disco, limite embutido). Rejeitada a alternativa de corpo
   cru octet-stream (parsing manual, sem limites prontos).
3. **Limite: 100 MB por arquivo** (decisão do usuário; era 50 no rascunho).
4. **Pasta:** `config.uploadsDir` = `CLAUDINEI_UPLOADS` ?? `~/.termaster/uploads`
   (criada no boot). Nome do arquivo: `NNN-nomeoriginal.ext` (contador
   incremental — nunca colide; o token fica único por tabela).
5. **Rotação global:** após cada gravação, apaga os mais antigos (por mtime)
   até sobrarem 100 — inclusive uploads de outros projetos/sessões.
6. **Zero mudança no pipeline de sessões:** a mensagem final vai por WS como
   texto normal com o path embutido.

## Componentes

### Backend

**`server/src/uploads.ts` — serviço de armazenamento com rotação**
- `sanitizeName(name: string): string` — mantém só `[a-zA-Z0-9._-]`, remove
  `..`, trunca a 80 chars; vazio vira `arquivo`.
- `saveUpload(dir: string, name: string, stream: Readable): Promise<{ path: string; name: string }>`
  — nome final `NNN-<sanitizado>` (NNN = contador persistente derivado do
  maior prefixo existente na pasta + 1, zero-padded a 3), grava por stream,
  retorna path absoluto.
- `rotateUploads(dir: string, keep = 100): void` — lista arquivos por mtime e
  apaga os mais antigos até sobrar `keep`. Chamada após cada `saveUpload`.

**`server/src/routes/uploads.ts`**
- Registra `@fastify/multipart` com `limits: { fileSize: 100 * 1024 * 1024, files: 1 }`.
- `POST /api/uploads` (multipart, campo `file`) → `201 { path, name }`.
- Arquivo ausente no form → 400. Estouro de limite → 413 com mensagem clara.

**`server/src/config.ts`** — novo campo `uploadsDir` (env `CLAUDINEI_UPLOADS`,
default `~/.termaster/uploads`).

### Frontend (`web/src/components/ChatInput.tsx`)

- Estado: `attachments: Map<string, string>` (token → path) e `uploading:
  boolean`.
- `web/src/api.ts`: `uploadFile(file: File): Promise<{ path: string; name: string }>`
  via `FormData` (sem Content-Type manual — o browser põe o boundary).
- **`onPaste`:** `e.clipboardData.files` com itens → para cada `File`, upload
  e inserção do token no `selectionStart`. Imagem colada do clipboard (nome
  genérico tipo `image.png`) é renomeada para `colado-<HHMMSS>.png` antes do
  upload. Texto colado normal segue o fluxo padrão (não interceptar).
- **`onDrop`/`onDragOver`:** solta arquivo(s) → mesmo fluxo, vários arquivos
  = vários tokens em sequência na posição do cursor. Borda destacada durante
  o drag (classe `drag-over`).
- **Token:** `[📎 <nomeFinal>]` (o nome final do servidor, com prefixo NNN —
  único). Inserido no cursor; o usuário pode mover/apagar como texto.
- **`send()`:** substitui cada token conhecido pelo path correspondente
  (replace literal, todas as ocorrências); tokens apagados simplesmente não
  casam e o arquivo órfão sai na rotação. Envia por WS como hoje.
- **`uploading`:** enquanto houver upload em andamento, botão Enviar
  desabilitado e placeholder indica "enviando anexo…".
- Erros de upload: aviso discreto abaixo do textarea (some no próximo upload
  ok ou envio), sem toast global.

## Fluxo

```
cola/arrasta print.png no textarea
  → POST /api/uploads (FormData)
  → salva ~/.termaster/uploads/017-print.png → rotateUploads (apaga além de 100)
  → { path: "/home/coppi/.termaster/uploads/017-print.png", name: "017-print.png" }
  → insere "[📎 017-print.png]" na posição do cursor
usuário termina de digitar → Enviar
  → "olha esse erro [📎 017-print.png] e me diz a causa"
    vira "olha esse erro /home/coppi/.termaster/uploads/017-print.png e me diz a causa"
  → claude lê o path com a ferramenta Read
```

## Tratamento de erros

| Situação | Comportamento |
|---|---|
| Arquivo > 100 MB | 413 do multipart → aviso "arquivo grande demais (máx. 100 MB)" |
| Upload falha (backend fora/erro) | token não é inserido; aviso discreto abaixo do textarea |
| Usuário apaga metade do token | o resto vira texto comum e vai como está (inofensivo) |
| Nome malicioso (`../../etc/passwd`) | sanitização remove `/` e `..` — sempre dentro de `uploads/` |
| Form sem arquivo | 400 |
| Pasta atinge 100 arquivos | rotação apaga os mais antigos por mtime (global) |

## Testes

- **`uploads.ts` (unit):** sanitização (traversal, metachars, vazio→`arquivo`,
  truncamento), contador incremental a partir do maior existente, rotação
  (105 arquivos → sobram os 100 mais novos).
- **Rota (inject com form-data):** POST salva no dir configurado e responde
  `{path,name}` com 201; sem arquivo → 400.
- **ChatInput (testing-library):** paste com `File` no `clipboardData` →
  token inserido na posição do cursor; `send()` substitui token por path;
  token apagado não substitui; drop insere token; Enviar desabilitado durante
  upload.

## Fora de escopo (YAGNI)

- Preview/thumbnail de imagem no chat.
- Listagem/gerência dos uploads na UI.
- Upload por sessão/projeto (a pasta é global por decisão explícita).
- Limpeza por idade (só rotação por contagem).
