#!/usr/bin/env node
// Fake do `opencode run` para testes: emite o protocolo v e sai. Lê o prompt do
// último argv (após '--'); no resume o session id é o valor após '-s'.
import process from 'node:process'
const args = process.argv.slice(2)
const isResume = args.includes('-s')
const sid = isResume ? args[args.indexOf('-s') + 1] : 'ses_FAKE'
const dashdash = args.lastIndexOf('--')
const prompt = dashdash >= 0 ? args.slice(dashdash + 1).join(' ') : ''
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
if (process.env.OPENCODE_FAKE_HANG === '1') {
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  setInterval(() => {}, 1000) // trava até ser morto
} else if (process.env.OPENCODE_FAKE_CRASH === '1') {
  // Crash real: sai com código != 0 sem emitir text/step_finish/error — não deve
  // virar "turno vazio bem-sucedido".
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  process.exit(1)
} else if (process.env.OPENCODE_FAKE_ERROR === '1') {
  // Erro EXPLÍCITO no stream (ex.: rate limit) + exit != 0: a mensagem real do
  // parser deve ser preservada, não trocada pela genérica.
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  out({ type: 'error', sessionID: sid, error: { data: { message: 'rate limit exceeded: retry after 30s' } } })
  process.exit(1)
} else {
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  out({ type: 'text', sessionID: sid, part: { type: 'text', text: `echo:${prompt}` } })
  // Sinaliza se o MCP hermes foi injetado via OPENCODE_CONFIG_CONTENT (o app usa isso
  // para a colaboração entre agentes). Permite ao teste verificar a injeção end-to-end.
  const cfg = process.env.OPENCODE_CONFIG_CONTENT
  if (cfg && cfg.includes('hermes')) {
    out({ type: 'text', sessionID: sid, part: { type: 'text', text: 'hermes:on' } })
  }
  out({ type: 'step_finish', sessionID: sid, tokens: { total: 5, input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
  process.exit(0)
}
