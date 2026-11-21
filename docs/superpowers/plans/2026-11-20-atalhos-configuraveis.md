# Atalhos configuráveis — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um registro central dos atalhos, uma função única de casamento (`matchShortcut`), `Mod` uniforme (⌘ no Mac, Ctrl nos outros), troca de tecla das oito ações gerais numa aba **Atalhos** do painel de aparência, com aviso de conflito, e a escolha guardada na conta do usuário.

**Architecture:**
- **Web, núcleo puro** (`web/src/shortcuts/`): `combo.ts` lê, compara, formata e grava combinações; `registry.ts` lista editáveis, fixos, reservados e avisos do navegador; `resolve.ts` confere uma combinação (`checkCombo`) e monta o mapa valendo (`resolveBindings`).
- **Web, ligação:** a store guarda `keybindings: { overrides, resolved, notices }`, com cache em localStorage. `shortcuts/active.ts` expõe `matchShortcut(e, id)`, `inShortcutScope(id, target, campo)` e `useShortcutLabel(id)`. Os ouvintes continuam onde estão; só a pergunta "é este atalho?" e a regra de foco mudam.
- **Servidor:** `user_prefs.keybindings` (TEXT, nula) guarda só as diferenças do padrão; `sanitizeKeybindings` confere a forma; `GET/PUT /api/prefs` passam a levar `appearance` e `keybindings`, ambos opcionais no PUT.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor); React + zustand + i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-atalhos-configuraveis-design.md` (inclui "Decisões de quem escreveu" e as listas completadas na checagem do construtor).

## Global Constraints

- **Editáveis, na ordem do registro** (id · padrão · escopo):
  `chat.send` Mod+Enter página · `chat.queue` Alt+Enter campo · `chat.voice` Ctrl+Space página · `chat.stash` Mod+S campo · `chat.find` Mod+F conversa · `view.zen` Alt+Z tudo menos o terminal · `view.usage` Mod+U fora de campos (só admin) · `triage.undo` Mod+Z fora de campos e modais.
- **Gramática** (cliente e servidor iguais): `^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|Enter|Space|F[1-9]|F1[0-2])$`. Modificadores sempre na ordem `Mod`, `Ctrl`, `Alt`, `Shift`.
- **`Mod`** é ⌘ (`metaKey`) no Mac e Ctrl nos outros; **`Ctrl`** é sempre Control. Fora do Mac `Mod` ≡ `Ctrl`, e a gravação guarda `Mod`; a tecla Super/Windows não vale. No Mac, ⌘ grava `Mod` e Control grava `Ctrl`.
- **`isMac()`**, um lugar só: `navigator.userAgentData?.platform` ou `navigator.platform` contendo `Mac`, `iPhone` ou `iPad`. Avaliado a cada chamada (os testes simulam o Mac trocando `navigator.platform`).
- **Casamento:** modificadores exatos; letra por `e.key`, posição (`KeyX`) só quando `e.key` é letra de outro alfabeto ou `Dead`, e sempre por posição no Mac com Option; dígito por `DigitN`; `isComposing` nunca casa.
- **Recusas** ao gravar e ao resolver: fora da gramática; letra, dígito, Enter ou Espaço sem Ctrl, ⌘ ou Alt (F1–F12 podem ir sozinhas); `Ctrl+Alt` fora do Mac; reservadas; fixo no mesmo lugar. **Aviso amarelo, aceito:** Mod+R, L, P, D, G, J, O; Alt+D, E, F fora do Mac.
- **Banco:** só as diferenças: `{ "view.zen": "Alt+M", "triage.undo": null }`; `null` = sem atalho; quem nunca mexeu = `{}`. Id `^[a-z][a-z0-9.-]{0,40}$`, até 64 entradas; o que não passa é descartado sem recusar o resto. JSON corrompido vale `{}`.
- **Cache web:** `localStorage['claudinei:keybindings']`, guarda as `overrides` (não o resolvido).
- **Sem prévia ao vivo** dos atalhos: só valem depois de Salvar. PUT só com o que mudou.
- **Interface sem GPU** (AGENTS.md): nada de animação nova; usar as variáveis de tema. Textos de tela nas três línguas (pt-BR com acentos, en, es), tipados por `typeof en`. Comentários de código em português.
- **Ambiente:** `N24=/usr/local/n/versions/node/24.15.0/bin`.
  - Servidor: `cd server && PATH=$N24:$PATH npx vitest run <arquivo>`; tipos: `cd server && PATH=$N24:$PATH npx tsc --noEmit`.
  - Web: `cd web && npx vitest run <arquivo>`; tipos: `cd web && npx tsc -b` (não commitar `web/tsconfig.tsbuildinfo`).
  - `node_modules` do worktree são symlinks: **nunca** `npm install`.
  - Commits só com `git add <arquivos>` explícitos; mensagem termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ensaio:** porta **9197**, dados em `/tmp/claudinei-e2e-atalhos`. Nunca a 9105; nunca reiniciar o serviço.

## Review Focus

1. **Gravar com um atalho "de verdade".** Enquanto a aba grava, Alt+Enter não enfileira, Ctrl+Espaço não abre o microfone, Mod+S não guarda e Alt+Z não liga o Zen, nem com o foco no campo de mensagem. Teste na Task 8.
2. **Tecla não aceita durante a gravação** (vírgula, Tab, seta, Super fora do Mac). Não grava, a linha avisa "tecla não aceita" e continua esperando; Tab não tira o foco do painel. Teste na Task 8.
3. **Gravar o próprio padrão (ou a combinação que já vale).** Não cria diferença em `overrides`; sem outra mudança, Salvar fecha sem PUT. Teste na Task 8.
4. **Servidor fora ou antigo.** `GET /api/prefs` falhando, ou respondendo sem `keybindings`: os atalhos ficam no cache (ou nos padrões), sem erro. Teste na Task 4.
5. **Não administrador.** A combinação do uso (linha oculta) não fica ocupada: gravar Mod+U no Zen não acusa conflito com "Página de uso", e Mod+U liga o Zen. Testes nas Tasks 3 e 8.

---

### Task 1: Servidor — coluna, saneamento e rotas

**Files:**
- Modify: `server/src/db.ts` (perto de `:284`, depois do `CREATE TABLE user_prefs`): `try { ALTER TABLE user_prefs ADD COLUMN keybindings TEXT } catch {}`.
- Modify: `server/src/prefs.ts`
- Modify: `server/src/routes/prefs.ts`
- Test: `server/test/prefs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // prefs.ts
  export type Keybindings = Record<string, string | null>
  export const KEYBINDING_ID = /^[a-z][a-z0-9.-]{0,40}$/
  export const KEYBINDING_COMBO = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|Enter|Space|F[1-9]|F1[0-2])$/
  export const MAX_KEYBINDINGS = 64
  export function sanitizeKeybindings(input: unknown): Keybindings   // não objeto (array, string, null) → {}; guarda as 64 primeiras entradas válidas
  // createPrefsService(db): get/set da aparência continuam iguais; o UPSERT da aparência não toca em keybindings
  getKeybindings(userId: number): Keybindings      // sem linha ou JSON corrompido → {}
  setKeybindings(userId: number, input: unknown): Keybindings
  //   INSERT (user_id, appearance=JSON(DEFAULT_APPEARANCE), keybindings) ON CONFLICT DO UPDATE SET keybindings=excluded.keybindings
  // routes/prefs.ts
  // GET  /api/prefs → { appearance, keybindings }   (token de serviço: { appearance: DEFAULT_APPEARANCE, keybindings: {} })
  // PUT  /api/prefs  body { appearance?, keybindings? } → { appearance, keybindings } (saneados, relidos do banco)
  //   campo ausente (undefined) não muda; os dois gravam numa transação; token de serviço → 403
  ```

- [ ] **Step 1: Testes que falham** em `server/test/prefs.test.ts`:
  - `describe('saneamento dos atalhos')`:
    - `aceita combinação válida e null`: `{ 'view.zen': 'Alt+M', 'triage.undo': null }` volta igual.
    - `descarta id ou combinação fora do formato sem recusar o resto`: `{ 'View.Zen': 'Alt+M', 'chat.send': 'Ctrl+Alt', 'chat.find': 'Mod+Shift+F', '__proto__': 'Alt+A', 'x': 3 }` → `{ 'chat.find': 'Mod+Shift+F' }`.
    - `guarda no máximo 64 entradas`: 70 ids válidos → 64 chaves, as primeiras.
    - `não objeto vale {}`: `[]`, `'Alt+M'`, `null`, `undefined` → `{}`.
  - `describe('serviço')`:
    - `sem linha, os atalhos são {}`.
    - `gravar atalhos num usuário sem linha guarda a aparência padrão`: `setKeybindings(7, {...})` e `get(7)` `toEqual(DEFAULT_APPEARANCE)`.
    - `gravar a aparência não apaga os atalhos, e vice-versa`.
    - `JSON corrompido na coluna vale {}`: `UPDATE user_prefs SET keybindings='{'`.
    - `banco antigo ganha a coluna ao abrir`: arquivo em `mkdtempSync` com `CREATE TABLE user_prefs (user_id INTEGER PRIMARY KEY, appearance TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))` e uma linha; `openDb(arquivo)`; a linha antiga lê `{}` e aceita `setKeybindings`.
  - `describe('rotas /api/prefs')` (no `beforeEach` existente):
    - `GET devolve aparência e atalhos`: `json()` tem as duas chaves; `keybindings` `toEqual({})`.
    - `PUT só com keybindings não mexe na aparência`: antes PUT `{ appearance: { theme: 'light-fun' } }`; depois PUT `{ keybindings: { 'view.zen': 'Alt+M' } }`; GET dá `theme 'light-fun'` e `keybindings { 'view.zen': 'Alt+M' }`.
    - `PUT só com appearance não mexe nos atalhos`.
    - `PUT vazio não muda nada e devolve os dois`.
    - `token de serviço: GET devolve {} e PUT dá 403`: `authorization: \`Bearer ${auth.tokens.signService()}\``.
