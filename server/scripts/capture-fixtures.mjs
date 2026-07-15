#!/usr/bin/env node
// Regenera fixtures do protocolo stream-json usando o binário claude REAL.
// Uso: node scripts/capture-fixtures.mjs   (custa alguns centavos de API)
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = mkdtempSync(join(tmpdir(), 'claudinei-fixture-'))
const proc = spawn(
  'claude',
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
   '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'haiku'],
  { cwd },
)

let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => process.stderr.write(d))

proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Rode `echo oi` com a ferramenta Bash e depois responda exatamente: OK' }] },
}) + '\n')
proc.stdin.end()

proc.on('exit', (code) => {
  const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'stream-real.jsonl')
  writeFileSync(dest, out)
  console.log(`exit=${code}, ${out.trim().split('\n').length} eventos gravados em ${dest}`)
})
