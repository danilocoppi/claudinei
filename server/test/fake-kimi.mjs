#!/usr/bin/env node
// Fake do `kimi -p ... --output-format stream-json` para testes: emite o
// formato de chat da CLI real (assistant/tool_calls/tool/meta) e sai.
// O prompt vem como VALOR de -p (argv), como na CLI de verdade.
const args = process.argv.slice(2)
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const prompt = at('-p') ?? ''
const resumed = at('-r')
const sessionId = resumed ?? 'session_FAKE'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

if (process.env.KIMI_FAKE_HANG === '1') {
  // Turno travado: só morre por sinal (exercita interrupt/stop).
  setInterval(() => {}, 1000)
} else if (process.env.KIMI_FAKE_CRASH === '1') {
  process.stderr.write('kimi: boom\n')
  process.exit(3)
} else {
  if (process.env.KIMI_FAKE_TOOL === '1') {
    out({ role: 'assistant', tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] })
    out({ role: 'tool', tool_call_id: 'tool_1', content: 'alvo.txt\n' })
  }
  if (process.env.KIMI_FAKE_ECHO_HOME === '1') out({ role: 'assistant', content: `home:${process.env.KIMI_CODE_HOME}` })
  out({ role: 'assistant', content: `echo:${prompt}` })
  // A CLI real anuncia o id da conversa só no FIM do turno.
  out({ role: 'meta', type: 'session.resume_hint', session_id: sessionId, command: `kimi -r ${sessionId}`, content: 'To resume…' })
  if (process.env.KIMI_FAKE_HANG_AFTER_TURN === '1') {
    // O bug real da CLI: o turno TERMINA (resume_hint emitido, turn.ended no
    // wire) mas o processo não encerra — fica ocioso em ep_poll até ser morto.
    setInterval(() => {}, 1000)
  } else {
    process.exit(0)
  }
}
