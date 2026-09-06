# Perguntas do agente no chat (AskUserQuestion) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O Claude faz perguntas estruturadas no chat (a mesma `AskUserQuestion` do terminal), o operador responde escolhendo opções ou digitando livremente, e o turno continua.

**Architecture:** A CLI só oferece a tool com `--permission-prompt-tool stdio`; com ele, cada pergunta chega como `control_request/can_use_tool` no stdout e a CLI bloqueia o turno até um `control_response` no stdin. A `ClaudeSession` guarda a pergunta como **pendência em memória** (como `backgroundTasks`/`authExpired`), publicada aos clientes pelo `session_status`/`sessions_snapshot`; a UI renderiza um `QuestionPanel` acima da caixa de mensagem e responde por mensagens WS (`answer_question`/`dismiss_question`), que o manager encaminha à sessão, que escreve o `control_response`.

**Tech Stack:** Node 22 / TypeScript ESM estrito (server: Fastify + `ws`; web: React + zustand + react-i18next + Vite), vitest (+ @testing-library/react no web), `server/test/fake-claude.mjs` como CLI falsa que fala stream-json.

**Spec:** `docs/superpowers/specs/2026-09-06-perguntas-no-chat-design.md` — os sete "fatos empíricos" numerados lá são a referência do protocolo; o plano argumenta a partir deles.

## Global Constraints

- Repositório: `/home/ubuntu/project/claudinei/claudinei` (o cwd do shell volta sozinho para o pai, que NÃO é repo — use sempre caminhos absolutos ou `cd` no início de cada comando).
- **NUNCA reinicie `claudinei.service` nem toque em `/usr/local/bin/claudinei`**: há sessões de agente rodando em produção. Este plano termina em código commitado e suíte verde; empacotar/instalar/reiniciar exige autorização expressa do operador, fora do plano.
- Testes: `env -u NODE_ENV npx vitest run <arquivo>` dentro de `server/` ou `web/` (o `NODE_ENV=production` vazado pelo systemd quebra os testes React). Typecheck: `npx tsc --noEmit -p server/tsconfig.json` e `npx tsc --noEmit -p web/tsconfig.json` na raiz.
- Falhas PRÉ-EXISTENTES conhecidas, que não são regressão: server → 5 em `test/local-apps.test.ts` (DISPLAY headless); web → 2 em `src/test/start-session-modal.test.tsx`. Qualquer outra falha é sua.
- Server é ESM estrito: imports relativos com sufixo `.js` (`'../src/claude/session.js'`), mesmo apontando para `.ts`.
- i18n: toda chave nova entra em `web/src/i18n/pt-BR.ts`, `en.ts` **e** `es.ts` (o `en` é a fonte dos tipos — `i18next.d.ts`). Os testes web rodam em pt-BR (`setup.ts`).
- Gatilhos novos do fake-claude: `faz-pergunta`, `pedido-interativo`, `pedido-comum`. Nunca `pergunta` sozinho nem `/compact` (o auto-compact conta com o eco literal).
- Comentários em português, no tom do código existente: explicam o **porquê** (inclusive o fato empírico que motivou), não o quê.
- Commits pequenos, um por tarefa, mensagem em português com prefixo (`feat(perguntas): …`, `test(...)`), e trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Sem push.

## File Structure

Servidor:
- `server/src/claude/session.ts` (modificar) — flag em `buildClaudeArgs`; tipos `Question`/`PendingQuestion`; pendência, `handleControlRequest`, `respondControl`, `answerQuestion`, `dismissQuestion`, cancel e limpeza.
- `server/src/engine/types.ts` (modificar) — membros opcionais em `EngineSession`.
- `server/src/claude/manager.ts` (modificar) — `SessionInfo.pendingQuestion`, `infoOf`, helper `statusMsg` no `wire()`, `answerQuestion`/`dismissQuestion`.
- `server/src/routes/ws.ts` (modificar) — mensagens `answer_question`/`dismiss_question`.
- `server/test/fake-claude.mjs` (modificar) — gatilhos e protocolo da pergunta.
- `server/test/session-control.test.ts` (modificar) — testes da sessão.
- `server/test/ask-user-question.test.ts` (criar) — testes do manager.
- `server/test/ws.test.ts` (modificar) — testes do WS.

Web:
- `web/src/types.ts` (modificar) — `Question`, `PendingQuestion`, `SessionInfo.pendingQuestion`.
- `web/src/store.ts` (modificar) — merge no `session_status` + notificação.
- `web/src/notifications.ts` (modificar) — `notifyQuestion`.
- `web/src/engineSession.ts` (modificar) — `isWaitingForYou`, `dotClassOf`, `displayStatusKey`.
- `web/src/components/AgentFace.tsx` (modificar) — cara de atenção com pergunta.
- `web/src/components/QuestionPanel.tsx` (criar) — o painel.
- `web/src/components/ChatView.tsx` (modificar) — monta o painel.
- `web/src/components/ChatInput.tsx` (modificar) — placeholder.
- `web/src/components/ToolCallCard.tsx` (modificar) — card da `AskUserQuestion`.
- `web/src/styles.css` (modificar) — `.qpanel*`.
- `web/src/i18n/{pt-BR,en,es}.ts` (modificar) — chaves `question.*`, `chat.placeholderQuestion`, `notify.question`, `status.question`.
- Testes: `web/src/test/question-store.test.ts`, `question-waiting.test.ts`, `question-panel.test.tsx` (criar); `chatview.test.tsx`, `toolcall.test.tsx` (modificar).

---

### Task 1: A pergunta da CLI vira pendência na sessão (+ flag)

**Files:**
- Modify: `server/src/claude/session.ts` (`buildClaudeArgs` ~L61-92; campos da classe ~L96-112; `close` ~L177; ramo `raw` de `handleEvent` ~L196-206)
- Modify: `server/test/fake-claude.mjs`
- Test: `server/test/session-control.test.ts`

**Interfaces:**
- Produces (usados pelas Tasks 2–5):
  ```ts
  export interface QuestionOption { label: string; description: string }
  export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
  export interface PendingQuestion { toolUseId: string; questions: Question[] }
  class ClaudeSession { get pendingQuestion(): PendingQuestion | undefined }
  ```
- Fake: mensagem contendo `faz-pergunta` → `assistant/tool_use(AskUserQuestion)` + `control_request` (`request_id: 'q-req-1'`, `tool_use_id: 'toolu_q_1'`, perguntas "Cor" (simples) e "Frutas" (múltipla)).

- [ ] **Step 1: Escrever os testes que falham**

Em `server/test/session-control.test.ts`, troque a importação do topo e acrescente ao `describe('buildClaudeArgs')` e um `describe` novo no fim do arquivo:

```ts
// topo: acrescente o tipo de evento
import type { ClaudeEvent } from '../src/claude/events.js'
```

```ts
  // dentro de describe('buildClaudeArgs', …)
  it('liga o prompt de permissão via stdio — sem ele a AskUserQuestion nem existe para o modelo', () => {
    const args = buildClaudeArgs({})
    const i = args.indexOf('--permission-prompt-tool')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('stdio')
  })
```

```ts
describe('AskUserQuestion (can_use_tool vindo da CLI)', () => {
  it('a pergunta vira pendência com perguntas + tool_use_id e re-emite status (sem mudar de working)', async () => {
    const s = start()
    const statuses: string[] = []
    s.on('status', (st: string) => statuses.push(st))
    await waitUntil(() => s.status === 'idle')
    const antes = statuses.length
    s.send('faz-pergunta')
    await waitUntil(() => s.pendingQuestion !== undefined)
    expect(s.pendingQuestion).toMatchObject({ toolUseId: 'toolu_q_1' })
    expect(s.pendingQuestion!.questions.map((q) => q.header)).toEqual(['Cor', 'Frutas'])
    expect(s.pendingQuestion!.questions[0].multiSelect).toBe(false)
    expect(s.pendingQuestion!.questions[1].multiSelect).toBe(true)
    expect(s.pendingQuestion!.questions[0].options[0]).toEqual({ label: 'Azul', description: 'Cor azul' })
    // O status não muda (segue working), mas é re-emitido: é assim que o manager
    // rebroadcasta o SessionInfo — o mesmo canal do authExpired.
    expect(s.status).toBe('working')
    // dois 'working' desde o send(): o do próprio send() e o re-emitido pela pendência
    expect(statuses.slice(antes).filter((st) => st === 'working').length).toBeGreaterThanOrEqual(2)
  })

  it('morte do processo limpa a pendência', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    s.send('faz-pergunta')
    await waitUntil(() => s.pendingQuestion !== undefined)
    s.send('crash')
    await waitUntil(() => s.status === 'dead')
    expect(s.pendingQuestion).toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts`
Expected: FAIL — o teste do flag (`-1` em vez de índice) e os dois novos (`pendingQuestion` é `undefined`/timeout).

- [ ] **Step 3: O fake aprende a perguntar**

Em `server/test/fake-claude.mjs`:

No bloco de comentários do cabeçalho, após a linha do `compact-real`, acrescente:
```js
//   contém "faz-pergunta" -> AskUserQuestion: tool_use + control_request can_use_tool
//                         (request_id q-req-1, tool_use_id toolu_q_1) e ESPERA o
//                         control_response do host (Task 2 trata a resposta).
```

