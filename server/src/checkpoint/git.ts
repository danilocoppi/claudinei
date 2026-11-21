import { spawn } from 'node:child_process'

/**
 * Git sem efeitos colaterais no repositório do operador.
 *
 * Todo git do retrato passa por aqui. O ambiente é montado do zero a partir do
 * process.env, sem nada que redirecione o git para outro repositório, índice ou
 * base de objetos (o servidor pode ter subido de dentro de um hook ou de um
 * terminal com GIT_DIR definido), e com os valores fixos das regras do desfazer:
 * sem locks opcionais, sem prompt de credencial, mensagens em C e autor e
 * committer Claudinei.
 */

export class GitError extends Error {
  code: number
  stderr: string
  args: string[]
  constructor(args: string[], code: number, stderr: string, detail?: string) {
    super(`git ${args.join(' ')} falhou (${code}): ${(detail ?? stderr).trim()}`)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
    this.args = args
  }
}

export interface GitResult { code: number; stdout: Buffer; stderr: string }

export interface GitOptions {
  /** Índice a usar no lugar do do operador (vira GIT_INDEX_FILE). */
  indexFile?: string
  /** Conteúdo do stdin. Sem ele o stdin chega fechado. */
  input?: string | Buffer
  /** Código ≠ 0 resolve em vez de rejeitar. Falha de execução continua rejeitando. */
  allowFail?: boolean
  /** Teto do stdout e do stderr, em bytes. Passou, o git é morto e vira GitError. */
  maxBuffer?: number
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

// Herdadas do processo, apontariam o git para outro repositório, índice,
// objetos ou refs, ou mudariam a leitura de pathspecs e da config.
const SCRUBBED = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_INTERNAL_SUPER_PREFIX',
])

// Fixas em todo git do Claudinei (Global Constraints).
const FIXED_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'Claudinei',
  GIT_AUTHOR_EMAIL: 'claudinei@localhost',
  GIT_COMMITTER_NAME: 'Claudinei',
  GIT_COMMITTER_EMAIL: 'claudinei@localhost',
}

function gitEnv(indexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (SCRUBBED.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) continue
    env[name] = value
  }
  Object.assign(env, FIXED_ENV)
  if (indexFile) env.GIT_INDEX_FILE = indexFile
  return env
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const max = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: GitError): void => { if (!settled) { settled = true; reject(err) } }
    const child = spawn('git', args, { cwd, env: gitEnv(opts.indexFile), stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let overflow = false
    const tooBig = (): void => {
      if (overflow) return
      overflow = true
      child.kill('SIGKILL')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > max) tooBig(); else out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > max) tooBig(); else err.push(chunk)
    })
    // Spawn que falha (git ausente, pasta inexistente) não tem código de saída.
    child.on('error', e => fail(new GitError(args, -1, '', e.message)))
    child.on('close', (code, signal) => {
      if (settled) return
      const stderr = Buffer.concat(err).toString('utf8')
      if (overflow) return fail(new GitError(args, -1, stderr, `saída acima de ${max} bytes`))
      // Morto por sinal: sem código, tratado como falha (-1).
      const exit = code ?? -1
      if (exit !== 0 && !opts.allowFail) {
        return fail(new GitError(args, exit, stderr, signal ? `${signal}: ${stderr}` : undefined))
      }
      settled = true
      resolve({ code: exit, stdout: Buffer.concat(out), stderr })
    })
    // O git pode sair antes de ler o stdin todo (EPIPE); o código de saída já diz o que houve.
    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Saída com `-z` → lista de nomes, sem o vazio que sobra depois do último NUL. */
export function splitZ(buf: Buffer): string[] {
  if (buf.length === 0) return []
  const parts = buf.toString('utf8').split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}
