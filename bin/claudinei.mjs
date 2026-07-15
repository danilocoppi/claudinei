#!/usr/bin/env node
// Comando único: garante o web/dist e o Parakeet, então sobe o servidor.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

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

// sobe o servidor via tsx, repassando as flags (--host/--port/--insecure)
const child = spawn('npx', ['tsx', join(root, 'server', 'src', 'index.ts'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
