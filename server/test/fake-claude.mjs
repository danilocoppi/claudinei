#!/usr/bin/env node
// Fala o protocolo stream-json do claude para testes offline.
// Comportamentos por conteúdo da mensagem:
//   contém "use-tool"  -> emite tool_use + tool_result antes do texto
//   contém "crash"     -> encerra com exit 1 sem result (simula morte)
//   contém "devagar"   -> espera 300ms antes de responder (testa timeout)
//   contém "demorada"  -> responde assistant mas NUNCA emite result (turno só fecha com interrupt)
//   contém "demorada-junto" -> como "demorada", mas o interrupt devolve o control_response
//                         e o result de erro NUM write só: chegam no mesmo pedaço do
//                         stdout e o result é processado antes de o interrupt() resolver.
//   contém "com-bg"    -> como "demorada", mas antes anuncia uma task de background
//                         em aberto (reproduz o turno interrompido com shell rodando)
//   contém "compact-real" -> replica o stream REAL de uma compactação (capturado da
//                         CLI): status compacting, compact_boundary com pre/post_tokens,
//                         o resumo, e um result de usage ZERADO. NÃO use "/compact" para
//                         isto: o auto-compact manda literalmente "/compact" e conta com o eco.
//   contém "faz-pergunta" -> AskUserQuestion: tool_use + control_request can_use_tool
//                         (request_id q-req-1, tool_use_id toolu_q_1) e ESPERA o
//                         control_response do host para fechar o turno.
//                         control_response allow → tool_result "Your questions have been
//                         answered: …" + "eco: respostas …" + result; deny → tool_result
//                         is_error + "eco: negado <message>" + result.
//   contém "faz-duas-perguntas" -> duas AskUserQuestion back-to-back (q-req-1/toolu_q_1 e
//                         q-req-1b/toolu_q_1b) ANTES de qualquer control_response — testa
//                         que o host nega a 2ª na hora sem derrubar a 1ª pendência.
//   contém "pergunta-abandonada" -> AskUserQuestion cujo control_request é seguido
//                         IMEDIATAMENTE por um result (sem esperar resposta) — simula a
//                         CLI abortando o turno com a pergunta ainda aberta.
//   contém "turno-com-erro" -> fecha o turno com um result de erro (error_max_turns,
//                         is_error) sem ninguém ter pedido interrupção: o turno falhou.
//   contém "pedido-interativo" -> can_use_tool de ExitPlanMode com requires_user_interaction (espera deny)
//   contém "pedido-comum"      -> can_use_tool de Bash sem interação (espera allow)
//   interrupt com pergunta pendente -> control_cancel_request antes do control_response (probe H)
//   contém "faz-aviso" -> responde normal e, como o plugin "You should know", passa a
//                         desenhar um cartão no AbovePrompt (system ui_invalidate; o
//                         ui_render seguinte devolve a árvore). "faz-outro-aviso" troca por outro.
//   ui_attach / ui_detach / ui_render / ui_press -> superfície remota (desktop): o
//                         press no botão de handle 1 (dismiss) tira o cartão; o de
//                         handle 2 (Explique) troca pela explicação.
//   contém "limite"    -> bate no limite de uso como a CLI real: rate_limit_event
//                         rejeitado (five_hour, resetsAt = agora + 60 s, em SEGUNDOS),
//                         assistant isApiErrorMessage com o texto do limite e result
//                         is_error com o mesmo texto.
//   contém "limite-sem-evento" -> o mesmo, sem o rate_limit_event (o horário fica
//                         por conta do que o uso já sabia).
//   contém "limite-so-assistant" -> sem rate_limit_event; só o assistant de erro de
//                         API casa o texto do limite; o result vem is_error com
//                         outro texto (genérico).
//   contém "limite-recuperado" -> sem rate_limit_event; o assistant de erro de API
//                         casa o texto do limite, mas o turno termina bem (result
//                         is_error false, "resposta final").
//   env FAKE_CLAUDE_LIMIT_ON_RESUME_FILE -> só para o ensaio de ponta a ponta: se o
//                         arquivo apontado existe, a mensagem de retomada do Claudinei
//                         ("[Claudinei: resume after usage limit]") bate no limite como
//                         "limite" (a retomada automática que bate de novo).
//   qualquer outro     -> responde "eco: <texto>"
// control_request { subtype: 'interrupt' } -> sempre responde success e emite
// result error_during_execution (replica o comportamento real do claude: a
// sessão segue viva, o turno é abortado com erro).
import readline from 'node:readline'
import { existsSync } from 'node:fs'

