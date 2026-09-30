#!/usr/bin/env node
// CLI do Codex falsa, só para a ajuda que o Claudinei consulta antes de abrir o
// terminal. Por padrão imita a CLI atual, que roda sem o daemon compartilhado
// com `--no-daemon`; FAKE_CODEX_CLI_ANTIGA=1 imita uma CLI anterior à opção.
const args = process.argv.slice(2)
if (!args.includes('--help')) process.exit(2)
const antiga = process.env.FAKE_CODEX_CLI_ANTIGA === '1'
process.stdout.write([
  `Usage: codex ${args[0] === 'resume' ? 'resume [OPTIONS] [SESSION_ID]' : '[OPTIONS] [PROMPT]'}`,
  '',
  'Options:',
  '      --dangerously-bypass-approvals-and-sandbox',
  ...(antiga ? [] : [
    '      --no-daemon',
    '          Run without the shared background server, even if it is already running',
  ]),
  '  -h, --help',
  '',
].join('\n'))
