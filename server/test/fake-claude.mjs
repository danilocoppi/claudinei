#!/usr/bin/env node
// Fala o protocolo stream-json do claude para testes offline.
// Comportamentos por conteúdo da mensagem:
//   contém "use-tool"  -> emite tool_use + tool_result antes do texto
//   contém "crash"     -> encerra com exit 1 sem result (simula morte)
//   contém "devagar"   -> espera 300ms antes de responder (testa timeout)
//   contém "demorada"  -> responde assistant mas NUNCA emite result (turno só fecha com interrupt)
//   qualquer outro     -> responde "eco: <texto>"
// control_request { subtype: 'interrupt' } -> sempre responde success e emite
// result error_during_execution (replica o comportamento real do claude: a
// sessão segue viva, o turno é abortado com erro).
import readline from 'node:readline'

const sid = process.env.FAKE_SESSION_ID ?? 'fake-session-0001'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// --slash a,b,c injeta a lista de slash_commands no init (testa a captura)
const slashArg = process.argv.indexOf('--slash')
const slash_commands = slashArg !== -1 ? (process.argv[slashArg + 1] ?? '').split(',').filter(Boolean) : []
// pkgExecPath ecoa process.env.PKG_EXECPATH no init: prova de regressão de que
// session.ts spawna com PKG_EXECPATH='' (ver comentário em session.ts) —
// exercitado em session.test.ts.
out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model', cwd: process.cwd(), tools: [], slash_commands, pkgExecPath: process.env.PKG_EXECPATH ?? null })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg?.type === 'control_request') {
    const r = msg.request ?? {}
    if (r.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 })
      return
    }
    if (r.mode === 'timeout-test') return            // simula não-resposta (testa timeout)
    if (r.mode === 'fail-test') { out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'modo inválido' } }); return }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: r.mode ? { mode: r.mode } : {} } })
    return
  }
  const text = msg?.message?.content?.[0]?.text ?? ''
  if (text.includes('crash')) process.exit(1)
  if (text.includes('demorada')) {
    // turno fica aberto: responde assistant mas NUNCA emite result (até um interrupt)
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'trabalhando…' }] } })
    return
  }
  const respond = () => {
    if (text.includes('use-tool')) {
      out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake_1', name: 'Bash', input: { command: 'echo oi' } }] } })
      out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: 'oi' }] } })
    }
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${text}` }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: `eco: ${text}`, session_id: sid, num_turns: 1, total_cost_usd: 0 })
  }
  if (text.includes('devagar')) setTimeout(respond, 300)
  else respond()
})
rl.on('close', () => process.exit(0))