Logo após `const out = …` (linha ~21), declare o estado:
```js
// Pergunta (AskUserQuestion) esperando o control_response do host. Replica a CLI
// real: o turno fica bloqueado até a resposta chegar pelo stdin.
let pendingQuestion = null
```

Dentro de `rl.on('line', …)`, logo depois de `if (text.includes('crash')) process.exit(1)`:
```js
  if (text.includes('faz-pergunta')) {
    const questions = [
      { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false,
        options: [{ label: 'Azul', description: 'Cor azul' }, { label: 'Verde', description: 'Cor verde' }] },
      { question: 'Quais frutas você gosta?', header: 'Frutas', multiSelect: true,
        options: [{ label: 'Maçã', description: 'Maçã' }, { label: 'Banana', description: 'Banana' }] },
    ]
    pendingQuestion = { request_id: 'q-req-1', tool_use_id: 'toolu_q_1', questions }
    // Ordem EMPÍRICA (CLI 2.1.261): primeiro o tool_use no assistant, depois o
    // control_request com requires_user_interaction — e nada mais até a resposta.
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q_1', name: 'AskUserQuestion', input: { questions } }] } })
    out({ type: 'control_request', request_id: 'q-req-1', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      input: { questions }, tool_use_id: 'toolu_q_1', requires_user_interaction: true } })
    return
  }
```

- [ ] **Step 4: Implementar na sessão**

Em `server/src/claude/session.ts`:

(a) Tipos exportados, logo após `export type PermissionMode = …`:
```ts
export interface QuestionOption { label: string; description: string }
/** Uma pergunta da AskUserQuestion, como a CLI a manda no can_use_tool. */
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
/**
 * Pergunta que a CLI fez e está esperando resposta. Estado do PROCESSO vivo (a
 * CLI bloqueia o turno até o control_response): nunca vai ao banco — se o
 * servidor reinicia, a CLI morre junto e não há o que restaurar.
 */
export interface PendingQuestion { toolUseId: string; questions: Question[] }
/** Estado interno da pendência: o request_id fica aqui (nunca sai da sessão) e o input volta inteiro no updatedInput. */
interface PendingState { requestId: string; toolUseId: string; input: Record<string, unknown>; questions: Question[] }
```

(b) Em `buildClaudeArgs`, depois de `'--dangerously-skip-permissions',` (~L67):
```ts
    // Sem isto a AskUserQuestion NEM EXISTE para o modelo (medido: fora da lista
    // de tools do init). Com isto, cada pergunta chega como control_request
    // can_use_tool no stdout e a CLI espera o control_response no stdin. Não
    // afeta mais nada: em bypass (e mesmo com set_permission_mode default
    // pós-init) Bash e afins seguem sem pedir permissão — só chega ao host o
    // que tem requires_user_interaction.
    '--permission-prompt-tool', 'stdio',
```

(c) Campo privado, após `private pendingControls = …`:
```ts
  /** Pergunta (AskUserQuestion) esperando o operador — ver PendingQuestion. `input` volta inteiro no updatedInput. */
  private pending?: PendingState

  get pendingQuestion(): PendingQuestion | undefined {
    return this.pending ? { toolUseId: this.pending.toolUseId, questions: this.pending.questions } : undefined
  }
```

(d) No handler `close` (~L177), antes do `for (const [, p] of this.pendingControls)`:
```ts
      this.pending = undefined // a CLI morreu com a pergunta: ninguém mais espera resposta
```

(e) No ramo `if (evt.kind === 'raw') {` de `handleEvent`, depois do bloco `if (raw?.type === 'control_response') { … return }`:
```ts
      // Sentido CLI → host: a CLI pede algo e BLOQUEIA o turno até a resposta.
      if (raw?.type === 'control_request') { this.handleControlRequest(raw); return }
      // A CLI desistiu do pedido (interrupt com pergunta aberta — ela mesma manda
      // o cancel antes de responder o interrupt; medido). Só descartar.
      if (raw?.type === 'control_cancel_request') {
        if (this.pending && raw.request_id === this.pending.requestId) {
          this.pending = undefined
          this.emit('status', this.status)
        }
        return
      }
```

(f) Métodos novos, logo antes de `private sendControl(`:
```ts
  /**
   * Pedido da CLI (can_use_tool). Só um tipo vira interação: a AskUserQuestion,
   * que fica pendente até answerQuestion/dismissQuestion. Qualquer outro pedido
   * que exija humano é negado com explicação — o modelo fica sabendo, em vez de
   * esperar para sempre por uma UI que não existe. Pedidos sem interação são
   * permitidos, espelhando o bypass (nas sondas, nunca chegaram).
   */
  private handleControlRequest(raw: { request_id?: unknown; request?: Record<string, unknown> }): void {
    const req = raw.request ?? {}
    const rid = raw.request_id
    if (req.subtype !== 'can_use_tool' || typeof rid !== 'string') return // outros subtypes seguem ignorados, como antes
    const input = (req.input ?? {}) as Record<string, unknown>
    if (req.tool_name === 'AskUserQuestion') {
      const questions = normalizeQuestions(input.questions)
      if (questions.length === 0) {
        this.respondControl(rid, { behavior: 'deny', message: 'AskUserQuestion sem perguntas válidas.' })
        return
      }
      this.pending = { requestId: rid, toolUseId: String(req.tool_use_id ?? ''), input, questions }
      // Reusa o canal de status: é assim que o manager retransmite o SessionInfo.
      this.emit('status', this.status)
      return
    }
    if (req.requires_user_interaction) {
      this.respondControl(rid, { behavior: 'deny', message: `O Claudinei ainda não exibe este pedido (${String(req.tool_name ?? 'desconhecido')}).` })
      return
    }
    this.respondControl(rid, { behavior: 'allow', updatedInput: input })
  }

  private respondControl(request_id: string, response: object): void {
    this.proc?.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } }) + '\n')
  }
```

(g) Função pura no fim do arquivo (fora da classe):
```ts
/** Só entra o que tem forma de pergunta: sem isso um payload torto viraria um painel vazio na UI. */
function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) continue
    const options = Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[])
          .filter((o) => o && typeof o.label === 'string' && o.label.trim())
          .map((o) => ({ label: String(o.label), description: typeof o.description === 'string' ? o.description : '' }))
      : []
    out.push({ question: q.question, header: typeof q.header === 'string' && q.header ? q.header : q.question.slice(0, 12), options, multiSelect: q.multiSelect === true })
  }
  return out
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts test/session.test.ts`
Expected: PASS. Se algum teste de `session.test.ts` comparar o array **inteiro** de args (`toEqual([...])`), acrescente `'--permission-prompt-tool', 'stdio'` logo após `'--dangerously-skip-permissions'` na expectativa.

- [ ] **Step 6: Commit**

```bash
git add server/src/claude/session.ts server/test/fake-claude.mjs server/test/session-control.test.ts server/test/session.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): a AskUserQuestion da CLI vira pendência na sessão

Liga --permission-prompt-tool stdio (sem ele a tool nem existe para o
modelo) e trata o can_use_tool que a CLI manda no stdout: a pergunta fica
pendente na sessão e o status é re-emitido para o manager rebroadcastar.
Outros pedidos interativos são negados com explicação; os demais, permitidos.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Responder e dispensar a pergunta

**Files:**
- Modify: `server/src/claude/session.ts` (métodos ao lado de `handleControlRequest`)
- Modify: `server/test/fake-claude.mjs`
- Test: `server/test/session-control.test.ts`

**Interfaces:**
- Produces:
  ```ts
  class ClaudeSession {
    answerQuestion(answers: Record<string, string>): void   // lança se não há pendência ou falta resposta
    dismissQuestion(): void                                 // nega: "O usuário vai responder pelo chat."
  }
  ```
- Fake: `control_response` para o `request_id` pendente → `allow` gera `tool_result` "Your questions have been answered: …" + assistant `eco: respostas …` + `result`; `deny` gera `tool_result is_error` + assistant `eco: negado <message>` + `result`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao `describe('AskUserQuestion (can_use_tool vindo da CLI)')`:

```ts
  const askAndWait = async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    s.send('faz-pergunta')
    await waitUntil(() => s.pendingQuestion !== undefined)
    return s
  }
  const results = (s: ClaudeSession) => {
    const r: string[] = []
    s.on('event', (e: ClaudeEvent) => { if (e.kind === 'result') r.push(e.resultText) })
    return r
  }

  it('answerQuestion responde à CLI no formato dela: o turno continua com as respostas e a pendência some', async () => {
    const s = await askAndWait()
    const rs = results(s)
    s.answerQuestion({ 'Qual cor você prefere?': 'Azul', 'Quais frutas você gosta?': 'Maçã, Banana' })
    expect(s.pendingQuestion).toBeUndefined()
    await waitUntil(() => rs.length === 1)
    expect(rs[0]).toContain('"Qual cor você prefere?"="Azul"')
    expect(rs[0]).toContain('"Quais frutas você gosta?"="Maçã, Banana"')
    expect(s.status).toBe('needs_attention')
  })

  it('answerQuestion exige resposta não vazia para TODAS as perguntas (a pendência fica)', async () => {
    const s = await askAndWait()
    expect(() => s.answerQuestion({ 'Qual cor você prefere?': 'Azul' })).toThrow(/Frutas/)
    expect(() => s.answerQuestion({ 'Qual cor você prefere?': 'Azul', 'Quais frutas você gosta?': '   ' })).toThrow(/Frutas/)
    expect(() => s.answerQuestion(null as never)).toThrow(/respostas/)
    expect(s.pendingQuestion).toBeDefined()
  })

  it('answerQuestion / dismissQuestion sem pendência lançam', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    expect(() => s.answerQuestion({ x: 'y' })).toThrow(/pendente/)
    expect(() => s.dismissQuestion()).toThrow(/pendente/)
  })

  it('dismissQuestion nega: a CLI recebe o tool_result de erro e o turno fecha normal', async () => {
    const s = await askAndWait()
    const rs = results(s)
    s.dismissQuestion()
    expect(s.pendingQuestion).toBeUndefined()
    await waitUntil(() => rs.length === 1)
    expect(rs[0]).toMatch(/negado/)
    expect(rs[0]).toMatch(/responder pelo chat/i)
    expect(s.status).toBe('needs_attention')
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts`
Expected: FAIL — `answerQuestion is not a function`.

- [ ] **Step 3: O fake responde ao control_response**

Em `server/test/fake-claude.mjs`, dentro de `rl.on('line', …)`, ANTES de `if (msg?.type === 'control_request') {`:

```js
  // Host respondeu à pergunta (ou a outro can_use_tool) — o turno bloqueado segue.
  if (msg?.type === 'control_response' && pendingQuestion && msg.response?.request_id === pendingQuestion.request_id) {
    const r = msg.response?.response ?? {}
    const p = pendingQuestion; pendingQuestion = null
    const usage = { input_tokens: 10, cache_read_input_tokens: Number(process.env.CLAUDE_FAKE_CTX ?? 100), cache_creation_input_tokens: 0, output_tokens: 5 }
    if (r.behavior === 'allow') {
      // Texto EXATO que a CLI real injeta (medido) quando há perguntas; sem
      // perguntas (pedido-comum) é só um tool_result qualquer.
      const answers = r.updatedInput?.answers ?? {}
      const pares = Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ')
      const content = p.questions
        ? `Your questions have been answered: ${pares}. You can now continue with these answers in mind.`
        : 'oi'
      const eco = p.questions ? `eco: respostas ${pares}` : 'eco: permitido'
      out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, content }] } })
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: eco }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: eco, session_id: sid, num_turns: 1, total_cost_usd: 0, usage })
    } else {
      const eco = `eco: negado ${r.message ?? ''}`.trim()
      out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, content: r.message ?? 'rejected', is_error: true }] } })
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: eco }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: eco, session_id: sid, num_turns: 1, total_cost_usd: 0, usage })
    }
    return
  }