- [ ] **Step 2: Rodar e ver falhar.** `cd server && PATH=$N24:$PATH npx vitest run test/prefs.test.ts`
- [ ] **Step 3: Implementar.** O teste antigo `sem auth, grava na linha 0` continua valendo. O comentário da rota passa a falar de "preferências" (aparência e atalhos).
- [ ] **Step 4: Rodar e ver passar** `test/prefs.test.ts` e `PATH=$N24:$PATH npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(atalhos): preferências guardam os atalhos do usuário`

### Task 2: Combinação — ler, formatar, casar e gravar

**Files:**
- Create: `web/src/shortcuts/combo.ts`
- Test: `web/src/test/combo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string; isComposing?: boolean }
  export interface Combo { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string } // key: 'A'..'Z' | '0'..'9' | 'Enter' | 'Space' | 'F1'..'F12'
  export const COMBO_RE: RegExp                                   // a gramática das Global Constraints
  export function isMac(): boolean
  export function parseCombo(s: string): Combo | null
  export function stringifyCombo(c: Combo): string                // ordem Mod, Ctrl, Alt, Shift
  export function canonicalCombo(s: string, mac: boolean): string | null   // fora do Mac, Ctrl vira Mod (Mod+Ctrl+X → Mod+X); null fora da gramática
  export function sameCombo(a: string, b: string, mac: boolean): boolean
  export function formatCombo(s: string, opts: { mac: boolean; space?: string }): string
  //   fora do Mac: nomes com '+' (Mod e Ctrl → 'Ctrl'; Space → opts.space ?? 'Space'); no Mac: símbolos na ordem ⌃⌥⇧⌘ e a tecla (Enter → '↩')
  export function matchCombo(e: KeyLike, combo: string, mac: boolean): boolean
  export function comboFromEvent(e: KeyLike, mac: boolean): string | 'modifier' | null
  //   'modifier': só um modificador (Control, Shift, Alt, Meta, AltGraph), continuar esperando
  //   null: tecla fora da gramática, ou Super (metaKey) fora do Mac
  export function isComboRelease(e: Pick<KeyboardEvent, 'key'> & { code?: string }, combo: string, mac: boolean): boolean
  //   keyup da tecla principal ou de um modificador da combinação (Mod → 'Meta' no Mac / 'Control' fora; Ctrl → 'Control'; Alt → 'Alt'; Shift → 'Shift')
  ```

