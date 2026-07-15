#!/usr/bin/env node
// Fake do `codex exec`/`exec resume` para testes: emite o protocolo v2 e sai.
// Uso: node fake-codex.mjs <exec|resume> [threadId] ... -   (prompt via stdin)
import { stdin } from 'node:process'
const args = process.argv.slice(2)
const isResume = args.includes('resume')
const threadId = isResume ? (args[args.indexOf('resume') + 1] || 'THREAD-FAKE') : 'THREAD-FAKE'
let prompt = ''
stdin.setEncoding('utf8')
stdin.on('data', (d) => { prompt += d })
stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  if (!isResume) out({ type: 'thread.started', thread_id: threadId })
  out({ type: 'turn.started' })
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: `echo:${prompt.trim()}` } })
  if (process.env.CODEX_FAKE_HANG === '1') {
    // Simula um turno travado: não emite turn.completed nem sai sozinho.
    // Fica vivo até receber um sinal (SIGTERM/SIGKILL) do processo pai.
    setInterval(() => {}, 1000)
    return
  }
  out({ type: 'turn.completed', usage: { output_tokens: 1 } })
  process.exit(0)
})