// --session-id <id> escolhe o id da conversa, como a CLI real (vale também com --fork-session).
const sessionIdArg = process.argv.indexOf('--session-id')
const sid = (sessionIdArg !== -1 ? process.argv[sessionIdArg + 1] : undefined) ?? process.env.FAKE_SESSION_ID ?? 'fake-session-0001'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// --resume-session-at recebe o `uuid` da entrada do transcript. Com o `msg_…` da
// API a CLI real sai com código 1 antes do init, sem chamar a API (ensaio de 20/11/2026).
const cutArg = process.argv.indexOf('--resume-session-at')
const cut = cutArg !== -1 ? process.argv[cutArg + 1] : undefined
if (cut?.startsWith('msg_')) {
  process.stderr.write(`No message found with message.uuid of: ${cut}\n`)
  process.exit(1)
}

// Pergunta (AskUserQuestion) esperando o control_response do host. Replica a CLI
// real: o turno fica bloqueado até a resposta chegar pelo stdin.
let pendingQuestion = null
// demorada-junto: o próximo interrupt responde e fecha o turno num write só.
let interruptJunto = false

// Cartão do plugin You should know, como o ui_render o devolve a uma superfície desktop.
let aviso = null
const PLUGIN = 'cc-plugin-you-should-know'
const btn = (handle, label, extra = {}) => ({ type: 'Button', props: { key: `b${handle}`, label, ...extra }, press: { plugin: PLUGIN, handle } })
const cartao = (titulo, corpo, botoes) => ({ type: 'Box', props: { flexDirection: 'column', gap: 1 }, children: [
  { type: 'engine', ref: 2 },
  { type: 'Box', props: { flexDirection: 'row' }, children: [{ type: 'Text', props: { bold: true, color: 'warning' }, children: ['Heads up'] }] },
  { type: 'Text', props: { bold: true }, children: [titulo] },
  { type: 'Markdown', props: { text: corpo } },
  { type: 'Box', props: { flexDirection: 'row', gap: 2 }, children: botoes },
  btn(1, 'Dispensar', { role: 'dismiss' }),
] })
const avisoOferta = () => cartao('O lucro de 27% esconde um risco de perda grande',
  '- A posição aberta está em **-19%**.\n- O robô não usa stop.', [btn(2, 'Explique', { variant: 'primary' }), btn(3, 'Já sabia'), btn(4, 'Agora não')])
const avisoOutro = () => cartao('O backup de ontem não rodou', 'O cron parou às 02:00 e ninguém viu.', [btn(5, 'Explique'), btn(6, 'Já sabia')])
const avisoExplicado = () => cartao('O lucro de 27% esconde um risco de perda grande',
  'Explicação curta: somando a posição aberta, a queda real passa de 20%.', [btn(7, 'Entendi', { variant: 'primary' })])
const invalida = () => out({ type: 'system', subtype: 'ui_invalidate', event: 'ui.render', session_id: sid })

// --slash a,b,c injeta a lista de slash_commands no init (testa a captura)
const slashArg = process.argv.indexOf('--slash')
const slash_commands = slashArg !== -1 ? (process.argv[slashArg + 1] ?? '').split(',').filter(Boolean) : []
// pkgExecPath ecoa process.env.PKG_EXECPATH no init: prova de regressão de que
// session.ts spawna com PKG_EXECPATH='' (ver comentário em session.ts) —
// exercitado em session.test.ts.
// --model é ecoado no init como o claude real faz: alimenta a janela de contexto.
const modelArg = process.argv.indexOf('--model')
const model = modelArg !== -1 ? (process.argv[modelArg + 1] ?? 'fake-model') : 'fake-model'
// --init-tardio replica a CLI real retomando uma conversa (--resume em stream-json):
// o init só sai junto da 1ª mensagem, e até lá a sessão fica em 'starting'.
const initTardio = process.argv.includes('--init-tardio')
let initEmitido = false
const emitInit = () => {
  if (initEmitido) return
  initEmitido = true
  out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: process.cwd(), tools: [], slash_commands, pkgExecPath: process.env.PKG_EXECPATH ?? null })
}
if (!initTardio) emitInit()

