import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const mode = process.argv[2]
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
if (mode === 'hang') {
  writeFileSync(process.argv[3], String(process.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
let initialized = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (mode === 'hang') return
  if (msg.method === 'initialize') {
    out(mode === 'init-error' ? { id: msg.id, error: { message: 'unavailable' } } : { id: msg.id, result: {} })
  } else if (msg.method === 'initialized') {
    initialized = true
  } else if (!initialized) {
    out({ id: msg.id, error: { message: 'not initialized' } })
  } else if (msg.method === 'model/list') {
    // Ruído e uma notificação não podem ser confundidos com respostas.
    process.stdout.write('not json\nnull\n')
    out({ method: 'account/updated', params: {} })
    const second = !!msg.params.cursor
    out({ id: msg.id, result: {
      data: [{ model: second ? 'second' : 'first' }], nextCursor: second ? null : 'page-2',
    } })
  } else if (msg.method === 'account/rateLimits/read') {
    out(mode === 'no-limits'
      ? { id: msg.id, error: { message: 'ChatGPT login required' } }
      : { id: msg.id, result: { rateLimits: { limitId: 'codex' }, accountId: 'private-account', rateLimitResetCredits: { credits: ['private'] } } })
  } else if (msg.method === 'config/read') {
    out({ id: msg.id, result: { config: { model: 'second', private_config: 'must not escape' } } })
  } else {
    throw new Error(`unexpected method: ${msg.method}`)
  }
})
