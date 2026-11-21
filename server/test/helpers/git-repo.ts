import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Variáveis que redirecionam o git para outro repositório ou índice. Quem roda
// os testes pode estar dentro de um hook do git ou de um terminal com GIT_DIR
// definido; nenhuma delas pode vazar para os repositórios temporários.
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of REDIRECTING) delete env[name]
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
}

/** Roda o git numa pasta de teste e devolve o stdout. Nunca use com o worktree do projeto. */
export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Pasta temporária vazia (sem git), para casos fora de repositório. */
export function makeTempDir(prefix = 'claudinei-tmp-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Cria um repositório temporário em os.tmpdir() com commit inicial. A config é
 * local (user.*, commit.gpgsign=false e hooks desligados), para não depender da
 * config global de quem roda os testes.
 */
export function makeRepo(files: Record<string, string> = { 'README.md': '# teste\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'claudinei-git-'))
  const run = (...args: string[]): string => runGit(dir, ...args)
  const write = (rel: string, body: string | Buffer): void => {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Teste')
  run('config', 'user.email', 'teste@localhost')
  run('config', 'commit.gpgsign', 'false')
  run('config', 'core.hooksPath', '/dev/null')
  const paths = Object.keys(files)
  for (const rel of paths) write(rel, files[rel])
  if (paths.length) run('add', '--', ...paths)
  run('commit', '-q', '--allow-empty', '-m', 'inicial')
  return { dir, run, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