```

E no cabeçalho de comentários, complemente a linha do `faz-pergunta`:
```js
//                         control_response allow → tool_result "Your questions have been
//                         answered: …" + "eco: respostas …" + result; deny → tool_result
//                         is_error + "eco: negado <message>" + result.
```

- [ ] **Step 4: Implementar na sessão**

Em `server/src/claude/session.ts`, logo após `handleControlRequest` (antes de `respondControl`):

```ts
  /**
   * Resposta do operador à pergunta pendente, no formato que a CLI espera:
   * `answers` chaveado pelo TEXTO da pergunta; múltipla escolha vem como rótulos
   * separados por ", "; resposta livre é qualquer string. O `input` original
   * volta inteiro no updatedInput (é assim que a CLI casa pergunta e resposta).
   */
  answerQuestion(answers: Record<string, string>): void {
    const p = this.requirePending()
    if (!answers || typeof answers !== 'object') throw new Error('respostas ausentes')
    for (const q of p.questions) {
      const a = answers[q.question]
      if (typeof a !== 'string' || !a.trim()) throw new Error(`pergunta sem resposta: ${q.header}`)
    }
    this.respondControl(p.requestId, { behavior: 'allow', updatedInput: { ...p.input, answers } })
    this.pending = undefined
    this.emit('status', this.status)
  }

  /**
   * O operador prefere responder em prosa: nega a tool com uma mensagem que o
   * modelo lê (medido: vira tool_result is_error e o turno fecha normal), e a
   * caixa de mensagem faz o resto.
   */
  dismissQuestion(): void {
    const p = this.requirePending()
    this.respondControl(p.requestId, { behavior: 'deny', message: 'O usuário vai responder pelo chat.' })
    this.pending = undefined
    this.emit('status', this.status)
  }

  private requirePending(): PendingState {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita resposta no status ${this.status}`)
    if (!this.pending) throw new Error('nenhuma pergunta pendente')
    return this.pending
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts`
Expected: PASS (todos, inclusive os da Task 1).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add server/src/claude/session.ts server/test/fake-claude.mjs server/test/session-control.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): answerQuestion/dismissQuestion respondem à CLI pelo stdin

O allow devolve o input inteiro com `answers` chaveado pelo texto da
pergunta (formato medido na CLI); o deny leva uma mensagem que o modelo
lê. O fake replica os dois caminhos com o tool_result exato.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Interrupt com pergunta aberta e a política para outros pedidos

**Files:**
- Modify: `server/test/fake-claude.mjs`
- Test: `server/test/session-control.test.ts`
- (Sem mudança de produção esperada: o `session.ts` da Task 1 já trata `control_cancel_request` e a política. Esta tarefa PROVA os três comportamentos contra o fake.)

**Interfaces:**
- Fake: `interrupt` com pendência → `control_cancel_request` + `control_response` + `tool_result` de rejeição + `user/text` "[Request interrupted by user for tool use]" + `result/error_during_execution`. `pedido-interativo` → `can_use_tool` de `ExitPlanMode` com `requires_user_interaction:true`. `pedido-comum` → `can_use_tool` de `Bash` sem interação.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao mesmo `describe`:

```ts
  it('interrupt com pergunta aberta: a CLI cancela (control_cancel_request) e a pendência some', async () => {
    const s = await askAndWait()
    await s.interrupt()
    await waitUntil(() => s.pendingQuestion === undefined)
    expect(s.status).toBe('needs_attention')
  })

  it('pedido interativo de OUTRA tool é negado com explicação — o modelo fica sabendo', async () => {
    const s = start()
    const rs = results(s)
    await waitUntil(() => s.status === 'idle')
    s.send('pedido-interativo')
    await waitUntil(() => rs.length === 1)
    expect(rs[0]).toMatch(/negado/)
    expect(rs[0]).toMatch(/ainda não exibe este pedido \(ExitPlanMode\)/)
    expect(s.pendingQuestion).toBeUndefined()
  })

  it('pedido sem interação é permitido (espelha o bypass)', async () => {
    const s = start()
    const rs = results(s)
    await waitUntil(() => s.status === 'idle')
    s.send('pedido-comum')
    await waitUntil(() => rs.length === 1)
    expect(rs[0]).toBe('eco: permitido')
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts`
Expected: FAIL nos três (timeout: o fake ainda não conhece os gatilhos nem o cancel).

- [ ] **Step 3: O fake aprende o cancel e os dois pedidos**

Em `server/test/fake-claude.mjs`:

(a) No handler `if (r.subtype === 'interrupt') {` (dentro de `control_request`), ANTES do `out({ type: 'control_response', …})` existente:
```js
      if (pendingQuestion) {
        // Ordem EMPÍRICA (probe H): a CLI cancela o pedido pendente ANTES de
        // responder o interrupt, e o tool_result de rejeição vem depois.
        const p = pendingQuestion; pendingQuestion = null
        out({ type: 'control_cancel_request', request_id: p.request_id })
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } })
        out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, is_error: true,
          content: "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed." }] } })
        out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 })
        return
      }
```

(b) Logo após o bloco `if (text.includes('faz-pergunta')) { … }`:
```js
  if (text.includes('pedido-interativo')) {
    // Outro pedido que exige humano (ex.: aprovação de plano): o host deve NEGAR com explicação.
    pendingQuestion = { request_id: 'q-req-2', tool_use_id: 'toolu_q_2' }
    out({ type: 'control_request', request_id: 'q-req-2', request: {
      subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' }, tool_use_id: 'toolu_q_2', requires_user_interaction: true } })
    return
  }
  if (text.includes('pedido-comum')) {
    // Pedido sem interação (nunca chega na CLI real em bypass; defensivo): o host permite.
    pendingQuestion = { request_id: 'q-req-3', tool_use_id: 'toolu_q_3' }
    out({ type: 'control_request', request_id: 'q-req-3', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo oi' }, tool_use_id: 'toolu_q_3' } })
    return
  }
```

(c) Cabeçalho: acrescente
```js
//   contém "pedido-interativo" -> can_use_tool de ExitPlanMode com requires_user_interaction (espera deny)
//   contém "pedido-comum"      -> can_use_tool de Bash sem interação (espera allow)
//   interrupt com pergunta pendente -> control_cancel_request antes do control_response (probe H)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/session-control.test.ts test/session.test.ts test/auto-compact.test.ts`
Expected: PASS. (Se o teste de interrupt falhar por status, confira que `answerQuestion`/cancel não engoliram o `error_during_execution`: o `swallowInterruptedResult` só arma quando `interrupt()` fecha antecipado — aqui o result chega antes, então não arma.)

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add server/test/fake-claude.mjs server/test/session-control.test.ts && git commit -q -F - <<'MSG'
test(perguntas): interrupt cancela a pergunta; outros pedidos seguem a política

O fake replica o control_cancel_request que a CLI manda antes de responder
o interrupt (probe H) e dois pedidos fora da AskUserQuestion: interativo
(negado com explicação) e comum (permitido).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Manager publica a pendência e encaminha a resposta

