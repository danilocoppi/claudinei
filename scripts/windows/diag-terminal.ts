// Sonda de diagnóstico: roda no MESMO ambiente do serviço (tarefa agendada →
// powershell → cmd → node) e mostra por que o terminal resolve — ou não — o
// binário da engine. Uso:
//   node node_modules\tsx\dist\cli.mjs scripts\windows\diag-terminal.ts
import { resolveBin, binAvailable } from '../../server/src/engine/available.js'

const chaves = Object.keys(process.env).filter((k) => /^path(ext)?$/i.test(k))
console.log('casing real das variáveis:', JSON.stringify(chaves))
console.log('process.env.PATH definido? ', process.env.PATH !== undefined)

// exatamente o que a fábrica do PTY monta e passa adiante
const envDoPty = { ...process.env } as NodeJS.ProcessEnv
console.log('objeto espalhado .PATH definido?', envDoPty.PATH !== undefined)

for (const bin of ['claude', 'codex', 'kimi']) {
  console.log(
    `${bin.padEnd(8)} binAvailable=${binAvailable(bin)}`,
    `| resolveBin(process.env)=${resolveBin(bin)}`,
    `| resolveBin(env do pty)=${resolveBin(bin, envDoPty)}`,
  )
}