- [ ] **Step 1: Testes que falham** (`ev = (over) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over })`):
  - `parse e stringify vão e voltam; ordem e gramática`: `parseCombo('Mod+Shift+K')` → `{ mod: true, ctrl: false, alt: false, shift: true, key: 'K' }`; `parseCombo('Shift+Mod+K')`, `'Mod+Tab'`, `'Mod+'`, `'Mod+k'`, `'F13'` → `null`.
  - `formatCombo fora do Mac e no Mac`: `('Mod+Enter', {mac:false})` → `'Ctrl+Enter'`; `{mac:true}` → `'⌘↩'`; `('Ctrl+Space', {mac:false, space:'Espaço'})` → `'Ctrl+Espaço'`; `{mac:true, space:'Espaço'}` → `'⌃Espaço'`; `('Mod+Shift+K', {mac:true})` → `'⇧⌘K'`; `('Alt+Z', {mac:true})` → `'⌥Z'`.
  - `canonicalCombo: Ctrl e Mod iguais fora do Mac, diferentes no Mac`: `sameCombo('Ctrl+K','Mod+K',false)` true; `(…, true)` false.
  - `casar fora do Mac`: `Mod+F` casa `{key:'f', ctrlKey:true}` e `{key:'F', ctrlKey:true}`; não casa `{key:'f', metaKey:true}` (Super) nem `{key:'f', ctrlKey:true, shiftKey:true}` (modificador a mais); `Ctrl+Space` casa `{key:' ', code:'Space', ctrlKey:true}`.
  - `casar no Mac`: `Mod+F` casa `{key:'f', metaKey:true}` e não `{key:'f', ctrlKey:true}`; `Ctrl+Space` casa `{code:'Space', key:' ', ctrlKey:true}`.
  - `layouts`: Dvorak — `Mod+U` não casa `{key:'g', code:'KeyU', ctrlKey:true}`; cirílico — `Mod+S` casa `{key:'ы', code:'KeyS', ctrlKey:true}`; tecla morta — `Alt+E` casa `{key:'Dead', code:'KeyE', altKey:true}`; pontuação — `Alt+Z` não casa `{key:';', code:'KeyZ', altKey:true}`; Option no Mac — `Alt+Z` casa `{key:'Ω', code:'KeyZ', altKey:true}` e `Alt+A` casa `{key:'å', code:'KeyA', altKey:true}` com `mac=true`.
  - `dígito pela posição`: `Alt+1` casa `{key:'!', code:'Digit1', altKey:true}`; não casa `{key:'1', code:'Numpad1', altKey:true}`.
  - `isComposing nunca casa`.
  - `gravar fora do Mac`: Ctrl+K → `'Mod+K'`; Ctrl+Shift+Enter → `'Mod+Shift+Enter'`; só Control → `'modifier'`; `{key:',', code:'Comma', ctrlKey:true}` → `null`; Super+K → `null`; F2 → `'F2'`; cirílico `{key:'ы', code:'KeyS', ctrlKey:true}` → `'Mod+S'`.
  - `gravar no Mac`: ⌘K → `'Mod+K'`; Control+K → `'Ctrl+K'`; Option+Z `{key:'Ω', code:'KeyZ', altKey:true}` → `'Alt+Z'`; Option+A `{key:'å', code:'KeyA', altKey:true}` → `'Alt+A'`.
  - `soltura`: `isComboRelease({key:'m', code:'KeyM'}, 'Alt+M', false)` true; `{key:'Alt'}` true; `{key:'Control'}` false; `('Mod+Space', mac=true)` com `{key:'Meta'}` true.
  - `isMac`: `navigator.platform` `'MacIntel'` e `'iPhone'` → true; `'Linux x86_64'` → false (stub com `vi.spyOn(navigator, 'platform', 'get')`).
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/combo.test.ts`
- [ ] **Step 3: Implementar.** Letra: `^\p{Script=Latin}$` decide "letra latina"; `^\p{L}$` decide "letra"; a regra do Option no Mac (`mac && e.altKey` → só `e.code`) vem antes.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(atalhos): combinação com Mod, casamento único e gravação`

### Task 3: Registro e resolução

**Files:**
- Create: `web/src/shortcuts/registry.ts`
- Create: `web/src/shortcuts/resolve.ts`
- Modify: `web/src/i18n/{en,pt-BR,es}.ts`: `shortcuts.labels.*`
- Test: `web/src/test/shortcuts-resolve.test.ts`

**Interfaces:**
- Consumes: Task 2 (`parseCombo`, `canonicalCombo`, `sameCombo`).
- Produces:
  ```ts
  // registry.ts
  export type ShortcutId = 'chat.send' | 'chat.queue' | 'chat.voice' | 'chat.stash' | 'chat.find' | 'view.zen' | 'view.usage' | 'triage.undo'
  export type ShortcutScope = 'field' | 'page' | 'conversation' | 'outsideFields' | 'outsideFieldsAndModals' | 'allButTerminal'
  export type Place = 'chatInput' | 'fields' | 'editors' | 'outside' | 'terminal'
  export interface EditableShortcut { id: ShortcutId; labelKey: string; default: string; scope: ShortcutScope; editable: true; adminOnly?: true }
  export interface FixedShortcut { id: string; labelKey: string; combos: string[]; keysLabel?: string; places: Place[]; platform?: 'mac'; editable: false }
  export const EDITABLE: readonly EditableShortcut[]     // os oito, na ordem das Global Constraints
  export const FIXED: readonly FixedShortcut[]
  export const SCOPE_PLACES: Record<ShortcutScope, Place[]>
  export const RESERVED: { mac: readonly string[]; other: readonly string[] }
  export const BROWSER_WARN: { mac: readonly string[]; other: readonly string[] }
  export function isShortcutId(id: string): id is ShortcutId
  export function editableById(id: ShortcutId): EditableShortcut
  // resolve.ts
  export type Overrides = Record<string, string | null>
  export type Refusal = 'invalid' | 'needsModifier' | 'altGr' | 'reserved' | 'fixed'
  export type Verdict = { ok: true; warn?: 'browser' } | { ok: false; reason: Refusal; fixedId?: string }
  export function checkCombo(id: ShortcutId, combo: string, mac: boolean): Verdict
  //   ordem: gramática → altGr (Mod/Ctrl + Alt fora do Mac) → needsModifier → reserved → fixed (mesmo lugar) → ok (+ warn)
  export interface BindingNotice { reverted?: Refusal | 'taken'; unbound?: ShortcutId }
  //   reverted: por que a escolha guardada não vale; unbound: quem ocupa o padrão (a ação ficou sem atalho)
  export interface ResolvedBindings { resolved: Record<ShortcutId, string | null>; notices: Partial<Record<ShortcutId, BindingNotice>> }
  export function resolveBindings(overrides: Overrides, opts: { mac: boolean; admin: boolean }): ResolvedBindings
  export function findOwner(combo: string, resolved: Record<ShortcutId, string | null>, except: ShortcutId, mac: boolean): ShortcutId | null
  export function pruneOverrides(o: Overrides): Overrides   // só ids do registro; tira o valor igual ao padrão (sameCombo); null fica
  export function sameOverrides(a: Overrides, b: Overrides): boolean
  ```