**Files:**
- Modify: `server/src/engine/types.ts` (~L38-41, ao lado de `startAuth?`/`completeAuth?`)
- Modify: `server/src/claude/manager.ts` (`SessionInfo` ~L10-38; `wire()` ~L167-257; `infoOf` ~L259-277; API após `completeAuth` ~L376-381)
- Test: `server/test/ask-user-question.test.ts` (criar)

**Interfaces:**
- Consumes: `PendingQuestion`, `ClaudeSession.pendingQuestion/answerQuestion/dismissQuestion` (Tasks 1–2).
- Produces:
  ```ts
  // engine/types.ts
  interface EngineSession { readonly pendingQuestion?: PendingQuestion; answerQuestion?(answers: Record<string, string>): void; dismissQuestion?(): void }
  // manager.ts
  interface SessionInfo { pendingQuestion?: PendingQuestion }
  manager.answerQuestion(localId: string, answers: Record<string, string>): void
  manager.dismissQuestion(localId: string): void
  ```
- Toda mensagem `session_status` emitida pelo `wire()` carrega `pendingQuestion` (ausente quando não há).

- [ ] **Step 1: Escrever os testes que falham**

Crie `server/test/ask-user-question.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let db: Db
let project: Project
let broadcasts: any[]

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  broadcasts = []
})

const statusesOf = (localId: string) => broadcasts.filter((b) => b.type === 'session_status' && b.localId === localId)
const resultsOf = (localId: string) => broadcasts.filter((b) => b.type === 'session_event' && b.localId === localId && b.event?.kind === 'result')

const askAndWait = async () => {
  const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  mgr.send(localId, 'faz-pergunta')
  await waitUntil(() => mgr.get(localId)?.pendingQuestion !== undefined)
  return { mgr, localId }
}

describe('perguntas do agente (AskUserQuestion) no manager', () => {
  it('a pergunta chega aos clientes pelo session_status e está no list() (snapshot)', async () => {
    const { mgr, localId } = await askAndWait()
    const comPergunta = statusesOf(localId).filter((s) => s.pendingQuestion)
    expect(comPergunta.length).toBeGreaterThan(0)
    expect(comPergunta.at(-1).pendingQuestion).toMatchObject({ toolUseId: 'toolu_q_1' })
    expect(comPergunta.at(-1).pendingQuestion.questions).toHaveLength(2)
    expect(comPergunta.at(-1).status).toBe('working')
    expect(mgr.list().find((s) => s.localId === localId)?.pendingQuestion?.toolUseId).toBe('toolu_q_1')
    await mgr.stopAll()
  })

  it('answerQuestion pelo manager: o turno continua e o status seguinte vai SEM a pendência', async () => {
    const { mgr, localId } = await askAndWait()
    mgr.answerQuestion(localId, { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Banana' })
    await waitUntil(() => resultsOf(localId).length === 1)
    expect(resultsOf(localId)[0].event.resultText).toContain('"Qual cor você prefere?"="Verde"')
    expect(mgr.get(localId)?.pendingQuestion).toBeUndefined()
    expect(statusesOf(localId).at(-1).pendingQuestion).toBeUndefined()
    await mgr.stopAll()
  })

  it('dismissQuestion pelo manager nega a pergunta', async () => {
    const { mgr, localId } = await askAndWait()
    mgr.dismissQuestion(localId)
    await waitUntil(() => resultsOf(localId).length === 1)
    expect(resultsOf(localId)[0].event.resultText).toMatch(/negado/)
    expect(mgr.get(localId)?.pendingQuestion).toBeUndefined()
    await mgr.stopAll()
  })

  it('sessão inexistente / sem pendência → erro claro', async () => {
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    expect(() => mgr.answerQuestion('nao-existe', { a: 'b' })).toThrow(/não está ativa/)
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    expect(() => mgr.answerQuestion(localId, { a: 'b' })).toThrow(/pendente/)
    await mgr.stopAll()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/ask-user-question.test.ts`
Expected: FAIL — `pendingQuestion` nunca aparece em `mgr.get()` / `answerQuestion is not a function`.

- [ ] **Step 3: Interface da engine**

Em `server/src/engine/types.ts`, troque a importação de tipos da sessão e acrescente os membros após `completeAuth?(codeOrUrl: string): Promise<void>`:

```ts
import type { SessionStatus, HermesOptions, PendingQuestion } from '../claude/session.js'
```
```ts
  /**
   * Pergunta (AskUserQuestion) que a engine fez e está esperando o operador —
   * só o Claude Code tem isso. Estado do processo vivo, publicado no SessionInfo.
   */
  readonly pendingQuestion?: PendingQuestion
  /** Responde a pergunta pendente (`answers` chaveado pelo texto da pergunta) / nega para responder em prosa. */
  answerQuestion?(answers: Record<string, string>): void
  dismissQuestion?(): void
```

- [ ] **Step 4: Manager — SessionInfo, infoOf, helper de status, API**

Em `server/src/claude/manager.ts`:

(a) Importe o tipo: na linha que importa de `'./session.js'`, acrescente `type PendingQuestion`.

(b) Em `SessionInfo`, após `contextWindow?: number`:
```ts
  /** Pergunta (AskUserQuestion) esperando o operador — só sessão VIVA, só memória. Ausente = nenhuma. */
  pendingQuestion?: PendingQuestion
```

(c) Em `infoOf`, após `contextWindow: liveEntry?.contextWindow,`:
```ts
      pendingQuestion: liveEntry?.session.pendingQuestion,
```

(d) Em `wire()`, logo após `live.set(localId, { session, projectId, engine })`, crie o helper e use-o nos TRÊS broadcasts do `wire()`:
```ts
    // Um lugar só monta o session_status do wire(): cada campo novo do SessionInfo
    // (hoje, pendingQuestion) entra aqui e chega igual nos três momentos em que
    // ele publica — mudança de status, init e arranque.
    const statusMsg = (over: { status?: SessionStatus; engineSessionId?: string | null; detail?: string } = {}) => {
      const info = infoOf(localId)
      return {
        type: 'session_status' as const, localId, projectId,
        engine: info?.engine ?? engine,
        status: over.status ?? session.status,
        engineSessionId: over.engineSessionId !== undefined ? over.engineSessionId : effectiveEngineSessionId(localId, session),
        detail: over.detail,
        model: info?.model ?? null, permissionMode: info?.permissionMode, effort: info?.effort ?? null,
        backgroundTasks: info?.backgroundTasks ?? [], authExpired: info?.authExpired ?? false,
        contextWindow: info?.contextWindow,
        pendingQuestion: info?.pendingQuestion,
      }
    }
```
Substituições:
- No `session.on('status', …)`: a linha `deps.broadcast({ type: 'session_status', localId, projectId, engine: info?.engine ?? engine, status, engineSessionId: …, detail, … })` vira `deps.broadcast(statusMsg({ status, detail }))` (a `const info = infoOf(localId)` daquela linha fica sem uso — remova-a).
- No bloco `if (event.sessionId) {` do init: `deps.broadcast(statusMsg({ engineSessionId: event.sessionId }))` (remova `const infoI = infoOf(localId)`).
- Após `session.start()`: `deps.broadcast(statusMsg())` (remova `const info0 = infoOf(localId)`).

(e) API, logo após `completeAuth` (~L381):
```ts
    /** Responde a pergunta (AskUserQuestion) que a sessão está esperando — só Claude. */
    answerQuestion(localId: string, answers: Record<string, string>): void {
      const session = live.get(localId)?.session
      if (!session) throw new Error(`sessão ${localId} não está ativa`)
      if (!session.answerQuestion) throw new Error('esta engine não faz perguntas estruturadas')
      session.answerQuestion(answers)
    },

    /** Nega a pergunta pendente: o operador vai responder em prosa pela caixa de mensagem. */
    dismissQuestion(localId: string): void {
      const session = live.get(localId)?.session
      if (!session) throw new Error(`sessão ${localId} não está ativa`)
      if (!session.dismissQuestion) throw new Error('esta engine não faz perguntas estruturadas')
      session.dismissQuestion()
    },
```