// O usage como a CLI REAL o reporta (medido na 2.1.274):
//  - em cada mensagem `assistant`: o que entrou NAQUELA requisição = a conversa
//    inteira até ali. É a medição do contexto.
//  - no `result`: a SOMA de todas as requisições do turno. Aqui, três vezes o
//    contexto, para que qualquer código que confunda os dois apareça no teste.
const ctxUsage = () => ({
  input_tokens: 10,
  cache_read_input_tokens: Number(process.env.CLAUDE_FAKE_CTX ?? 100),
  cache_creation_input_tokens: 0,
  output_tokens: 5,
})
const turnUsage = () => {
  const u = ctxUsage()
  return { ...u, input_tokens: u.input_tokens * 3, cache_read_input_tokens: u.cache_read_input_tokens * 3, output_tokens: u.output_tokens * 3 }
}
// modelUsage do result: a CLI informa ali a janela real de cada modelo do turno.
// CLAUDE_FAKE_WINDOW liga a informação (e o haiku auxiliar entra junto, como no
// real, para nenhum código pegar "a maior janela do mapa" por descuido).
const modelUsage = () => process.env.CLAUDE_FAKE_WINDOW
  ? {
      'claude-haiku-4-5-20251001': { contextWindow: 200000, canonicalModel: 'claude-haiku-4-5' },
      [model]: { contextWindow: Number(process.env.CLAUDE_FAKE_WINDOW), canonicalModel: model },
    }
  : undefined

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg?.type === 'user') emitInit()
  // Host respondeu à pergunta (ou a outro can_use_tool) — o turno bloqueado segue.
  // QUALQUER control_response cai neste bloco e retorna: sem isto, uma resposta
  // que não bate com `pendingQuestion` (ex.: o deny automático da 2ª pergunta em
  // faz-duas-perguntas) escorregava para o fallback de texto lá embaixo e virava
  // um eco/result espúrio, fechando um turno que devia continuar aberto.
  if (msg?.type === 'control_response') {
    if (pendingQuestion && msg.response?.request_id === pendingQuestion.request_id) {
      const r = msg.response?.response ?? {}
      const p = pendingQuestion; pendingQuestion = null
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
        out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: eco }], usage: ctxUsage() } })
        out({ type: 'result', subtype: 'success', is_error: false, result: eco, session_id: sid, num_turns: 1, total_cost_usd: 0, usage: turnUsage() })
      } else {
        const eco = `eco: negado ${r.message ?? ''}`.trim()
        out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, content: r.message ?? 'rejected', is_error: true }] } })
        out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: eco }], usage: ctxUsage() } })
        out({ type: 'result', subtype: 'success', is_error: false, result: eco, session_id: sid, num_turns: 1, total_cost_usd: 0, usage: turnUsage() })
      }
      return
    }
    if (msg.response?.request_id === 'q-req-1b') {
      // faz-duas-perguntas: deny AUTOMÁTICO que o host manda pra 2ª pergunta (o
      // fix nega sozinho, sem esperar o cliente). Só eco — ponto de sincronização
      // pro teste — o turno segue aberto esperando a resposta real da 1ª.
      const msg2 = msg.response?.response?.message ?? ''
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: `eco: segunda-negada ${msg2}`.trim() }] } })
      return
    }
    return // control_response que não bate com nada conhecido: ignora, nunca vira eco/result
  }
  if (msg?.type === 'control_request') {
    const r = msg.request ?? {}
    if (r.subtype === 'interrupt') {
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
      const resposta = { type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }
      const fim = { type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 }
      if (interruptJunto) {
        interruptJunto = false
        process.stdout.write(JSON.stringify(resposta) + '\n' + JSON.stringify(fim) + '\n')
        return
      }
      out(resposta)
      out(fim)
      return
    }
    if (r.subtype === 'claude_authenticate') {
      // Como a CLI real: devolve as duas URLs do fluxo OAuth.
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {
        manualUrl: 'https://claude.ai/oauth/authorize?manual=1',
        automaticUrl: 'https://claude.ai/oauth/authorize?auto=1',
      } } })
      return
    }
    if (r.subtype === 'claude_oauth_callback') {
      // Código inválido é recusado, como no fluxo real.
      if (String(r.manualUrl ?? '').includes('ruim')) {
        out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'código inválido' } })
        return
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { ok: true } } })
      return
    }
    if (r.subtype === 'stop_task') {
      if (r.task_id === 'stop-fails') {
        out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'task não parou' } })
        return
      }
      // Como a CLI real: confirma e anuncia que a task saiu.
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
      out({ type: 'system', subtype: 'task_updated', task_id: r.task_id, patch: { status: 'completed' } })
      return
    }
    if (r.subtype === 'ui_attach') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { surfaces: [r.surface] } } }); return }
    if (r.subtype === 'ui_detach') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { wasAttached: true, surfaces: [] } } }); return }
    if (r.subtype === 'ui_render') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {
        tree: aviso ?? { type: 'engine', ref: 2 }, props: r.props ?? {}, rewritten: false, hooked: true, drawn_by: aviso ? [PLUGIN] : [] } } })
      return
    }
    if (r.subtype === 'ui_press') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { handled: true } } })
      if (r.handle === 2) aviso = avisoExplicado()
      else aviso = null
      invalida()
      return
    }
    if (r.mode === 'timeout-test') return            // simula não-resposta (testa timeout)
    if (r.mode === 'fail-test') { out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'modo inválido' } }); return }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: r.mode ? { mode: r.mode } : {} } })
    return
  }
  const text = msg?.message?.content?.[0]?.text ?? ''
  if (text.includes('crash')) process.exit(1)
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
  if (text.includes('faz-duas-perguntas')) {
    // Regressão (Important 2 do review final): a CLI manda um 2º can_use_tool
    // antes de qualquer control_response para o 1º — nunca medido no CLI real,
    // mas o protocolo não impede, e o host precisa negar o 2º na hora em vez de
    // sobrescrever a pendência (que deixaria o 1º request_id sem resposta pra
    // sempre). Sufixo "b" só para diferenciar id/request nos asserts.
    const questions = [
      { question: 'Prossegue?', header: 'Confirma', multiSelect: false,
        options: [{ label: 'Sim', description: 'Sim' }, { label: 'Não', description: 'Não' }] },
    ]
    pendingQuestion = { request_id: 'q-req-1', tool_use_id: 'toolu_q_1', questions }
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q_1', name: 'AskUserQuestion', input: { questions } }] } })
    out({ type: 'control_request', request_id: 'q-req-1', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      input: { questions }, tool_use_id: 'toolu_q_1', requires_user_interaction: true } })
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q_1b', name: 'AskUserQuestion', input: { questions } }] } })
    out({ type: 'control_request', request_id: 'q-req-1b', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      input: { questions }, tool_use_id: 'toolu_q_1b', requires_user_interaction: true } })
    return
  }
  if (text.includes('pergunta-abandonada')) {
    // Regressão (Important 3 do review final): defensivo, sem gatilho medido —
    // simula a CLI fechando o turno com `result` antes do control_response da
    // AskUserQuestion (aborto/erro não catalogado). A pendência não pode ficar
    // presa esperando uma resposta que nunca vai chegar.
    const questions = [
      { question: 'Confirma?', header: 'Confirma', multiSelect: false,
        options: [{ label: 'Sim', description: 'Sim' }, { label: 'Não', description: 'Não' }] },
    ]
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q_ab', name: 'AskUserQuestion', input: { questions } }] } })
    out({ type: 'control_request', request_id: 'q-req-ab', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
      input: { questions }, tool_use_id: 'toolu_q_ab', requires_user_interaction: true } })
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 })
    return
  }
  if (text.includes('turno-com-erro')) {
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'tentando…' }], usage: ctxUsage() } })
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 })
    return
  }
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
  if (text.includes('compact-real')) {
    // Ordem EMPÍRICA (capturada da CLI real): a fronteira chega ANTES do result,
    // e o result da compactação vem com usage tudo zero — nenhuma medição nova.
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sid })
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 24333, post_tokens: 2524 } })
    out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'text', text: 'resumo da conversa' }], isCompactSummary: true } })
    out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sid, num_turns: 0, total_cost_usd: 0,
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } })
    return
  }
  if (text.includes('com-bg')) {
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', description: 'servidor de preview' }] })
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'trabalhando…' }] } })
    return
  }
  // Conversa longa para medir o peso do chat: `rajada <ciclos> <ms>` manda, por
  // ciclo, um texto em Markdown, uma chamada de ferramenta e o resultado dela,
  // espaçados de <ms> (0 = de uma vez); o result fecha o turno.
  const rajada = text.match(/rajada (\d+)(?: (\d+))?/)
  if (rajada) {
    const ciclos = Number(rajada[1]); const ms = Number(rajada[2] ?? 0)
    let n = 0
    const ciclo = () => {
      const id = `toolu_r_${Date.now()}_${n}`
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: `Passo **${n}**: conferindo \`src/arquivo-${n}.ts\` e seguindo.\n\n- item um\n- item dois com \`código\`` }], usage: ctxUsage() } })
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: n % 2 ? 'Read' : 'Bash', input: n % 2 ? { file_path: `/tmp/x/arquivo-${n}.ts` } : { command: `grep -rn coisa src/ | head -${n}` } }] } })
      out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `linha 1 do resultado ${n}\nlinha 2\nlinha 3` }] } })
      n++
      if (n < ciclos) { if (ms) setTimeout(ciclo, ms); else ciclo() }
      else out({ type: 'result', subtype: 'success', is_error: false, result: 'fim', session_id: sid, num_turns: 1, total_cost_usd: 0, usage: turnUsage(), modelUsage: modelUsage() })
    }
    ciclo()
    return
  }
  const limiteNaRetomada = !!process.env.FAKE_CLAUDE_LIMIT_ON_RESUME_FILE
    && text.includes('[Claudinei: resume after usage limit]')
    && existsSync(process.env.FAKE_CLAUDE_LIMIT_ON_RESUME_FILE)
  if (text.includes('limite') || limiteNaRetomada) {
    const LIMIT_TEXT = "You've hit your session limit · resets 3:40pm (America/Sao_Paulo)"
    if (text.includes('limite-so-assistant') || text.includes('limite-recuperado')) {
      const ok = text.includes('limite-recuperado')
      out({ type: 'assistant', session_id: sid, isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
        message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] } })
      out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok,
        result: ok ? 'resposta final' : 'API Error: falha genérica', session_id: sid, num_turns: 1, total_cost_usd: 0 })
      return
    }
    if (!text.includes('limite-sem-evento')) {
      out({ type: 'rate_limit_event', session_id: sid, rate_limit_info: {
        status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 60, utilization: 1 } })
    }
    out({ type: 'assistant', session_id: sid, isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
      message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] } })
    out({ type: 'result', subtype: 'success', is_error: true, result: LIMIT_TEXT, session_id: sid, num_turns: 1, total_cost_usd: 0 })
    return
  }
  if (text.includes('demorada')) {
    // turno fica aberto: responde assistant mas NUNCA emite result (até um interrupt)
    interruptJunto = text.includes('demorada-junto')
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'trabalhando…' }] } })
    return
  }
  const respond = () => {
    if (text.includes('com-subagente')) {
      // Ordem real: a mensagem do subagente chega DEPOIS da do turno principal,
      // marcada com parent_tool_use_id, e com a conversa dele (menor) no usage.
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'delegando' }], usage: ctxUsage() } })
      out({ type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_task_1', message: { role: 'assistant', content: [{ type: 'text', text: 'subagente' }], usage: { input_tokens: 1, cache_read_input_tokens: 899, cache_creation_input_tokens: 0, output_tokens: 2 } } })
      out({ type: 'result', subtype: 'success', is_error: false, result: `eco: ${text}`, session_id: sid, num_turns: 1, total_cost_usd: 0, usage: turnUsage(), modelUsage: modelUsage() })
      return
    }
    if (text.includes('use-tool')) {
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake_1', name: 'Bash', input: { command: 'echo oi' } }] } })
      out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: 'oi' }] } })
    }
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${text}` }], usage: ctxUsage() } })
    out({
      type: 'result', subtype: 'success', is_error: false, result: `eco: ${text}`, session_id: sid, num_turns: 1, total_cost_usd: 0,
      usage: turnUsage(), modelUsage: modelUsage(),
    })
  }
  if (text.includes('devagar')) setTimeout(respond, 300)
  else respond()
  if (text.includes('faz-outro-aviso')) { aviso = avisoOutro(); invalida() }
  else if (text.includes('faz-aviso')) { aviso = avisoOferta(); invalida() }
})
rl.on('close', () => process.exit(0))
