import { afterEach, describe, expect, it, vi } from 'vitest'
import { realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GitError, git, splitZ } from '../src/checkpoint/git.js'
import { createRepoResolver, repoKeyOf, resolveRepo } from '../src/checkpoint/repo.js'
import { makeRepo, makeTempDir, runGit } from './helpers/git-repo.js'

const cleanups: (() => void)[] = []
const savedEnv = { ...process.env }
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  // Restaura as variáveis que algum teste tenha definido.
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]
  Object.assign(process.env, savedEnv)
  vi.restoreAllMocks()
})

function repo(files?: Record<string, string>) {
  const r = makeRepo(files)
  cleanups.push(r.cleanup)
  return r
}
function tempDir(): string {
  const d = makeTempDir()
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

describe('resolveRepo', () => {
  it('subpasta do repo resolve para o mesmo topo e a mesma chave', async () => {
    const r = repo({ 'a/b/c.txt': 'x\n' })
    const fromSub = await resolveRepo(join(r.dir, 'a', 'b'))
    const fromTop = await resolveRepo(r.dir)
    const top = realpathSync(r.dir)
    expect(fromSub).toEqual({ top, gitDir: join(top, '.git'), commonDir: join(top, '.git'), key: repoKeyOf(top) })
    expect(fromTop).toEqual(fromSub)
    expect(fromSub!.key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('pasta sem git devolve null', async () => {
    expect(await resolveRepo(tempDir())).toBeNull()
    expect(await resolveRepo(join(tempDir(), 'nao-existe'))).toBeNull()
  })

  it('repo bare devolve null', async () => {
    const bare = tempDir()
    runGit(bare, 'init', '-q', '--bare')
    expect(await resolveRepo(bare)).toBeNull()
  })

  it('worktree ligado tem chave e gitDir próprios e o mesmo commonDir', async () => {
    const r = repo()
    const wt = join(tempDir(), 'wt com espaço')
    r.run('worktree', 'add', '-q', '-b', 'outro', wt)
    const main = (await resolveRepo(r.dir))!
    const linked = (await resolveRepo(wt))!
    expect(linked.top).toBe(realpathSync(wt))
    expect(linked.key).toBe(repoKeyOf(realpathSync(wt)))
    expect(linked.key).not.toBe(main.key)
    expect(linked.gitDir).not.toBe(main.gitDir)
    expect(linked.gitDir.startsWith(join(main.commonDir, 'worktrees') + '/')).toBe(true)
    expect(linked.commonDir).toBe(main.commonDir)
  })

  it('repoKeyOf é o sha1 do caminho, 16 hexadecimais', () => {
    // printf '/tmp/x' | sha1sum → e7ad2368a9224d8bdc303b4ac58430620eeb43f7
    expect(repoKeyOf('/tmp/x')).toBe('e7ad2368a9224d8b')
    expect(repoKeyOf('/a')).not.toBe(repoKeyOf('/b'))
  })
})

describe('git()', () => {
  it('git() não herda GIT_DIR nem GIT_INDEX_FILE do processo', async () => {
    const r = repo()
    const other = repo()
    process.env.GIT_DIR = join(other.dir, '.git')
    process.env.GIT_WORK_TREE = other.dir
    process.env.GIT_INDEX_FILE = '/tmp/x'
    const out = await git(r.dir, ['rev-parse', '--git-path', 'index'])
    expect(resolve(r.dir, out.stdout.toString().trim())).toBe(join(r.dir, '.git', 'index'))
    const top = await git(r.dir, ['rev-parse', '--show-toplevel'])
    expect(top.stdout.toString().trim()).toBe(realpathSync(r.dir))
  })

  it('indexFile define o GIT_INDEX_FILE explicitamente', async () => {
    const r = repo()
    const own = join(r.dir, '.git', 'claudinei-index')
    process.env.GIT_INDEX_FILE = '/tmp/x'
    const out = await git(r.dir, ['rev-parse', '--git-path', 'index'], { indexFile: own })
    expect(out.stdout.toString().trim()).toBe(own)
  })

  it('ambiente: autor e committer Claudinei, LC_ALL=C, sem locks opcionais nem prompt', async () => {
    const r = repo()
    process.env.GIT_AUTHOR_NAME = 'Operador'
    process.env.GIT_COMMITTER_EMAIL = 'operador@exemplo'
    const author = (await git(r.dir, ['var', 'GIT_AUTHOR_IDENT'])).stdout.toString()
    const committer = (await git(r.dir, ['var', 'GIT_COMMITTER_IDENT'])).stdout.toString()
    expect(author).toMatch(/^Claudinei <claudinei@localhost> /)
    expect(committer).toMatch(/^Claudinei <claudinei@localhost> /)
    // Alias de shell enxerga o ambiente com que o git foi chamado.
    process.env.GIT_OBJECT_DIRECTORY = '/tmp/objetos-alheios'
    const env = (await git(r.dir, ['-c', 'alias.ambiente=!env', 'ambiente'])).stdout.toString().split('\n')
    expect(env).toContain('GIT_OPTIONAL_LOCKS=0')
    expect(env).toContain('GIT_TERMINAL_PROMPT=0')
    expect(env).toContain('LC_ALL=C')
    expect(env.some(l => l.startsWith('GIT_OBJECT_DIRECTORY='))).toBe(false)
    expect(env.some(l => l.startsWith('GIT_INDEX_FILE='))).toBe(false)
  })

  it('código diferente de zero vira GitError com stderr; allowFail devolve o código', async () => {
    const r = repo()
    const args = ['cat-file', '-t', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']
    const err = await git(r.dir, args).then(() => null, e => e)
    expect(err).toBeInstanceOf(GitError)
    expect(err.code).toBe(128)
    expect(err.stderr).toMatch(/fatal/)
    expect(err.args).toEqual(args)
    const res = await git(r.dir, args, { allowFail: true })
    expect(res.code).toBe(128)
    expect(res.stderr).toMatch(/fatal/)
    expect(Buffer.isBuffer(res.stdout)).toBe(true)
  })

  it('input vai ao stdin; sem input o stdin fecha e o git não trava', async () => {
    const r = repo()
    r.write('f.txt', 'oi\n')
    const expected = r.run('hash-object', 'f.txt').trim()
    expect((await git(r.dir, ['hash-object', '--stdin'], { input: 'oi\n' })).stdout.toString().trim()).toBe(expected)
    expect((await git(r.dir, ['hash-object', '--stdin'], { input: Buffer.from('oi\n') })).stdout.toString().trim()).toBe(expected)
    // Blob vazio: o stdin chegou fechado.
    expect((await git(r.dir, ['hash-object', '--stdin'])).stdout.toString().trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('saída acima de maxBuffer vira GitError mesmo com allowFail', async () => {
    const r = repo({ 'grande.txt': 'x'.repeat(4096) })
    await expect(git(r.dir, ['cat-file', '-p', 'HEAD:grande.txt'], { maxBuffer: 100, allowFail: true })).rejects.toBeInstanceOf(GitError)
    expect((await git(r.dir, ['cat-file', '-p', 'HEAD:grande.txt'])).stdout.length).toBe(4096)
  })

  it('pasta inexistente vira GitError', async () => {
    await expect(git(join(tempDir(), 'nao-existe'), ['status'], { allowFail: true })).rejects.toBeInstanceOf(GitError)
  })
})

describe('splitZ', () => {
  it('separa a saída -z sem o vazio final e preserva nomes estranhos', async () => {
    expect(splitZ(Buffer.alloc(0))).toEqual([])
    expect(splitZ(Buffer.from('a\0b c\0'))).toEqual(['a', 'b c'])
    const names = ['dir com espaço/ação -x.txt', '-começa.txt', 'linha\nquebrada.txt']
    const r = repo(Object.fromEntries(names.map(n => [n, 'x\n'])))
    const listed = splitZ((await git(r.dir, ['ls-files', '-z'])).stdout)
    expect(listed.sort()).toEqual([...names].sort())
  })
})

describe('createRepoResolver', () => {
  it('resolver guarda por ttl e peek diz undefined antes de resolver', async () => {
    const r = repo()
    const plain = tempDir()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const resolver = createRepoResolver(60_000)
    expect(resolver.peek(r.dir)).toBeUndefined()
    const first = await resolver.get(r.dir)
    expect(first?.top).toBe(realpathSync(r.dir))
    expect(resolver.peek(r.dir)).toEqual(first)
    // Sem git a pasta continua resolvida enquanto o ttl vale.
    rmSync(join(r.dir, '.git'), { recursive: true, force: true })
    now += 59_999
    expect(await resolver.get(r.dir)).toEqual(first)
    now += 2
    expect(await resolver.get(r.dir)).toBeNull()
    expect(resolver.peek(r.dir)).toBeNull()
    // Fora de git, peek distingue null (resolvido) de undefined (não resolvido).
    expect(resolver.peek(plain)).toBeUndefined()
    expect(await resolver.get(plain)).toBeNull()
    expect(resolver.peek(plain)).toBeNull()
  })

  it('chamadas simultâneas na mesma pasta dividem a mesma resolução', async () => {
    const r = repo()
    const resolver = createRepoResolver()
    const [a, b] = await Promise.all([resolver.get(r.dir), resolver.get(r.dir)])
    expect(a).toBe(b)
  })
})
