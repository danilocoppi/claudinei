import { spawn } from 'node:child_process'

/**
 * Git sem efeitos colaterais no repositório do operador.
 *
 * Todo git do retrato passa por aqui. O ambiente é montado do zero a partir do
 * process.env, sem nada que redirecione o git para outro repositório, índice ou
 * base de objetos (o servidor pode ter subido de dentro de um hook ou de um
 * terminal com GIT_DIR definido), e com os valores fixos das regras do desfazer:
 * sem locks opcionais, sem prompt de credencial, mensagens em C, pathspecs
 * literais (um arquivo chamado `*.txt` ou `:(x)` é só um nome) e autor e
 * committer Claudinei. GIT_CEILING_DIRECTORIES passa: é um limite que o
 * operador pôs na busca do repositório, não um redirecionamento.
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

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
  /** Com `truncate`: o stdout foi cortado e o git, morto antes de terminar. */
  truncated?: boolean
}

export interface GitOptions {
  /** Índice a usar no lugar do do operador (vira GIT_INDEX_FILE). */
  indexFile?: string
  /** Conteúdo do stdin. Sem ele o stdin chega fechado. */
  input?: string | Buffer
  /** Código ≠ 0 resolve em vez de rejeitar. Falha de execução continua rejeitando. */
  allowFail?: boolean
  /** Teto do stdout e do stderr, em bytes. Passou, o git é morto e vira GitError. */
  maxBuffer?: number
  /**
   * Corta o stdout em vez de falhar: passou de `maxLines` linhas ou de
   * `maxBuffer` bytes, o git (e o grupo dele) é morto e o resultado vem com
   * `truncated: true` e só as linhas inteiras lidas até ali. O código de saída,
   * nesse caso, não conta. O stderr acima do teto continua sendo GitError.
   */
  truncate?: { maxLines?: number }
  /** Tempo máximo, em ms. Passou, o git (e o que ele abriu) é morto e vira GitError. */
  timeoutMs?: number
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
// Depois do SIGTERM (que deixa o git apagar os próprios .lock), quanto esperar até o SIGKILL.
const KILL_GRACE_MS = 2_000

// Herdadas do processo, apontariam o git para outro repositório, índice,
// objetos ou refs, ou mudariam a leitura de pathspecs e da config.
const SCRUBBED = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  // Incompatíveis com o GIT_LITERAL_PATHSPECS fixo (o git recusa a combinação).
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_INTERNAL_SUPER_PREFIX',
])

// Fixas em todo git do Claudinei (Global Constraints).
const FIXED_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  GIT_LITERAL_PATHSPECS: '1',
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const done = (): void => {
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
    }
    const fail = (err: GitError): void => { if (!settled) { done(); reject(err) } }
    // Grupo de processos próprio: no tempo esgotado morre também o que o git
    // abriu (alias, hook do fsmonitor), que senão seguraria os pipes abertos.
    const child = spawn('git', args, { cwd, env: gitEnv(opts.indexFile), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch { /* já saiu */ }
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timeoutError = (): GitError => new GitError(args, -1, Buffer.concat(err).toString('utf8'), `tempo esgotado (${timeoutMs} ms)`)
    timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => {
        killGroup('SIGKILL')
        fail(timeoutError())
      }, KILL_GRACE_MS)
    }, timeoutMs)
    let outBytes = 0
    let errBytes = 0
    let overflow = false
    const tooBig = (): void => {
      if (overflow) return
      overflow = true
      killGroup('SIGKILL')
    }
    // Modo truncate: linhas inteiras já guardadas e se o corte aconteceu.
    let lines = 0
    let cut = false
    const cutHere = (): void => {
      if (cut) return
      cut = true
      killGroup('SIGKILL')
    }
    const maxLines = opts.truncate?.maxLines
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow || cut) return
      if (!opts.truncate) {
        outBytes += chunk.length
        if (outBytes > max) tooBig(); else out.push(chunk)
        return
      }
      let take = Math.min(chunk.length, max - outBytes)
      if (maxLines !== undefined) {
        // Já há maxLines linhas inteiras: qualquer byte a mais é corte.
        let pos = -1
        while (lines < maxLines) {
          pos = chunk.indexOf(10, pos + 1)
          if (pos < 0 || pos >= take) break
          lines++
        }
        if (lines >= maxLines) take = pos + 1
      }
      out.push(chunk.subarray(0, take))
      outBytes += take
      if (take < chunk.length) cutHere()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > max) tooBig(); else err.push(chunk)
    })
    // Spawn que falha (git ausente, pasta inexistente) não tem código de saída.
    child.on('error', e => fail(new GitError(args, -1, '', e.message)))
    // No tempo esgotado não espera o 'close': um neto fora do grupo pode
    // segurar os pipes; basta o git ter saído.
    child.on('exit', () => {
      if (!timedOut) return
      // O git já apagou os .lock dele; o que sobrou no grupo morre agora.
      killGroup('SIGKILL')
      fail(timeoutError())
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (timedOut) return fail(timeoutError())
      const stderr = Buffer.concat(err).toString('utf8')
      if (overflow) return fail(new GitError(args, -1, stderr, `saída acima de ${max} bytes`))
      if (cut) {
        // Morto no meio de uma linha: fica só até o último fim de linha.
        const all = Buffer.concat(out)
        done()
        return resolve({ code: code ?? -1, stdout: all.subarray(0, all.lastIndexOf(10) + 1), stderr, truncated: true })
      }
      // Morto por sinal: sem código, tratado como falha (-1).
      const exit = code ?? -1
      if (exit !== 0 && !opts.allowFail) {
        return fail(new GitError(args, exit, stderr, signal ? `${signal}: ${stderr}` : undefined))
      }
      done()
      resolve({ code: exit, stdout: Buffer.concat(out), stderr, ...(opts.truncate ? { truncated: false } : {}) })
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
