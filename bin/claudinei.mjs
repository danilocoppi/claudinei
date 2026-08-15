#!/usr/bin/env node
// Comando único: garante o web/dist e o Parakeet, então sobe o servidor.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDist = join(root, 'web', 'dist')
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('web/dist não encontrado. Rode primeiro:  npm run build -w web')
  process.exit(1)
}

// first-run do Parakeet (modelo em ~/.claudinei/speech). Falha de rede não impede subir.
const speechDir = process.env.CLAUDINEI_SPEECH ?? join(homedir(), '.claudinei', 'speech')
const model = join(speechDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'tokens.txt')
if (!existsSync(model)) {
  console.log('⬇ preparando a transcrição de voz (Parakeet, ~630MB — só desta vez)…')
  const r = spawnSync(process.execPath, [join(root, 'server', 'scripts', 'setup-speech.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) console.warn('⚠ setup de voz falhou (sem rede?). O app sobe; o 🎤 avisa se faltar o modelo.')
}

// Sobe o servidor NO PRÓPRIO processo: registra o loader do tsx em runtime e
// importa o entry TypeScript. As flags (--host/--port/--insecure) chegam nele
// pelo process.argv, que o parseCliArgs lê com slice(2) — igual ao spawn antigo.
//
// Um processo só, de propósito: `npx` no Windows é um .cmd (spawn sem shell dá
// ENOENT) e, pior, um servidor neto sobrevivia órfão quando algo matava o
// wrapper (serviço/tarefa agendada parando) e segurava a porta 9105.
process.chdir(root)
let register
try {
  ;({ register } = await import('tsx/esm/api'))
} catch (err) {
  console.error(`não consegui carregar o tsx: ${err.message}. Rodou 'npm install' na raiz?`)
  process.exit(1)
}
register()
await import(pathToFileURL(join(root, 'server', 'src', 'index.ts')).href)