- Dados fixados pela spec:
  - `SCOPE_PLACES`: `field` [chatInput]; `page` e `conversation` [chatInput, outside]; `outsideFields` e `outsideFieldsAndModals` [outside]; `allButTerminal` [chatInput, fields, editors, outside].
  - `FIXED` (id · combos ou `keysLabel` · lugares):
    `fixed.enter` Enter · `fixed.newline` Shift+Enter · `fixed.history` '↑ ↓' · `fixed.pastePlain` Mod+Shift+V — todos [chatInput];
    `fixed.editorSave` Mod+S [editors]; `fixed.findNav` Enter, Shift+Enter [fields]; `fixed.escape` 'Esc' [todos];
    `fixed.clipboard` Mod+C, Mod+V, Mod+X, Mod+A [todos os cinco lugares];
    `fixed.undoText` Mod+Z, Mod+Y, Mod+Shift+Z [chatInput, fields, editors];
    `fixed.macEdit` Ctrl+A, B, D, E, F, H, K, N, P, U [chatInput, fields, editors], `platform: 'mac'`.
  - `RESERVED.other`: Mod+W, Mod+T, Mod+N, Mod+Shift+W, Mod+Shift+T, Mod+Shift+N, Mod+Shift+Q, Alt+F4, Mod+F4, Mod+1…Mod+9, F1, F5, F11, F12, Mod+F5.
    `RESERVED.mac`: Mod+W, T, N, Q, H, M, Mod+Shift+W, T, N, Mod+Space, Mod+1…Mod+9, F1, F5, F11, F12, Ctrl+F5.
    (Ctrl+Tab e ⌘Tab nem entram: Tab está fora da gramática.)
  - `BROWSER_WARN.other`: Mod+R, L, P, D, G, J, O, Alt+D, Alt+E, Alt+F; `BROWSER_WARN.mac`: Mod+R, L, P, D, G, J, O.
- **Algoritmo de `resolveBindings`** (a spec fixa a ordem):
  1. `taken: Map<canônica, ShortcutId>` vazio; `pending: ShortcutId[]`.
  2. Para cada editável, na ordem: `adminOnly && !admin` → `null`, sem aviso, não ocupa nada. Sem chave em `overrides` → `pending`. `null` → `null`, sem aviso. `checkCombo` recusa → `notices[id].reverted = reason`, `pending`. Já em `taken` → `reverted = 'taken'`, `pending`. Senão vale e entra em `taken`.
  3. Para cada `pending`, na ordem: o padrão recusado por `checkCombo` ou já em `taken` → `null` e `notices[id].unbound = dono` (com recusa, `reverted` fica). Senão vale e entra em `taken`.
  Ids fora do registro são ignorados. Nada é gravado.
- Rótulos (`shortcuts.labels`, pt-BR): send 'Enviar', queue 'Pôr na fila', voice 'Microfone', stash 'Guardar rascunho', find 'Buscar na conversa', zen 'Modo Zen', usage 'Página de uso', undo 'Desfazer da triagem'; enter 'Enviar com Enter no campo', newline 'Quebrar linha no campo', history 'Histórico de mensagens no campo', pastePlain 'Colar como texto', editorSave 'Salvar nos editores de arquivo', findNav 'Próxima e anterior na barra de busca', escape 'Parar o turno, fechar menu, barra ou visualizador', clipboard 'Copiar, colar, recortar e selecionar tudo', undoText 'Desfazer e refazer o texto', macEdit 'Edição de texto do macOS nos campos'. En e es equivalentes.