- [ ] **Step 5: Rodar e ver passar (e a suíte do manager inteira, por causa do helper)**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/ask-user-question.test.ts test/manager.test.ts test/engine-manager.test.ts test/auto-compact.test.ts test/routes-sessions.test.ts && cd .. && npx tsc --noEmit -p server/tsconfig.json`
Expected: PASS em tudo; tsc limpo.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add server/src/engine/types.ts server/src/claude/manager.ts server/test/ask-user-question.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): manager publica a pendência no session_status e encaminha a resposta

pendingQuestion entra no SessionInfo (memória, como backgroundTasks) e num
helper único monta o session_status do wire() — antes cada campo novo era
copiado em três broadcasts à mão.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: WS — `answer_question` e `dismiss_question`

**Files:**
- Modify: `server/src/routes/ws.ts` (~L121-124, ao lado de `interrupt`)
- Test: `server/test/ws.test.ts`

**Interfaces:**
- Consumes: `manager.answerQuestion`/`dismissQuestion` (Task 4).
- Produces (contrato com a UI, Task 8): cliente → servidor `{ type: 'answer_question', localId, answers: Record<string,string> }` e `{ type: 'dismiss_question', localId }`; erro volta como `{ type: 'error', localId, message }` só para quem pediu.

- [ ] **Step 1: Escrever os testes que falham**

Acrescente ao `describe('websocket hub')` de `server/test/ws.test.ts` (reaproveita `collect`, `waitUntil`, `app`, `port`):

```ts
  const abrirComPergunta = async (ws: WebSocket, msgs: any[]) => {
    await waitUntil(() => msgs.some((m) => m.type === 'sessions_snapshot'))
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'PQ', path: mkdtempSync(join(tmpdir(), 'tm-')) } })
    const sess = await app.inject({ method: 'POST', url: `/api/projects/${post.json().id}/sessions` })
    const { localId } = sess.json()
    await waitUntil(() => msgs.some((m) => m.type === 'session_status' && m.localId === localId && m.status === 'idle'))
    ws.send(JSON.stringify({ type: 'send_message', localId, text: 'faz-pergunta' }))
    await waitUntil(() => msgs.some((m) => m.type === 'session_status' && m.localId === localId && m.pendingQuestion))
    return localId
  }

  it('answer_question pelo socket responde a pergunta pendente e o turno continua', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs: any[] = collect(ws)
    const localId = await abrirComPergunta(ws, msgs)
    ws.send(JSON.stringify({ type: 'answer_question', localId, answers: { 'Qual cor você prefere?': 'Azul', 'Quais frutas você gosta?': 'Maçã' } }))
    await waitUntil(() => msgs.some((m) => m.type === 'session_event' && m.localId === localId && m.event?.kind === 'result' && /"Azul"/.test(m.event.resultText)))
    const ultimo = msgs.filter((m) => m.type === 'session_status' && m.localId === localId).at(-1)
    expect(ultimo.status).toBe('needs_attention')
    expect(ultimo.pendingQuestion).toBeUndefined()
    ws.close()
  })

  it('dismiss_question pelo socket nega a pergunta', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs: any[] = collect(ws)
    const localId = await abrirComPergunta(ws, msgs)
    ws.send(JSON.stringify({ type: 'dismiss_question', localId }))
    await waitUntil(() => msgs.some((m) => m.type === 'session_event' && m.localId === localId && m.event?.kind === 'result' && /negado/.test(m.event.resultText)))
    ws.close()
  })

  it('answer_question sem pergunta pendente devolve erro só ao solicitante', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs: any[] = collect(ws)
    await waitUntil(() => msgs.some((m) => m.type === 'sessions_snapshot'))
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'PQ2', path: mkdtempSync(join(tmpdir(), 'tm-')) } })
    const sess = await app.inject({ method: 'POST', url: `/api/projects/${post.json().id}/sessions` })
    const { localId } = sess.json()
    await waitUntil(() => msgs.some((m) => m.type === 'session_status' && m.localId === localId && m.status === 'idle'))
    ws.send(JSON.stringify({ type: 'answer_question', localId, answers: { x: 'y' } }))
    await waitUntil(() => msgs.some((m) => m.type === 'error' && /pendente/.test(m.message)))
    ws.close()
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/ws.test.ts`
Expected: FAIL nos três novos (timeout: a mensagem é ignorada).

- [ ] **Step 3: Implementar**

Em `server/src/routes/ws.ts`, após a linha do `interrupt` (~L123):
```ts
            // Pergunta do agente (AskUserQuestion): responder ou dispensar. Ação de
            // chat como send_message/interrupt — sem payload de volta, o status
            // seguinte é a confirmação.
            else if (msg.type === 'answer_question') deps.manager.answerQuestion(msg.localId, msg.answers)
            else if (msg.type === 'dismiss_question') deps.manager.dismissQuestion(msg.localId)
```
(Os `throw` do manager caem no `catch` existente, que devolve `{ type: 'error' }` ao socket.)

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run test/ws.test.ts test/auth-ws.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add server/src/routes/ws.ts server/test/ws.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): answer_question e dismiss_question pelo WebSocket

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Web — tipos, store e notificação

**Files:**
- Modify: `web/src/types.ts` (~L36, após `contextWindow?: number`; tipos após `ContentBlock`)
- Modify: `web/src/notifications.ts`
- Modify: `web/src/store.ts` (handler `session_status` ~L330-375)
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts` (bloco `notify`)
- Test: `web/src/test/question-store.test.ts` (criar)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface QuestionOption { label: string; description: string }
  export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
  export interface PendingQuestion { toolUseId: string; questions: Question[] }
  interface SessionInfo { pendingQuestion?: PendingQuestion }
  // notifications.ts
  export function notifyQuestion(projectName: string): void
  ```
- i18n: `notify.question`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `web/src/test/question-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { useStore } from '../store'
import { notifyQuestion } from '../notifications'
import type { PendingQuestion } from '../types'

const PENDING: PendingQuestion = { toolUseId: 'toolu_q_1', questions: [
  { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'Cor azul' }] },
] }
const status = (extra: object) => ({ type: 'session_status', localId: 'l1', projectId: 1, status: 'working', engineSessionId: 'c1', engine: 'claude', ...extra })

beforeEach(() => {
  useStore.setState({ projects: [{ id: 1, name: 'Alpha', path: '/tmp', color: '#fff', icon: '📁' }], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, activeLocalId: undefined, view: 'dashboard', board: [], tasks: [], sessionEffort: {} })
  vi.mocked(notifyQuestion).mockClear()
})

