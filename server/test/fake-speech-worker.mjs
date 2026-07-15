// Worker falso para testes: mesmo protocolo do worker real, sem sherpa.
// wav contendo "ERRO" → responde erro; contendo "MORRE" → sai sem responder;
// contendo "PENDURA" → não responde nada (nem sai) — simula requisição que nunca volta;
// contendo "ENV" → ecoa process.env.PKG_EXECPATH (regressão: prova que
// transcriber.ts spawna o worker com PKG_EXECPATH='' — ver comentário lá e
// speech.test.ts).
// arg `--ready-flag <path>`: só emite "ready" se o arquivo existir — simula boot lento.
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'

const flagIdx = process.argv.indexOf('--ready-flag')
const readyFlag = flagIdx >= 0 ? process.argv[flagIdx + 1] : null
if (!readyFlag || existsSync(readyFlag)) {
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n')
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.wav.includes('MORRE')) process.exit(1)
  if (req.wav.includes('PENDURA')) return
  if (req.wav.includes('ENV')) {
    process.stdout.write(JSON.stringify({ id: req.id, text: `pkgExecPath:${process.env.PKG_EXECPATH}` }) + '\n')
    return
  }
  if (req.wav.includes('ERRO')) {
    process.stdout.write(JSON.stringify({ id: req.id, error: 'falha proposital' }) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ id: req.id, text: `transcrito:${req.wav}` }) + '\n')
})