- [ ] **Step 1: Testes que falham** (`shortcuts-resolve.test.ts`):
  - `os padrões passam no checkCombo nos dois sistemas`: para cada `EDITABLE`, `checkCombo(id, default, mac).ok` em `mac` true e false.
  - `fixo no mesmo lugar é recusado`: `('chat.send','Mod+C')` → `{ ok:false, reason:'fixed', fixedId:'fixed.clipboard' }`; `('chat.send','Mod+Z')` → `fixed.undoText`; `('chat.stash','Mod+Shift+V')` → `fixed.pastePlain`; `('view.zen','Mod+S')` → `fixed.editorSave`.
  - `fixo em outro lugar convive`: `('triage.undo','Mod+Z')`, `('chat.stash','Mod+S')`, `('view.usage','Mod+Y')` → ok.
  - `edição do macOS só no Mac`: `('chat.find','Ctrl+F', mac=true)` → `fixed.macEdit`; `('chat.find','Ctrl+F', mac=false)` ok.
  - `reservadas`: `Mod+W` recusada nos dois; `Mod+H` recusada só no Mac; `Mod+1`, `Alt+F4` (fora do Mac), `F5`, `F12`, `Mod+Space` (Mac) → `reserved`.
  - `modificador obrigatório`: `M` e `Shift+M` → `needsModifier`; `F2` e `Shift+F2` → ok.
  - `AltGr`: `Mod+Alt+M` fora do Mac → `altGr`; no Mac → ok.
  - `aviso do navegador`: `Mod+R` → `{ ok:true, warn:'browser' }`; `Alt+D` warn fora do Mac e sem warn no Mac.
  - `gramática`: `Mod+Tab`, `Mod+,` → `invalid`.
  - `resolveBindings sem escolhas: os oito padrões, sem avisos`.
  - `id desconhecido é ignorado`: `{ 'chat.nada': 'Alt+Q' }` → igual ao vazio.
  - `escolha reservada volta ao padrão`: `{ 'view.zen': 'Mod+W' }` → zen `'Alt+Z'`, `notices['view.zen']` `{ reverted:'reserved' }`.
  - `escolha que virou fixa volta ao padrão`: `{ 'chat.send': 'Mod+C' }` → `{ reverted:'fixed' }`.
  - `null deixa sem atalho, sem aviso`.
  - `padrão ocupado por escolha do usuário`: `{ 'view.zen': 'Mod+Enter' }` → zen `'Mod+Enter'`, send `null`, `notices['chat.send']` `{ unbound:'view.zen' }`.
  - `voltou ao padrão e o padrão estava ocupado`: `{ 'view.zen': 'Mod+W', 'chat.send': 'Alt+Z' }` → zen `null`, `{ reverted:'reserved', unbound:'chat.send' }`.
  - `⌘H só no Mac`: `{ 'view.zen': 'Mod+H' }` → no Mac `'Alt+Z'` com `reverted:'reserved'`; fora do Mac `'Mod+H'`.
  - `Ctrl e Mod iguais fora do Mac`: `{ 'chat.find': 'Ctrl+K', 'view.zen': 'Mod+K' }` → zen volta com `reverted:'taken'`.
  - `não administrador: uso sem atalho, sem aviso, e Mod+U livre` (Review Focus 5): `{ 'view.zen': 'Mod+U' }` com `admin:false` → zen `'Mod+U'`, usage `null`, `notices` vazio; com `admin:true` → usage `null` e `{ unbound:'view.zen' }`.
  - `findOwner`: com os padrões, `findOwner('Ctrl+Enter', resolved, 'view.zen', false)` → `'chat.send'`; com `except: 'chat.send'` → `null`.
  - `pruneOverrides`: `{ 'chat.nada':'Alt+Q', 'view.zen':'Alt+Z', 'chat.send':'Ctrl+Enter', 'triage.undo':null, 'chat.find':'Alt+F' }` → `{ 'triage.undo':null, 'chat.find':'Alt+F' }` (fora do Mac `Ctrl+Enter` é o padrão).
  - `sameOverrides ignora a ordem das chaves`.
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-resolve.test.ts`
- [ ] **Step 3: Implementar.** Toda comparação por `canonicalCombo(…, mac)`; `FIXED` com `platform: 'mac'` só conta no Mac; "mesmo lugar" = interseção de `SCOPE_PLACES[scope]` com `places` não vazia.
- [ ] **Step 4: Rodar e ver passar** o teste e `cd web && npx tsc -b`.
- [ ] **Step 5: Commit** `feat(atalhos): registro, recusas e resolução dos atalhos`

### Task 4: Store, cache, sincronia e escopos

**Files:**
- Create: `web/src/shortcuts/cache.ts`
- Create: `web/src/shortcuts/active.ts`
- Create: `web/src/prefsSync.ts`
- Create: `web/src/test/mac.ts` (ajudante dos testes)
- Modify: `web/src/store.ts`: estado `keybindings`, `setKeybindings`; `setAuth` resolve de novo com o admin novo.
- Modify: `web/src/keyboard.ts`: `inScope` (as regras de hoje viram funções nomeadas; `shouldOpenFind` continua e passa a usar `inScope('conversation', …)`).
- Modify: `web/src/api.ts:470-473`: `fetchPrefs` e `savePrefs` no lugar de `fetchAppearance` e `saveAppearance`.
- Modify: `web/src/App.tsx:147`: `void syncPrefs()`.
- Modify: `web/src/components/AppearancePanel.tsx:87`: só a troca de `saveAppearance(draft)` por `savePrefs({ appearance: draft })` (a aba vem na Task 8).
- Modify: `web/src/i18n/*`: `shortcuts.keySpace` ('Espaço' / 'Space' / 'Espacio').
- Test: `web/src/test/shortcuts-store.test.ts`, `web/src/test/keyboard.test.ts`

**Interfaces:**
- Consumes: Tasks 2 e 3.
- Produces:
  ```ts
  // cache.ts
  export const KEYBINDINGS_CACHE_KEY = 'claudinei:keybindings'
  export function cacheKeybindings(o: Overrides): void
  export function readCachedKeybindings(): Overrides          // ausente ou corrompido → {}
  // store.ts
  keybindings: { overrides: Overrides } & ResolvedBindings
  setKeybindings(overrides: Overrides): void                  // resolve com isMac() e o admin atual (!me || me.isAdmin !== false), grava o cache
  //   estado inicial: readCachedKeybindings() resolvido com admin = true (sem `me` vale como administrador, como no App)
  // keyboard.ts
  export function inScope(scope: ShortcutScope, target: EventTarget | null, chatInput: HTMLElement | null): boolean
  //   field: target === chatInput; page: !isForeignField(target, chatInput);
  //   conversation: target === chatInput || (!isForeignField && !inModalOrTerminal);
  //   outsideFields: !isForeignField(target, null); outsideFieldsAndModals: idem e fora de '.modal-overlay, [role="dialog"], [aria-modal="true"]';
  //   allButTerminal: !isTerminalTarget(target)
  // active.ts
  export function matchShortcut(e: KeyLike, id: ShortcutId): boolean      // combinação valendo na store; null → false
  export function inShortcutScope(id: ShortcutId, target: EventTarget | null, chatInput: HTMLElement | null): boolean
  export function shortcutCombo(id: ShortcutId): string | null           // o resolvido, fora do React
  export function useShortcutLabel(id: ShortcutId): string | null        // formatCombo(…, { mac: isMac(), space: t('shortcuts.keySpace') }); null sem atalho
  // api.ts
  export interface PrefsResponse { appearance: Appearance; keybindings: Overrides }
  export const fetchPrefs: () => Promise<PrefsResponse>
  export const savePrefs: (patch: { appearance?: Appearance; keybindings?: Overrides }) => Promise<PrefsResponse>
  // prefsSync.ts
  export async function syncPrefs(): Promise<void>
  //   aplica a aparência; setKeybindings(r.keybindings) só se vier objeto; erro de rede é engolido (fica o cache)
  // test/mac.ts
  export function simulateMac(): () => void   // stub de navigator.platform = 'MacIntel' + setKeybindings(atual); devolve quem desfaz (e resolve de novo)
  ```

- [ ] **Step 1: Testes que falham.**
  - `shortcuts-store.test.ts`:
    - `começa com os padrões`: `resolved['view.zen']` `'Alt+Z'`.
    - `setKeybindings resolve, grava o cache e matchShortcut usa a combinação nova`: `{ 'view.zen': 'Alt+M' }`; `matchShortcut({ key:'m', code:'KeyM', altKey:true, … }, 'view.zen')` true, Alt+Z false; `localStorage['claudinei:keybindings']` tem a escolha.
    - `cache corrompido vale {}`: `readCachedKeybindings()` com `'{'` → `{}`.
    - `sem atalho, matchShortcut é sempre false`.
    - `setAuth com não administrador tira o uso; administrador devolve`.
    - `syncPrefs leva os atalhos do servidor para a store` (fetch stub com `{ appearance, keybindings: { 'view.zen': 'Alt+M' } }`).
    - `servidor sem keybindings ou fora do ar: fica o que havia` (Review Focus 4): resposta só com `appearance`, e depois `fetch` rejeitando; `resolved['view.zen']` continua `'Alt+M'` e nada lança.
    - `simulateMac: Mod+F passa a ser ⌘F e o desfazer volta ao Ctrl`.
  - `keyboard.test.ts`, novo `describe('inScope')` com a montagem já existente: a tabela de alvos (`campo`, `no-chat`, `busca-lateral`, `no-modal`, `editor`, `xterm-entrada`) × os seis escopos, com o esperado de cada regra acima (ex.: `allButTerminal` é true em `editor` e false em `xterm-entrada`; `outsideFieldsAndModals` é false em `no-modal`; `page` é true em `campo`).
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-store.test.ts src/test/keyboard.test.ts`
- [ ] **Step 3: Implementar.** `shouldOpenFind` mantém a assinatura nesta task (o casamento por `matchShortcut` entra na Task 6).
- [ ] **Step 4: Rodar e ver passar** os dois arquivos, `appearance-panel.test.tsx`, `terminal-choice.test.tsx` e `cd web && npx tsc -b`.
- [ ] **Step 5: Commit** `feat(atalhos): atalhos na store, com cache e sincronia com o servidor`

### Task 5: Campo de mensagem e microfone pelo registro

**Files:**
- Modify: `web/src/components/ChatInput.tsx`: some `isStashShortcut` (`:51-63`); `onKeyDown` (`:578-611`); ouvinte global do enviar (`:362-377`).
- Modify: `web/src/speech/shortcut.ts`: some `isMicShortcut`; keydown e keyup pelo registro.
- Test: `web/src/test/shortcuts-chat.test.tsx`; ajustar `mic-shortcut.test.tsx` só se importar `isMicShortcut`.

**Interfaces:**
- Consumes: `matchShortcut`, `inShortcutScope`, `shortcutCombo` (Task 4); `isComboRelease`, `isMac` (Task 2).
- Ordem do `onKeyDown` do campo (a spec fixa): guardar (`matchShortcut(e,'chat.stash')`, sempre `preventDefault`) → colar como texto (igual a hoje) → menu do `/` → histórico → Esc → pôr na fila (`'chat.queue'` → `submit(true)`) → enviar (`'chat.send'` → `submit()`) → **Enter puro** (sem Ctrl, Meta, Alt e Shift) → `submit()`. Tudo que o campo trata leva `preventDefault`.
- Ouvinte global do enviar: `matchShortcut(e,'chat.send')`, pula `e.target === campo` e `!inShortcutScope('chat.send', e.target, campo)`.
- Microfone: keydown `matchShortcut(e,'chat.voice') && inShortcutScope('chat.voice', e.target, field)`; keyup solta quando `shortcutCombo('chat.voice')` existe e `isComboRelease(e, combo, isMac())`.

- [ ] **Step 1: Testes que falham** (`shortcuts-chat.test.tsx`, montagem do `chat-ctrl-enter.test.tsx`/`chatinput-queue.test.tsx`; `afterEach(() => useStore.getState().setKeybindings({}))`):
  - `enviar em Alt+S envia de fora do campo e no campo; Ctrl+Enter não envia mais de fora`.
  - `com a fila em Alt+Q, Alt+Enter no Claude trabalhando não envia nem enfileira; Alt+Q enfileira`.
  - `Enter puro continua enviando; com enviar sem atalho, Ctrl+Enter no campo não envia`.
  - `guardar em Alt+G guarda; Ctrl+S não guarda`.
  - `microfone em Alt+M: Alt+M liga; segurar e soltar o M para; soltar o Control não para` (harness do `mic-shortcut.test.tsx`, `now` falso, `HOLD_MS`).
  - `microfone sem atalho: Ctrl+Espaço não faz nada`.
  - `no Mac, ⌘Enter envia de fora do campo e Control+Enter não` (`simulateMac`).
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-chat.test.tsx`
- [ ] **Step 3: Implementar.** Comentários do arquivo passam a falar "a combinação de enviar" em vez de "Ctrl+Enter".
- [ ] **Step 4: Rodar e ver passar** `shortcuts-chat`, `chat-ctrl-enter`, `chatinput-queue`, `chatinput-stash`, `chatinput-paste`, `chatinput-slash`, `mic-shortcut`, `mic-chatinput`, e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(atalhos): campo e microfone casam pelo registro`

### Task 6: Zen, uso, busca e desfazer pelo registro

**Files:**
- Modify: `web/src/useZenShortcut.ts` (some `isZenShortcut`), `web/src/useUsageShortcut.ts` (some `isUsageShortcut`), `web/src/keyboard.ts` (`shouldOpenFind`), `web/src/components/UndoToast.tsx` (some `inModal` local, que vira o escopo).
- Modify: `web/src/test/keyboard.test.ts:43` e `web/src/test/triage-actions.test.tsx:257`: o caso com `metaKey` passa a rodar com `simulateMac()`.
- Modify: `web/src/test/usage-page.test.tsx` e `web/src/test/zen.test.tsx` só onde importam `isUsageShortcut`/`isZenShortcut`: trocar por `matchShortcut(e, 'view.usage' | 'view.zen')`, mesmas asserções.
- Test: `web/src/test/shortcuts-global.test.tsx`

**Interfaces:**
- Consumes: Task 4.
- Regras: Zen `matchShortcut(e,'view.zen') && inShortcutScope('view.zen', e.target, null) && !e.defaultPrevented` (repetição ignorada como hoje). Uso: `'view.usage'`, escopo `outsideFields`. Busca: `shouldOpenFind(e, chatInput, barOpen)` = `!barOpen && matchShortcut(e,'chat.find') && inScope('conversation', e.target, chatInput)`, aceitando `KeyLike`. Desfazer: `'triage.undo'`, escopo `outsideFieldsAndModals`, `!e.defaultPrevented` (já era).

- [ ] **Step 1: Testes que falham** (`shortcuts-global.test.tsx`):
  - `Zen em Alt+M liga e Alt+Z não liga`.
  - `Zen ignora tecla que alguém já tratou`: um ouvinte em `document` (fase de captura) faz `preventDefault`; Alt+Z não liga.
  - `uso em Mod+Shift+U abre a página; Ctrl+U não`.
  - `busca em Alt+F abre a barra; Ctrl+F fica com o navegador (não previne)`.
  - `desfazer em Alt+U desfaz a triagem; Ctrl+Z não` (montagem do `triage-actions.test.tsx`).
  - `fora do Mac, Super+F não abre a busca e Super+Z não desfaz`.
  - `no Mac, ⌘F abre a busca e Control+F não`.
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-global.test.tsx`
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** `shortcuts-global`, `keyboard`, `chat-find`, `zen`, `usage-page`, `triage-actions`, e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(atalhos): Zen, uso, busca e desfazer casam pelo registro`

### Task 7: Dicas mostram a combinação valendo

**Files:**
- Modify: `web/src/i18n/{en,pt-BR,es}.ts`: `chat.sendHint` (`:206`), `mic.shortcut` (`:385`), `stash.button`/`button_other` (`:513-514`), `zen.hint` (`:538`).
- Modify: `web/src/components/ChatInput.tsx:638,671`, `web/src/components/MicButton.tsx:179`, `web/src/App.tsx:71`.
- Test: `web/src/test/shortcuts-hints.test.tsx`

**Interfaces:**
- Consumes: `useShortcutLabel` (Task 4).
- Chaves (pt-BR; en e es mantêm o texto de hoje com `{{combo}}` no lugar da tecla):
  - `chat.sendHint` sai; entram `sendHintEnter: 'Enter no campo'`, `sendHintAnywhere: '{{combo}} de qualquer ponto da tela'`, `sendHintQueue: '{{combo}} põe na fila'`. O título junta as partes que têm atalho com `' · '`.
  - `mic.shortcut: '{{combo}}: toque liga e desliga, segure para falar'`; sem atalho, o título é só o rótulo (sem `' — '`).
  - `stash.button`/`_other` com `{{combo}}` no lugar de "Ctrl+S"; novas `stash.buttonNoKey: '{{count}} prompt guardado.'` e `_other: '{{count}} prompts guardados.'`.
  - `zen.hint: 'Modo Zen: só a conversa e o campo. {{combo}} liga e desliga.'`; nova `zen.hintNoKey: 'Modo Zen: só a conversa e o campo.'`.

- [ ] **Step 1: Testes que falham** (`shortcuts-hints.test.tsx`):
  - `com os padrões, o texto é o de hoje`: título do Enviar `'Enter no campo · Ctrl+Enter de qualquer ponto da tela · Alt+Enter põe na fila'`; botão do Zen `'Modo Zen: só a conversa e o campo. Alt+Z liga e desliga.'`; microfone contém `'Ctrl+Espaço: toque liga e desliga, segure para falar'`; guardados contém `'Ctrl+S guarda o que está no campo'`.
  - `trocar o Zen para Alt+M muda a dica para "Alt+M liga e desliga"`.
  - `sem atalho de fila, a dica do Enviar não cita fila`: `'Enter no campo · Ctrl+Enter de qualquer ponto da tela'`.
  - `sem atalho de Zen, a dica não cita tecla`: igual a `zen.hintNoKey`.
  - `no Mac, a dica do Zen mostra ⌥Z e a do Enviar ⌘↩` (`simulateMac`).
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-hints.test.tsx`
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** `shortcuts-hints`, `i18n`, `zen`, `mic-button`, `chatinput-stash`, e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(atalhos): dicas mostram a combinação que está valendo`

### Task 8: Aba Atalhos no painel

**Files:**
- Create: `web/src/components/ShortcutsTab.tsx`
- Modify: `web/src/components/AppearancePanel.tsx`: abas, rascunho dos atalhos, Salvar só com o que mudou.
- Modify: `web/src/styles.css` (classes `sc-*`, estáticas, cores do tema; aviso amarelo com `--warn` ou a variável de aviso já usada), `web/src/i18n/*` (`shortcuts.*` abaixo).
- Test: `web/src/test/shortcuts-tab.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 3, 4 (`savePrefs`, `setKeybindings`, `resolveBindings`, `checkCombo`, `findOwner`, `pruneOverrides`, `sameOverrides`, `comboFromEvent`, `formatCombo`).
- Produces:
  ```ts
  export function ShortcutsTab(props: { draft: Overrides; onChange(next: Overrides): void; admin: boolean; mac: boolean }): JSX.Element
  // data-testid: sc-row-<id>, sc-combo-<id> (botão que grava), sc-reset-<id>, sc-clear-<id>, sc-msg-<id>,
  //              sc-swap, sc-cancel, sc-reset-all, sc-fixed-<id>; abas: ap-tab-appearance, ap-tab-shortcuts
  ```
- Comportamento:
  - Linhas: os editáveis (uso só com `admin`), com a combinação de `resolveBindings(draft, { mac, admin }).resolved` (ou "sem atalho") e o aviso de `notices`; depois os fixos com o selo "fixo" (`fixed.macEdit` só no Mac). "Voltar ao padrão" da linha só quando `id in draft`; "Sem atalho" põe `null`.
  - **Gravar:** clicar em `sc-combo-<id>` mostra "Aperte a nova combinação…". Ouvinte `keydown` na `window` em **captura**, com `preventDefault` e `stopImmediatePropagation` para toda tecla. Esc cancela; `'modifier'` continua esperando; `null` avisa "Tecla não aceita" e continua esperando. Combinação: `checkCombo` recusa → aviso na linha, nada muda; aceita → `findOwner` no resolvido do rascunho; com dono → "Já é o atalho de {{label}}" com Trocar (`{ ...draft, [id]: combo, [dono]: null }`) e Cancelar; sem dono → grava. Gravar sempre passa por `pruneOverrides` (o padrão não vira diferença). `warn: 'browser'` deixa um aviso amarelo na linha.
  - **Painel:** abas "Aparência" e "Atalhos". "Restaurar" do rodapé só na aparência; "Voltar todos ao padrão" (`{}`) só nos atalhos. Rascunho começa em `keybindings.overrides`; Cancelar descarta. Salvar: `appearanceChanged` (JSON da aparência ≠ o de abertura) e `kbNext = pruneOverrides(draft)`, `kbChanged = !sameOverrides(kbNext, overrides de abertura)`; nenhum → fecha sem PUT; senão `savePrefs` só com as partes mudadas, aplica o que voltou (`applyAppearance`, `setKeybindings`) e fecha. Falha: erro no painel e os atalhos não mudam (a prévia da aparência fica, como hoje).
- Textos (pt-BR; en e es equivalentes): `shortcuts.tabAppearance` 'Aparência', `tabShortcuts` 'Atalhos', `recording` 'Aperte a nova combinação… (Esc cancela)', `none` 'sem atalho', `fixed` 'fixo', `resetOne` 'Voltar ao padrão', `clear` 'Sem atalho', `resetAll` 'Voltar todos ao padrão', `unsupported` 'Tecla não aceita: use letras, números, Enter, Espaço ou F1–F12', `conflict` 'Já é o atalho de {{label}}', `swap` 'Trocar', `browserWarn` 'O navegador também usa esta combinação; aqui vale a do Claudinei', `refused` 'Não dá para usar {{combo}}: {{why}}', `noticeReverted` 'Voltou ao padrão porque {{why}}', `noticeUnbound` 'Sem atalho: o padrão já é de {{label}}', `noticeBoth` 'A escolha não vale porque {{why}}, e o padrão já é de {{label}}', e `shortcuts.why.{invalid,needsModifier,altGr,reserved,fixed,taken}`: 'a combinação não é aceita', 'precisa de Ctrl, ⌘ ou Alt', 'Ctrl+Alt é o AltGr de alguns teclados', 'o sistema ou o navegador não deixa a página receber', 'é o atalho fixo de {{label}}', 'já é o atalho de {{label}}'.

- [ ] **Step 1: Testes que falham** (`shortcuts-tab.test.tsx`; `stubFetch` como o de `appearance-panel.test.tsx`, com o PUT devolvendo o corpo e `keybindings`):
  - `abas: Restaurar só na aparência e Voltar todos só nos atalhos`.
  - `lista os editáveis e os fixos com o selo; uso só para administrador`.
  - `gravar Alt+M: mostra "Aperte a nova combinação…" e a linha passa a Alt+M`.
  - `Esc cancela sem mudar nada; modificador sozinho continua esperando`.
  - `durante a gravação nenhum atalho dispara` (Review Focus 1): com `ChatInput` e `ZenControls` montados e o foco no campo de mensagem antes de clicar, gravar Alt+Z não liga o Zen; gravar Alt+Enter não chama `addToQueue`; gravar Ctrl+Espaço não chama `start` do microfone; gravar Mod+S não guarda.
  - `tecla não aceita avisa e continua gravando` (Review Focus 2): vírgula e Tab → `sc-msg-<id>` com "Tecla não aceita", ainda em gravação; Tab chega com `defaultPrevented`.
  - `conflito com editável: Trocar deixa o outro sem atalho; Cancelar não muda` (Alt+Z no enviar → "Já é o atalho de Modo Zen").
  - `fixos recusados`: Mod+C no enviar ("é o atalho fixo de Copiar, colar…"); Mod+S no Zen ("é o atalho fixo de Salvar nos editores…").
  - `Mod+S no desfazer não é recusa de fixo, e sim conflito com Guardar rascunho` (o salvar dos editores ouve em outro lugar).
  - `reservadas e sem modificador recusadas; F2 aceita`: Ctrl+W, F5, M recusadas; F2 grava.
  - `Ctrl+Alt+M recusado fora do Mac`.
  - `Ctrl+R grava com aviso amarelo`.
  - `voltar ao padrão: o botão da linha só aparece quando difere; Voltar todos limpa tudo`.
  - `gravar o próprio padrão não cria diferença e Salvar fecha sem PUT` (Review Focus 3).
  - `Salvar só com atalhos manda PUT sem appearance; depois Alt+M liga o Zen`.
  - `sem prévia ao vivo: antes de Salvar, Alt+Z ainda liga o Zen; Cancelar descarta`.
  - `falha de rede: erro no painel e os atalhos não mudam`.
  - `não administrador: Mod+U no Zen grava sem conflito` (Review Focus 5).
  - `escolha salva que virou reservada mostra "Voltou ao padrão porque…"` (store com `{ 'view.zen': 'Mod+W' }`).
  - `a dica do Zen muda depois de Salvar` (botão `zen-exit` com o título novo).
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/shortcuts-tab.test.tsx`
- [ ] **Step 3: Implementar.** O ouvinte de gravação nasce e morre com o estado "gravando" (um `useEffect` com limpeza).
- [ ] **Step 4: Rodar e ver passar** `shortcuts-tab`, `appearance-panel`, `terminal-choice`, `default-folder-settings`, a suíte web inteira (`cd web && npx vitest run`) e `npx tsc -b`; a do servidor (`cd server && PATH=$N24:$PATH npx vitest run`; a falha intermitente conhecida do orchestrator se confere rodando o arquivo isolado).
- [ ] **Step 5: Commit** `feat(atalhos): aba Atalhos com gravação, conflitos e voltar ao padrão`

### Task 9: Ensaio numa instância isolada (porta 9197)

**Files:** nenhum de produção. Scripts do ensaio em `/tmp/claudinei-e2e-atalhos-scripts/`.

- [ ] **Step 1: Subir.** No worktree: `npm run build -w web` (sem `npm install`). Depois, em `server/`:
  `env -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS PATH=$N24:$PATH CLAUDINEI_PORT=9197 CLAUDINEI_DB=/tmp/claudinei-e2e-atalhos/claudinei.db CLAUDINEI_UPLOADS=/tmp/claudinei-e2e-atalhos/uploads CLAUDINEI_SCHEDULES=/tmp/claudinei-e2e-atalhos/schedules CLAUDINEI_SPEECH=/tmp/claudinei-e2e-atalhos/speech CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs npx tsx src/index.ts`, em segundo plano. Banco novo: criar a conta master, um usuário comum e um terminal Claude.
- [ ] **Step 2: Aba e gravação** (Playwright, como administrador):
  1. Painel → Atalhos. Gravar Alt+M no Zen; Alt+Z gravado no enviar acusa "Já é o atalho de Modo Zen"; Trocar.
  2. Salvar. Alt+M liga o Zen; o título do botão de sair diz "Alt+M".
  3. Recarregar: segue valendo. `GET /api/prefs` mostra só as diferenças.
  4. Fila em Alt+Q: com o turno longo, Alt+Q enfileira e Alt+Enter não manda nada.
  5. Voltar todos ao padrão; Salvar; Alt+Z liga o Zen de novo.
  6. Capturas de tela da aba (aparência e atalhos).
- [ ] **Step 3: Outra conta.** Logar com o usuário comum: não vê a linha do uso, e vê os próprios padrões, não os do administrador.
- [ ] **Step 4: Limpar.** Parar a instância pelo PID da porta 9197, conferindo que não é o PID da 9105; apagar `/tmp/claudinei-e2e-atalhos*` e as pastas `~/.claude/projects/-tmp-claudinei-e2e-atalhos*`. Registrar o resultado no relatório da trilha.

---

## Decisões do plano (onde a spec deixou escolha)

- **Escopo próprio do desfazer** (`outsideFieldsAndModals`): a spec diz "fora de campos e modais"; vira escopo para a regra de foco sair do componente.
- **Não administrador:** `resolveBindings` recebe `admin`; a ação só de admin não ocupa a combinação de quem não a vê.
- **Salvar sem mudança fecha sem PUT**; aparência inalterada não vai no PUT.
- **Tecla fora da gramática durante a gravação** avisa e continua gravando.
- **Dica do Enviar** vira três pedaços juntados com " · ", para omitir o que não tem atalho.
- **`PUT` com `keybindings` que não é objeto** grava `{}`, como o saneamento da aparência cai no padrão.