describe('pergunta pendente no store', () => {
  it('session_status com pendingQuestion guarda a pergunta e notifica UMA vez (não a cada rebroadcast)', () => {
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    expect(useStore.getState().sessions['l1'].pendingQuestion).toEqual(PENDING)
    expect(notifyQuestion).toHaveBeenCalledTimes(1)
    expect(notifyQuestion).toHaveBeenCalledWith('Alpha')
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    expect(notifyQuestion).toHaveBeenCalledTimes(1)
  })

  it('session_status SEM pendingQuestion limpa: ausente significa "nenhuma", não "mantém a anterior"', () => {
    useStore.getState().applyWsMessage(status({ pendingQuestion: PENDING }))
    useStore.getState().applyWsMessage(status({ status: 'needs_attention' }))
    expect(useStore.getState().sessions['l1'].pendingQuestion).toBeUndefined()
  })

  it('sessions_snapshot traz a pendência (reload / outra aba)', () => {
    useStore.getState().applyWsMessage({ type: 'sessions_snapshot', sessions: [
      { localId: 'l1', projectId: 1, status: 'working', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude', pendingQuestion: PENDING },
    ] })
    expect(useStore.getState().sessions['l1'].pendingQuestion?.toolUseId).toBe('toolu_q_1')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-store.test.ts`
Expected: FAIL no primeiro (`pendingQuestion` undefined, `notifyQuestion` não chamado). Os outros dois podem passar por acaso (o spread do snapshot já carrega o campo) — o que importa é o primeiro falhar.

- [ ] **Step 3: Tipos**

Em `web/src/types.ts`, após a interface `ContentBlock` (~L60):
```ts
export interface QuestionOption { label: string; description: string }
/** Uma pergunta da AskUserQuestion, como a CLI a manda. */
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
/** Pergunta que o agente fez e está esperando resposta. Estado do processo vivo: vem no session_status/snapshot, nunca do histórico. */
export interface PendingQuestion { toolUseId: string; questions: Question[] }
```
Em `SessionInfo`, após `contextWindow?: number`:
```ts
  /** Pergunta (AskUserQuestion) esperando você. Ausente = nenhuma. */
  pendingQuestion?: PendingQuestion
```

- [ ] **Step 4: Notificação**

Em `web/src/notifications.ts`, após `notifySessionChange`:
```ts
/** O agente fez uma pergunta e parou: é o caso mais "esperando você" que existe. */
export function notifyQuestion(projectName: string): void {
  beep()
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`Claudinei · ${projectName}`, { body: i18n.t('notify.question') })
  }
}
```
i18n, no bloco `notify` de cada locale:
- pt-BR: `notify: { needsAttention: 'terminou e aguarda você', died: 'sessão morreu', question: 'tem uma pergunta para você' },`
- en: `notify: { needsAttention: 'finished and awaits you', died: 'session died', question: 'has a question for you' },`
- es: `notify: { needsAttention: 'terminó y te espera', died: 'la sesión murió', question: 'tiene una pregunta para ti' },`

- [ ] **Step 5: Store**

Em `web/src/store.ts`:
- Importação: `import { notifyQuestion, notifySessionChange } from './notifications'`.
- No handler `msg.type === 'session_status'`, logo após `notifySessionChange(projectName, msg.status, prev)`:
```ts
      // Pergunta nova (não havia, agora há): avisa uma vez. Os rebroadcasts do
      // mesmo status com a mesma pergunta não repetem o aviso.
      if (msg.pendingQuestion && !get().sessions[msg.localId]?.pendingQuestion) notifyQuestion(projectName)
```
- No objeto montado dentro do `set(…)`, após a linha `contextWindow: …`:
```ts
            // Pergunta do agente: SEM fallback para a anterior — o servidor manda o
            // campo sempre que há pergunta; ausente quer dizer que não há mais.
            pendingQuestion: msg.pendingQuestion,
```

- [ ] **Step 6: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-store.test.ts src/test/store.test.ts src/test/notifications.test.ts && cd .. && npx tsc --noEmit -p web/tsconfig.json`
Expected: PASS; tsc limpo.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add web/src/types.ts web/src/notifications.ts web/src/store.ts web/src/i18n/pt-BR.ts web/src/i18n/en.ts web/src/i18n/es.ts web/src/test/question-store.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): store guarda a pergunta pendente e avisa quando ela chega

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 7: "Esperando você" com pergunta pendente

**Files:**
- Modify: `web/src/engineSession.ts` (`displayStatusKey` ~L104, `isWaitingForYou` ~L117, `dotClassOf` ~L122)
- Modify: `web/src/components/AgentFace.tsx` (~L27)
- Modify: `web/src/i18n/{pt-BR,en,es}.ts` (bloco `status`)
- Test: `web/src/test/question-waiting.test.ts` (criar)

**Interfaces:**
- Consumes: `SessionInfo.pendingQuestion` (Task 6).
- Produces: com pergunta pendente, `isWaitingForYou` → `true`; `dotClassOf` → `'status-dot status-needs_attention'`; `displayStatusKey` → `'question'` (chave `status.question`); `faceStateOf` → `'attention'`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `web/src/test/question-waiting.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isWaitingForYou, dotClassOf, displayStatusKey } from '../engineSession'
import { faceStateOf } from '../components/AgentFace'
import type { PendingQuestion, SessionInfo } from '../types'

const PENDING: PendingQuestion = { toolUseId: 't', questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [] }] }
const sess = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'working', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...over })

describe('pergunta pendente = esperando você', () => {
  it('âmbar, rótulo próprio e cara de atenção — mesmo com a sessão em working', () => {
    const s = sess({ pendingQuestion: PENDING })
    expect(isWaitingForYou(s)).toBe(true)
    expect(dotClassOf(s)).toBe('status-dot status-needs_attention')
    expect(displayStatusKey(s)).toBe('question')
    expect(faceStateOf(s)).toBe('attention')
  })

  it('working sem pergunta continua sendo trabalho, não espera', () => {
    const s = sess()
    expect(isWaitingForYou(s)).toBe(false)
    expect(dotClassOf(s)).toBe('status-dot status-working')
    expect(displayStatusKey(s)).toBe('working')
    expect(faceStateOf(s)).toBe('working')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-waiting.test.ts`
Expected: FAIL no primeiro (`false`, `status-working`, `working`, `working`).

- [ ] **Step 3: Implementar**

Em `web/src/engineSession.ts`:
```ts
export function displayStatusKey(s: SessionInfo): string {
  // O agente perguntou e parou: é o rótulo que importa, não o "trabalhando" do turno aberto.
  if (s.pendingQuestion) return 'question'
  if (s.status === 'in_terminal' && s.terminalActivity && s.terminalActivity !== 'idle') {
    return `in_terminal_${s.terminalActivity}`
  }
  return s.status
}
```
```ts
export function isWaitingForYou(s: SessionInfo): boolean {
  // Três caminhos: needs_attention (chat), pergunta pendente (o agente parou e
  // perguntou — o turno segue `working`, mas quem trava é você) e o TUI parado.
  return s.status === 'needs_attention' || !!s.pendingQuestion || (s.status === 'in_terminal' && s.terminalActivity === 'waiting')
}
```
```ts
export function dotClassOf(s: SessionInfo): string {
  if (s.pendingQuestion) return 'status-dot status-needs_attention'
  if (s.status === 'in_terminal' && s.terminalActivity === 'waiting') return 'status-dot status-needs_attention'
  if (s.status === 'in_terminal' && s.terminalActivity === 'working') return 'status-dot status-in_terminal status-dot--pulse'
  return `status-dot status-${s.status}`
}
```
Em `web/src/components/AgentFace.tsx`, a linha do `isWaitingForYou`:
```ts
  // A vez é sua nos dois casos, mas o amarelo é RESERVADO a quem perguntou: o motor
  // parou e espera resposta — needs_attention e a pergunta pendente. O terminal
  // parado no prompt é o roxo — ele não perguntou nada, só chegou ao fim da linha.
  if (isWaitingForYou(session)) return session.status === 'needs_attention' || session.pendingQuestion ? 'attention' : 'waiting'
```
i18n, no bloco `status` de cada locale, acrescente a chave `question`:
- pt-BR: `question: 'aguardando sua resposta',`
- en: `question: 'awaiting your answer',`
- es: `question: 'esperando tu respuesta',`

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-waiting.test.ts src/test/store.test.ts src/test/waiting-highlight.test.tsx src/test/agent-face.test.tsx src/test/sidebar.test.tsx src/test/engine-tabs-stop.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add web/src/engineSession.ts web/src/components/AgentFace.tsx web/src/i18n/pt-BR.ts web/src/i18n/en.ts web/src/i18n/es.ts web/src/test/question-waiting.test.ts && git commit -q -F - <<'MSG'
feat(perguntas): pergunta pendente conta como "esperando você"

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 8: `QuestionPanel`

**Files:**
- Create: `web/src/components/QuestionPanel.tsx`
- Modify: `web/src/styles.css` (após o bloco `.reauth__error`, ~L1679)
- Modify: `web/src/i18n/{pt-BR,en,es}.ts` (bloco novo `question`, ao lado de `engineAuth`)
- Test: `web/src/test/question-panel.test.tsx` (criar)

**Interfaces:**
- Consumes: `PendingQuestion` (Task 6); `WsContext` (`send(msg: object)`); contrato WS da Task 5.
- Produces:
  ```tsx
  export function QuestionPanel({ localId, pending }: { localId: string; pending: PendingQuestion }): JSX.Element
  export function answerOf(d: { picked: Set<string>; other: string } | undefined, multi: boolean): string  // pura, testável
  ```
  `data-testid="question-panel"`. Envia `{ type: 'answer_question', localId, answers }` / `{ type: 'dismiss_question', localId }`.
- i18n: `question.titleOne`, `question.titleMany` (`{{count}}`), `question.progress` (`{{done}}`, `{{total}}`), `question.other`, `question.otherPlaceholder`, `question.answerInChat`, `question.submit`.

- [ ] **Step 1: Escrever os testes que falham**

Crie `web/src/test/question-panel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { QuestionPanel, answerOf } from '../components/QuestionPanel'
import { WsContext } from '../wsContext'
import type { PendingQuestion } from '../types'

const DUAS: PendingQuestion = { toolUseId: 'toolu_q_1', questions: [
  { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false,
    options: [{ label: 'Azul', description: 'Cor azul' }, { label: 'Verde', description: 'Cor verde' }] },
  { question: 'Quais frutas você gosta?', header: 'Frutas', multiSelect: true,
    options: [{ label: 'Maçã', description: 'Fruta vermelha' }, { label: 'Banana', description: 'Fruta amarela' }] },
] }
const UMA: PendingQuestion = { toolUseId: 'toolu_q_2', questions: [DUAS.questions[0]] }

const mount = (pending: PendingQuestion) => {
  const send = vi.fn()
  render(<WsContext.Provider value={{ send }}><QuestionPanel localId="s1" pending={pending} /></WsContext.Provider>)
  return send
}
const enviar = () => screen.getByRole('button', { name: /enviar respostas/i }) as HTMLButtonElement
afterEach(cleanup)

describe('QuestionPanel', () => {
  it('uma pergunta: sem abas, Enviar travado até escolher, e a escolha vai como answer_question', () => {
    const send = mount(UMA)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(enviar().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Azul/))
    expect(enviar().disabled).toBe(false)
    fireEvent.click(enviar())
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1', answers: { 'Qual cor você prefere?': 'Azul' } })
  })

  it('várias perguntas: abas com o header, ✓ na respondida, Enviar só com todas', () => {
    const send = mount(DUAS)
    const abas = screen.getAllByRole('tab')
    expect(abas.map((a) => a.textContent)).toEqual(['Cor', 'Frutas'])
    fireEvent.click(screen.getByLabelText(/Verde/))
    expect(abas[0].className).toContain('done')
    expect(enviar().disabled).toBe(true)
    fireEvent.click(abas[1])
    fireEvent.click(screen.getByLabelText(/Maçã/))
    fireEvent.click(screen.getByLabelText(/Banana/))
    expect(enviar().disabled).toBe(false)
    fireEvent.click(enviar())
    // múltipla escolha: rótulos separados por ", " — como a CLI faz
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1',
      answers: { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Maçã, Banana' } })
  })

  it('"Outra resposta…" abre o campo e o texto digitado vira a resposta', () => {
    const send = mount(UMA)
    fireEvent.click(screen.getByLabelText(/outra resposta/i))
    const campo = screen.getByPlaceholderText(/escreva sua resposta/i)
    fireEvent.change(campo, { target: { value: 'Roxo, na verdade' } })
    fireEvent.keyDown(campo, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1', answers: { 'Qual cor você prefere?': 'Roxo, na verdade' } })
  })

  it('"Responder pelo chat" manda dismiss_question', () => {
    const send = mount(UMA)
    fireEvent.click(screen.getByRole('button', { name: /responder pelo chat/i }))
    expect(send).toHaveBeenCalledWith({ type: 'dismiss_question', localId: 's1' })
  })

  it('answerOf: livre substitui na simples e soma na múltipla; vazio não conta', () => {
    expect(answerOf(undefined, false)).toBe('')
    expect(answerOf({ picked: new Set(['Azul']), other: '' }, false)).toBe('Azul')
    expect(answerOf({ picked: new Set(['__other__']), other: '  Roxo ' }, false)).toBe('Roxo')
    expect(answerOf({ picked: new Set(['__other__']), other: '   ' }, false)).toBe('')
    expect(answerOf({ picked: new Set(['Maçã', '__other__']), other: 'Uva' }, true)).toBe('Maçã, Uva')
    expect(answerOf({ picked: new Set(['Maçã', 'Banana']), other: '' }, true)).toBe('Maçã, Banana')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-panel.test.tsx`
Expected: FAIL — módulo `../components/QuestionPanel` não existe.

- [ ] **Step 3: i18n**

Em cada locale, um bloco `question` logo antes de `engineAuth`:

pt-BR:
```ts
  question: {
    titleOne: 'O agente tem uma pergunta para você',
    titleMany: 'O agente tem {{count}} perguntas para você',
    progress: '{{done}} de {{total}} respondidas',
    other: 'Outra resposta…',
    otherPlaceholder: 'escreva sua resposta',
    answerInChat: 'Responder pelo chat',
    submit: 'Enviar respostas',
  },
```
en:
```ts
  question: {
    titleOne: 'The agent has a question for you',
    titleMany: 'The agent has {{count}} questions for you',
    progress: '{{done}} of {{total}} answered',
    other: 'Something else…',
    otherPlaceholder: 'type your answer',
    answerInChat: 'Answer in chat',
    submit: 'Send answers',
  },
```
es:
```ts
  question: {
    titleOne: 'El agente tiene una pregunta para ti',
    titleMany: 'El agente tiene {{count}} preguntas para ti',
    progress: '{{done}} de {{total}} respondidas',
    other: 'Otra respuesta…',
    otherPlaceholder: 'escribe tu respuesta',
    answerInChat: 'Responder por el chat',
    submit: 'Enviar respuestas',
  },
```

- [ ] **Step 4: Componente**

Crie `web/src/components/QuestionPanel.tsx`:

```tsx
import { useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WsContext } from '../wsContext'
import type { PendingQuestion } from '../types'

/** Marcador interno da linha "Outra resposta…". Nunca vai para a engine — só o texto digitado vai. */
const OTHER = '__other__'

interface Draft { picked: Set<string>; other: string }

/**
 * Resposta final de UMA pergunta no formato que a CLI espera: rótulos separados
 * por ", " (múltipla) ou um só (simples); o texto livre substitui na simples e
 * soma na múltipla. Vazio = ainda não respondida.
 */
export function answerOf(d: Draft | undefined, multi: boolean): string {
  if (!d) return ''
  const labels = [...d.picked].filter((l) => l !== OTHER)
  const free = d.picked.has(OTHER) ? d.other.trim() : ''
  if (!multi) return d.picked.has(OTHER) ? free : (labels[0] ?? '')
  return [...labels, ...(free ? [free] : [])].join(', ')
}

/**
 * A pergunta do agente (AskUserQuestion), acima da caixa de mensagem — o mesmo
 * lugar do diálogo no terminal. Abas por pergunta, opções com descrição, uma
 * linha extra para resposta livre, e Enviar só quando todas foram respondidas.
 *
 * Não há "erro inline": o servidor confirma pelo session_status (a pendência
 * some e o painel com ela). Se nada voltar em 5 s — pergunta já respondida em
 * outra aba, WS caiu —, os botões destravam para tentar de novo.
 */
export function QuestionPanel({ localId, pending }: { localId: string; pending: PendingQuestion }) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const [tab, setTab] = useState(0)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [busy, setBusy] = useState(false)

  // Pergunta nova (outro toolUseId): rascunhos e aba voltam ao zero.
  useEffect(() => { setTab(0); setDrafts({}); setBusy(false) }, [pending.toolUseId])
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => setBusy(false), 5000)
    return () => clearTimeout(timer)
  }, [busy])

  const qs = pending.questions
  const idx = Math.min(tab, qs.length - 1)
  const q = qs[idx]
  const answers = qs.map((qq, i) => answerOf(drafts[i], qq.multiSelect))
  const done = answers.filter(Boolean).length
  const complete = done === qs.length
  const d = drafts[idx]

  const toggle = (label: string) => setDrafts((all) => {
    const cur = all[idx] ?? { picked: new Set<string>(), other: '' }
    const picked = new Set(q.multiSelect ? cur.picked : [])
    if (q.multiSelect && cur.picked.has(label)) picked.delete(label)
    else picked.add(label)
    return { ...all, [idx]: { ...cur, picked } }
  })
  const setOther = (text: string) => setDrafts((all) => {
    const cur = all[idx] ?? { picked: new Set<string>(), other: '' }
    return { ...all, [idx]: { other: text, picked: new Set([...cur.picked, OTHER]) } }
  })

  const submit = () => {
    if (!complete || busy) return
    const map: Record<string, string> = {}
    qs.forEach((qq, i) => { map[qq.question] = answers[i] })
    setBusy(true)
    ws?.send({ type: 'answer_question', localId, answers: map })
  }
  const dismiss = () => {
    if (busy) return
    setBusy(true)
    ws?.send({ type: 'dismiss_question', localId })
  }

  const kind = q.multiSelect ? 'checkbox' : 'radio'
  return (
    <div className="qpanel" role="group" data-testid="question-panel"
         aria-label={qs.length === 1 ? t('question.titleOne') : t('question.titleMany', { count: qs.length })}>
      <div className="qpanel__head">
        <span aria-hidden="true">❔</span>
        <span className="qpanel__title">{qs.length === 1 ? t('question.titleOne') : t('question.titleMany', { count: qs.length })}</span>
        {qs.length > 1 && <span className="qpanel__progress">{t('question.progress', { done, total: qs.length })}</span>}
      </div>
      {qs.length > 1 && (
        <div className="qpanel__tabs" role="tablist">
          {qs.map((qq, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === idx}
                    className={`qpanel__tab ${i === idx ? 'active' : ''} ${answers[i] ? 'done' : ''}`}
                    onClick={() => setTab(i)}>{qq.header}</button>
          ))}
        </div>
      )}
      <div className="qpanel__question">{q.question}</div>
      <ul className="qpanel__opts">
        {q.options.map((o) => (
          <li key={o.label}>
            <label className="qpanel__opt">
              <input type={kind} name={`q-${idx}`} checked={!!d?.picked.has(o.label)} onChange={() => toggle(o.label)} />
              <span>
                <span className="qpanel__opt-label">{o.label}</span>
                {o.description && <div className="qpanel__opt-desc">{o.description}</div>}
              </span>
            </label>
          </li>
        ))}
        <li>
          <label className="qpanel__opt">
            <input type={kind} name={`q-${idx}`} checked={!!d?.picked.has(OTHER)} onChange={() => toggle(OTHER)} />
            <span style={{ flex: 1 }}>
              <span className="qpanel__opt-label">{t('question.other')}</span>
              {d?.picked.has(OTHER) && (
                <input className="qpanel__free" autoFocus value={d.other} placeholder={t('question.otherPlaceholder')}
                       onChange={(e) => setOther(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter' && qs.length === 1) { e.preventDefault(); submit() } }} />
              )}
            </span>
          </label>
        </li>
      </ul>
      <div className="qpanel__foot">
        <button type="button" className="ghost" disabled={busy} onClick={dismiss}>{t('question.answerInChat')}</button>
        <button type="button" disabled={!complete || busy} onClick={submit}>{t('question.submit')}</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: CSS**

Em `web/src/styles.css`, logo após `.reauth__error { … }`:

```css
/* Pergunta do agente (AskUserQuestion), acima da caixa de mensagem. É um PEDIDO,
   não um alerta: o tom é o de destaque, não o âmbar de aviso do .reauth. */
.qpanel {
  display: flex; flex-direction: column; gap: 10px;
  margin: 8px 20px 0; padding: 12px 14px; border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  font-size: 13px;
}
.qpanel__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qpanel__title { flex: 1; font-weight: 600; }
.qpanel__progress { color: var(--text-dim); font-size: 12px; }
.qpanel__tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.qpanel__tab {
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px 8px;
  background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer;
}
.qpanel__tab.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.qpanel__tab.done::before { content: '✓ '; }
.qpanel__question { font-weight: 600; }
.qpanel__opts { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.qpanel__opt {
  display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer;
}
.qpanel__opt:has(input:checked) { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.qpanel__opt:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.qpanel__opt > input { margin-top: 3px; flex: none; }
.qpanel__opt-label { font-weight: 600; }
.qpanel__opt-desc { color: var(--text-dim); font-size: 12px; }
.qpanel__free { display: block; width: 100%; min-width: 0; font-size: 12.5px; margin-top: 6px; }
.qpanel__foot { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
```

- [ ] **Step 6: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/question-panel.test.tsx && cd .. && npx tsc --noEmit -p web/tsconfig.json`
Expected: PASS; tsc limpo. Se `getByLabelText(/Azul/)` reclamar de múltiplos elementos, troque por `screen.getByRole('radio', { name: /Azul/ })` (e `checkbox` na múltipla).

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add web/src/components/QuestionPanel.tsx web/src/styles.css web/src/i18n/pt-BR.ts web/src/i18n/en.ts web/src/i18n/es.ts web/src/test/question-panel.test.tsx && git commit -q -F - <<'MSG'
feat(perguntas): QuestionPanel — abas, opções, resposta livre e envio pelo WS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 9: O painel no `ChatView` e o placeholder da caixa

**Files:**
- Modify: `web/src/components/ChatView.tsx` (~L265, antes de `<ReauthBanner …/>`)
- Modify: `web/src/components/ChatInput.tsx` (~L299-303, o `placeholder`)
- Modify: `web/src/i18n/{pt-BR,en,es}.ts` (bloco `chat`: `placeholderQuestion`)
- Test: `web/src/test/chatview.test.tsx`

**Interfaces:**
- Consumes: `QuestionPanel` (Task 8), `SessionInfo.pendingQuestion` (Task 6).
- i18n: `chat.placeholderQuestion`.

- [ ] **Step 1: Escrever os testes que falham**

No fim de `web/src/test/chatview.test.tsx` (reaproveita `sess`, `jsonResponse`, o `beforeEach`):

```tsx
const PENDING = { toolUseId: 'toolu_q_1', questions: [
  { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'Cor azul' }] },
] }

it('pergunta pendente: o painel aparece acima da caixa e o placeholder muda', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  useStore.setState({ sessions: { a: sess('a', { status: 'working', pendingQuestion: PENDING }) }, activeLocalId: 'a', view: 'chat' })
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  expect(screen.getByTestId('question-panel')).toBeTruthy()
  expect(screen.getByText('Qual cor você prefere?')).toBeTruthy()
  expect(screen.getByPlaceholderText(/responda acima/i)).toBeTruthy()
  spy.mockRestore()
})

it('sem pergunta pendente não há painel, e o placeholder de working continua o de sempre', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  useStore.setState({ sessions: { a: sess('a', { status: 'working' }) }, activeLocalId: 'a', view: 'chat' })
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  expect(screen.queryByTestId('question-panel')).toBeNull()
  expect(screen.getByPlaceholderText(/processando/i)).toBeTruthy()
  spy.mockRestore()
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/chatview.test.tsx`
Expected: FAIL no primeiro (`question-panel` não encontrado).

- [ ] **Step 3: Implementar**

`web/src/components/ChatView.tsx`:
- Importação: `import { QuestionPanel } from './QuestionPanel'`
- Antes de `<ReauthBanner localId={session.localId} expired={session.authExpired} />`:
```tsx
      {/* Pergunta do agente (AskUserQuestion): o painel mora aqui, acima da caixa,
          como o diálogo no terminal. Some sozinho quando o status chega sem ela. */}
      {session.pendingQuestion && session.status !== 'in_terminal' && (
        <QuestionPanel localId={session.localId} pending={session.pendingQuestion} />
      )}
```

`web/src/components/ChatInput.tsx`, no `placeholder` (a pergunta vem ANTES do `working`, porque o turno está aberto enquanto ela espera):
```tsx
          placeholder={
            uploading > 0 ? t('chat.placeholderUploading')
            : session?.pendingQuestion ? t('chat.placeholderQuestion')
            : session?.status === 'working' ? t('chat.placeholderWorking')
            : t(telaEstreita ? 'chat.placeholderShort' : 'chat.placeholder', { engine: engine?.label ?? 'Claude Code' })
          }
```

i18n, no bloco `chat` de cada locale, logo após `placeholderWorking`/`placeholderUploading`:
- pt-BR: `placeholderQuestion: 'Responda acima — ou escreva aqui para orientar o agente',`
- en: `placeholderQuestion: 'Answer above — or write here to steer the agent',`
- es: `placeholderQuestion: 'Responde arriba — o escribe aquí para orientar al agente',`

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/chatview.test.tsx src/test/chatview-terminal.test.tsx src/test/chatinput-stop.test.tsx src/test/chatinput-slash.test.tsx && cd .. && npx tsc --noEmit -p web/tsconfig.json`
Expected: PASS; tsc limpo.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add web/src/components/ChatView.tsx web/src/components/ChatInput.tsx web/src/i18n/pt-BR.ts web/src/i18n/en.ts web/src/i18n/es.ts web/src/test/chatview.test.tsx && git commit -q -F - <<'MSG'
feat(perguntas): painel acima da caixa de mensagem; placeholder avisa onde responder

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 10: `ToolCallCard` da `AskUserQuestion` (o que sobra no histórico)

**Files:**
- Modify: `web/src/components/ToolCallCard.tsx` (`TOOL_ICON` ~L9, `summarize` ~L14, bloco `{!isEdit && (` ~L59)
- Test: `web/src/test/toolcall.test.tsx`

**Interfaces:**
- Consumes: item `tool_call` com `name: 'AskUserQuestion'`, `input.questions`, `result` (texto "Your questions have been answered: …").

- [ ] **Step 1: Escrever o teste que falha**

Acrescente ao `describe('ToolCallCard')`:

```tsx
  it('AskUserQuestion: recolhido resume pelos headers; expandido lista as perguntas e as respostas', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't9', name: 'AskUserQuestion',
      input: { questions: [
        { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }] },
        { question: 'Quais frutas?', header: 'Frutas', multiSelect: true, options: [{ label: 'Maçã', description: '' }] },
      ] },
      result: 'Your questions have been answered: "Qual cor você prefere?"="Azul", "Quais frutas?"="Maçã". You can now continue with these answers in mind.' }} />)
    expect(screen.getByText('Cor, Frutas')).toBeTruthy()
    expect(screen.queryByText(/Azul \/ Verde/)).toBeNull()
    fireEvent.click(screen.getByText(/AskUserQuestion/))
    expect(screen.getByText('Qual cor você prefere?')).toBeTruthy()
    expect(screen.getByText(/Azul \/ Verde/)).toBeTruthy()
    expect(screen.getByText(/"Qual cor você prefere\?"="Azul"/)).toBeTruthy()
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/toolcall.test.tsx`
Expected: FAIL — o resumo sai vazio (nenhum dos campos de `summarize` existe no input).

- [ ] **Step 3: Implementar**

Em `web/src/components/ToolCallCard.tsx`:

(a) `TOOL_ICON`: acrescente `AskUserQuestion: '❔',`.

(b) `summarize`:
```ts
function summarize(item: ToolCallItem): string {
  const input = (item.input ?? {}) as Record<string, unknown>
  // Pergunta ao operador: o resumo é o assunto de cada aba (header), não um comando.
  if (item.name === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) ? (input.questions as { header?: string; question?: string }[]) : []
    const s = qs.map((q) => q.header || q.question || '').filter(Boolean).join(', ')
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  }
  const first = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
  const s = String(first)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
```

(c) No corpo expandido, ANTES de `{!isEdit && (` e trocando essa condição por `{!isEdit && item.name !== 'AskUserQuestion' && (`:
```tsx
          {item.name === 'AskUserQuestion' && Array.isArray(input.questions) && (
            <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12.5 }}>
              {(input.questions as { question?: string; options?: { label?: string }[] }[]).map((q, i) => (
                <li key={i}>
                  <strong>{q.question}</strong>
                  {q.options?.length ? <span style={{ color: 'var(--text-dim)' }}> — {q.options.map((o) => o.label).join(' / ')}</span> : null}
                </li>
              ))}
            </ul>
          )}
```
(O `result` continua renderizado pelo bloco existente abaixo — são as respostas.)

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run src/test/toolcall.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add web/src/components/ToolCallCard.tsx web/src/test/toolcall.test.tsx && git commit -q -F - <<'MSG'
feat(perguntas): card da AskUserQuestion mostra perguntas e respostas no histórico

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 11: Verificação final e spec em dia

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-perguntas-no-chat-design.md` (linha "Estado local `busy` após enviar; erro do servidor aparece inline…" e a linha da tabela "Responder o que já foi respondido")

- [ ] **Step 1: Suítes completas + typecheck**

Run:
```bash
cd /home/ubuntu/project/claudinei/claudinei/server && env -u NODE_ENV npx vitest run 2>&1 | tail -15
cd /home/ubuntu/project/claudinei/claudinei/web && env -u NODE_ENV npx vitest run 2>&1 | tail -15
cd /home/ubuntu/project/claudinei/claudinei && npx tsc --noEmit -p server/tsconfig.json && npx tsc --noEmit -p web/tsconfig.json && echo TSC_OK
```
Expected: server — só as 5 falhas conhecidas de `local-apps.test.ts`; web — só as 2 conhecidas de `start-session-modal.test.tsx`; `TSC_OK`. Qualquer outra falha: corrija na tarefa dona do arquivo antes de seguir.

- [ ] **Step 2: Alinhar a spec ao que foi construído**

Na spec, substitua a frase
`Estado local \`busy\` após enviar; erro do servidor aparece inline; o painel some quando o \`session_status\` seguinte chega sem pendência.`
por
`Estado local \`busy\` após enviar; a confirmação é o \`session_status\` seguinte sem pendência (o painel some). Sem retorno em 5 s — pergunta já respondida em outra aba, WS caiu — os botões destravam para tentar de novo; não há canal de erro inline.`
E na tabela de casos de borda, a linha "Responder o que já foi respondido…" passa a
`| Responder o que já foi respondido (outra aba, clique duplo) | servidor devolve erro ao socket; o painel já sumiu (ou some) pelo status; se nada voltar, os botões destravam em 5 s |`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/project/claudinei/claudinei && git add docs/superpowers/specs/2026-09-06-perguntas-no-chat-design.md && git commit -q -F - <<'MSG'
docs(spec): perguntas no chat — confirmação pelo status, sem erro inline

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

- [ ] **Step 4: Relatar**

Informe ao operador: commits locais (sem push), suítes e typecheck com o resultado observado, e que **empacotar/instalar/reiniciar** o serviço só acontece com autorização expressa dele.
