import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveRepo, type RepoInfo } from '../src/checkpoint/repo.js'
import { SNAPSHOT_LIMITS, deleteRefs, refName, takeSnapshot } from '../src/checkpoint/snapshot.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import { makeRepo, makeTempDir, runGit } from './helpers/git-repo.js'

const MB2 = 2 * 1024 * 1024
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

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
/** `git init` sem nenhum commit. */
function emptyRepo() {
  const dir = tempDir()
  const run = (...args: string[]): string => runGit(dir, ...args)
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Teste')
  run('config', 'user.email', 'teste@localhost')
  run('config', 'commit.gpgsign', 'false')
  return { dir, run, write: (rel: string, body: string) => writeFileSync(join(dir, rel), body) }
}
async function info(dir: string): Promise<RepoInfo> {
  const r = await resolveRepo(dir)
  if (!r) throw new Error('sem repo')
  return r
}
/** Caminhos do tree de um commit, com modo. */
function tree(dir: string, commit: string): Map<string, string> {
  const out = runGit(dir, 'ls-tree', '-r', '-z', '--full-tree', commit)
  const map = new Map<string, string>()
  for (const line of out.split('\0').filter(Boolean)) {
    const [meta, path] = line.split('\t')
    map.set(path, meta.split(' ')[0])
  }
  return map
}
function names(dir: string, commit: string): string[] {
  return [...tree(dir, commit).keys()].sort()
}
function blob(dir: string, commit: string, path: string): string {
  return runGit(dir, 'cat-file', '-p', `${commit}:${path}`)
}
function changed(dir: string, a: string, b: string): string[] {
  return runGit(dir, 'diff-tree', '-r', '--name-only', '-z', a, b).split('\0').filter(Boolean).sort()
}
function ownIndex(dir: string): string[] {
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, '.git', 'claudinei-index') }
  return execFileSync('git', ['ls-files', '-z'], { cwd: dir, env, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
}
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/**
 * Impressão de tudo o que há em .git fora de objects/: caminho → sha256 dos
 * bytes. Depois do marco, só podem ter surgido claudinei-index e refs/claudinei/.
 */
function gitDirPrint(gitDir: string): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      const rel = relative(gitDir, full)
      if (rel === 'objects') continue
      if (e.isDirectory()) walk(full)
      else map.set(rel, sha(readFileSync(full)))
    }
  }
  walk(gitDir)
  return map
}
function withoutOurs(print: Map<string, string>): Map<string, string> {
  return new Map([...print].filter(([rel]) => rel !== 'claudinei-index' && !rel.startsWith('refs/claudinei/')))
}
/** Git de leitura que não regrava o índice (o `git status` comum o regravaria). */
function readGit(dir: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name]
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
}
/** Estado do operador que o marco não pode mexer. O índice é lido antes de qualquer git. */
function operatorState(dir: string) {
  const g = join(dir, '.git')
  const hasIndex = existsSync(join(g, 'index'))
  const index = hasIndex ? sha(readFileSync(join(g, 'index'))) : null
  const indexMtime = hasIndex ? statSync(join(g, 'index')).mtimeMs : null
  return {
    index,
    indexMtime,
    stash: readGit(dir, 'stash', 'list'),
    refs: readGit(dir, 'for-each-ref', 'refs/heads', 'refs/stash', 'refs/tags'),
    head: readGit(dir, 'rev-parse', '-q', '--verify', 'HEAD').trim(),
    headFile: readFileSync(join(g, 'HEAD'), 'utf8'),
    reflog: readGit(dir, 'reflog', '--all'),
    staged: readGit(dir, 'diff', '--cached', '--name-status'),
    status: readGit(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    branches: readGit(dir, 'branch', '-a'),
  }
}

describe('takeSnapshot: o git do operador fica intocado', () => {
  it('marco não muda índice, stash, HEAD, branches nem reflog do operador', async () => {
    const r = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    // Um stash, um arquivo modificado, outro em `git add` e um solto.
    r.write('c.txt', 'c guardado\n')
    r.run('stash', '-q')
    r.write('a.txt', 'a modificado\n')
    r.write('b.txt', 'b no índice\n')
    r.run('add', 'b.txt')
    r.write('solto.txt', 'solto\n')
    const repoInfo = await info(r.dir)
    const before = operatorState(r.dir)
    const printBefore = gitDirPrint(repoInfo.gitDir)

    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'a de novo\n')
    const s2 = await takeSnapshot(repoInfo, 2)

    expect(operatorState(r.dir)).toEqual(before)
    const printAfter = gitDirPrint(repoInfo.gitDir)
    expect(withoutOurs(printAfter)).toEqual(printBefore)
    expect(printAfter.has('claudinei-index')).toBe(true)
    // O retrato pegou a árvore de trabalho, não o índice nem o stash.
    expect(blob(r.dir, s1.commit, 'a.txt')).toBe('a modificado\n')
    expect(blob(r.dir, s1.commit, 'b.txt')).toBe('b no índice\n')
    expect(blob(r.dir, s1.commit, 'c.txt')).toBe('c\n')
    expect(blob(r.dir, s1.commit, 'solto.txt')).toBe('solto\n')
    expect(blob(r.dir, s2.commit, 'a.txt')).toBe('a de novo\n')
    expect(s1.head).toBe(before.head)
    expect(s1.branch).toBe('main')
    expect(s1.mode).toBe('full')
    expect(s1.listing).toBeNull()
    expect(s1.big).toEqual([])
  })

  it('marco com .git/index.lock presente funciona e não mexe no lock', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    r.write('a.txt', 'a mudou\n')
    const lock = join(r.dir, '.git', 'index.lock')
    writeFileSync(lock, 'o operador está no meio de um commit')
    utimesSync(lock, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const lockMtime = statSync(lock).mtimeMs
    const repoInfo = await info(r.dir)
    const before = operatorState(r.dir)
    const printBefore = gitDirPrint(repoInfo.gitDir)

    const s = await takeSnapshot(repoInfo, 1)

    expect(blob(r.dir, s.commit, 'a.txt')).toBe('a mudou\n')
    expect(readFileSync(lock, 'utf8')).toBe('o operador está no meio de um commit')
    expect(statSync(lock).mtimeMs).toBe(lockMtime)
    expect(existsSync(join(r.dir, '.git', 'claudinei-index.lock'))).toBe(false)
    expect(operatorState(r.dir)).toEqual(before)
    expect(withoutOurs(gitDirPrint(repoInfo.gitDir))).toEqual(printBefore)
  })

  it('índice próprio é semeado do do operador só da primeira vez', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    r.write('u.txt', 'solto\n')
    const repoInfo = await info(r.dir)
    const own = join(repoInfo.gitDir, 'claudinei-index')
    expect(existsSync(own)).toBe(false)
    const s1 = await takeSnapshot(repoInfo, 1)
    expect(existsSync(own)).toBe(true)
    expect(ownIndex(r.dir)).toEqual(['a.txt', 'u.txt'])
    // O u.txt só existe no índice próprio. Num marco limitado em que ele é
    // "antigo" (está na lista anterior), só continua no retrato se o índice
    // próprio não foi trocado por uma cópia nova do do operador.
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 0 }
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: [{ path: 'u.txt', size: 6, mtimeMs: 0 }] })
    expect(s2.mode).toBe('limited')
    expect(names(r.dir, s2.commit)).toEqual(['a.txt', 'u.txt'])
    expect(changed(r.dir, s1.commit, s2.commit)).toEqual([])
  })

  it('arquivo que o operador pôs no índice depois do primeiro marco entra, mesmo ignorado', async () => {
    const r = repo({ '.gitignore': '*.log\n', 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('forcado.log', 'log\n')
    r.run('add', '-f', 'forcado.log')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(names(r.dir, s1.commit)).not.toContain('forcado.log')
    expect(blob(r.dir, s2.commit, 'forcado.log')).toBe('log\n')
  })

  it('hooks do operador não rodam (post-index-change dispara em toda escrita de índice)', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const hooks = tempDir()
    const marker = join(hooks, 'rodou')
    writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\necho x >> '${marker}'\n`, { mode: 0o755 })
    r.run('config', 'core.hooksPath', hooks)
    // Prova de que o hook funciona neste repo.
    r.run('update-index', '--refresh')
    r.write('b.txt', 'b\n')
    r.run('add', 'b.txt')
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    r.write('a.txt', 'a2\n')
    r.write('c.txt', 'c\n')
    await takeSnapshot(await info(r.dir), 1)
    await takeSnapshot(await info(r.dir), 2)
    expect(existsSync(marker)).toBe(false)
  })

  it('hook reference-transaction do operador não roda no marco nem no deleteRefs', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    // Hook no lugar padrão (.git/hooks), como o de ferramentas tipo git-branchless.
    r.run('config', '--unset', 'core.hooksPath')
    const marker = join(tempDir(), 'rodou')
    const hook = join(r.dir, '.git', 'hooks', 'reference-transaction')
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${marker}'\n`, { mode: 0o755 })
    // Prova de que o hook funciona neste repo.
    r.run('update-ref', 'refs/prova/x', 'HEAD')
    r.run('update-ref', '-d', 'refs/prova/x')
    expect(readFileSync(marker, 'utf8')).toContain('committed')
    rmSync(marker)
    const repoInfo = await info(r.dir)
    const printBefore = gitDirPrint(repoInfo.gitDir)

    r.write('a.txt', 'a2\n')
    const s1 = await takeSnapshot(repoInfo, 1)
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(existsSync(marker)).toBe(false)
    await deleteRefs(repoInfo, [s1.ref, s2.ref])
    expect(existsSync(marker)).toBe(false)
    expect(withoutOurs(gitDirPrint(repoInfo.gitDir))).toEqual(printBefore)
  })

  it('arquivos com skip-worktree e assume-unchanged no índice do operador entram com o conteúdo do disco', async () => {
    const r = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' })
    r.run('update-index', '--skip-worktree', 'a.txt')
    r.run('update-index', '--assume-unchanged', 'b.txt')
    // c.txt: skip-worktree e ausente do disco, como fora do cone de um sparse
    // checkout. Fica com o conteúdo do HEAD, não vira arquivo apagado.
    r.run('update-index', '--skip-worktree', 'c.txt')
    rmSync(join(r.dir, 'c.txt'))
    r.write('a.txt', 'a mudou\n')
    r.write('b.txt', 'b mudou\n')
    r.write('d.txt', 'd mudou\n')
    const repoInfo = await info(r.dir)
    const before = operatorState(r.dir)
    const flagsBefore = readGit(r.dir, 'ls-files', '-v')

    const s1 = await takeSnapshot(repoInfo, 1)
    expect(blob(r.dir, s1.commit, 'a.txt')).toBe('a mudou\n')
    expect(blob(r.dir, s1.commit, 'b.txt')).toBe('b mudou\n')
    expect(blob(r.dir, s1.commit, 'c.txt')).toBe('c\n')
    expect(blob(r.dir, s1.commit, 'd.txt')).toBe('d mudou\n')
    // O marco seguinte acompanha as mudanças desses arquivos.
    r.write('a.txt', 'a de novo\n')
    r.write('b.txt', 'b de novo\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(blob(r.dir, s2.commit, 'a.txt')).toBe('a de novo\n')
    expect(blob(r.dir, s2.commit, 'b.txt')).toBe('b de novo\n')
    expect(blob(r.dir, s2.commit, 'c.txt')).toBe('c\n')

    // O índice do operador fica byte a byte igual, com as marcas.
    expect(operatorState(r.dir)).toEqual(before)
    expect(readGit(r.dir, 'ls-files', '-v')).toBe(flagsBefore)
    expect(flagsBefore).toContain('S a.txt')
    expect(flagsBefore).toContain('h b.txt')
    expect(flagsBefore).toContain('S c.txt')
  })

  it('sparse checkout: arquivo fora do cone que existe no disco entra; o ausente fica com o conteúdo do HEAD', async () => {
    const r = repo({ 'in/i.txt': 'i\n', 'out/o.txt': 'o\n', 'out/p.txt': 'p\n' })
    r.run('sparse-checkout', 'set', 'in')
    expect(existsSync(join(r.dir, 'out'))).toBe(false)
    // O git mostra o presente fora do cone sem a marca (`H`), mas o `add -u`
    // sem --sparse não o lê.
    r.write('out/o.txt', 'o novo\n')
    r.write('in/i.txt', 'i novo\n')
    const repoInfo = await info(r.dir)
    const before = operatorState(r.dir)
    const printBefore = gitDirPrint(repoInfo.gitDir)

    const s = await takeSnapshot(repoInfo, 1)
    expect(blob(r.dir, s.commit, 'in/i.txt')).toBe('i novo\n')
    expect(blob(r.dir, s.commit, 'out/o.txt')).toBe('o novo\n')
    expect(blob(r.dir, s.commit, 'out/p.txt')).toBe('p\n')
    expect(operatorState(r.dir)).toEqual(before)
    expect(withoutOurs(gitDirPrint(repoInfo.gitDir))).toEqual(printBefore)
  })

  it('assinatura de commit configurada pelo operador não trava o marco', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    r.run('config', 'commit.gpgsign', 'true')
    r.run('config', 'gpg.program', 'false')
    const s = await takeSnapshot(await info(r.dir), 1)
    expect(names(r.dir, s.commit)).toEqual(['a.txt'])
  })

  it('lock velho do índice próprio (marco morto no meio) é limpo; lock recente não', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    await takeSnapshot(repoInfo, 1)
    const ownLock = join(repoInfo.gitDir, 'claudinei-index.lock')
    writeFileSync(ownLock, '')
    await expect(takeSnapshot(repoInfo, 2)).rejects.toThrow()
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(ownLock, old, old)
    r.write('a.txt', 'a2\n')
    const s = await takeSnapshot(repoInfo, 3)
    expect(blob(r.dir, s.commit, 'a.txt')).toBe('a2\n')
    expect(existsSync(ownLock)).toBe(false)
  })
})

describe('takeSnapshot: HEAD destacado e repo sem commit', () => {
  it('marco em HEAD destacado e em repo sem commit: head e branch null quando não há, e o diff-tree entre dois marcos do repo sem commit lista o arquivo novo', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const headSha = r.run('rev-parse', 'HEAD').trim()
    r.run('checkout', '-q', '--detach')
    const repoInfo = await info(r.dir)
    const before = operatorState(r.dir)
    const detached = await takeSnapshot(repoInfo, 1)
    expect(detached.head).toBe(headSha)
    expect(detached.branch).toBeNull()
    expect(operatorState(r.dir)).toEqual(before)

    const e = emptyRepo()
    e.write('primeiro.txt', '1\n')
    const emptyInfo = await info(e.dir)
    const headFile = readFileSync(join(e.dir, '.git', 'HEAD'), 'utf8')
    const s1 = await takeSnapshot(emptyInfo, 1)
    expect(s1.head).toBeNull()
    expect(s1.branch).toBeNull()
    e.write('novo.txt', 'novo\n')
    const s2 = await takeSnapshot(emptyInfo, 2)
    expect(s2.head).toBeNull()
    expect(changed(e.dir, s1.commit, s2.commit)).toEqual(['novo.txt'])
    // Continua sem commit, sem branch criado e sem índice do operador.
    expect(readFileSync(join(e.dir, '.git', 'HEAD'), 'utf8')).toBe(headFile)
    expect(e.run('for-each-ref')).toBe(refsOnlyOurs(e.run('for-each-ref')))
    expect(existsSync(join(e.dir, '.git', 'index'))).toBe(false)
  })
})
function refsOnlyOurs(out: string): string {
  return out.split('\n').filter(l => l === '' || l.includes('\trefs/claudinei/')).join('\n')
}

describe('takeSnapshot: o que entra no retrato', () => {
  it('mudança feita "pelo Bash" entra', async () => {
    const r = repo({ 'README.md': '# r\n', 'a.txt': 'a\n', 'dir com espaço/ação -x.txt': 'x\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    writeFileSync(join(r.dir, 'a.txt'), 'escrito direto\n')
    writeFileSync(join(r.dir, 'dir com espaço', 'ação -x.txt'), 'y\n')
    writeFileSync(join(r.dir, '-começa.txt'), 'novo\n')
    rmSync(join(r.dir, 'README.md'))
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(changed(r.dir, s1.commit, s2.commit)).toEqual(['-começa.txt', 'README.md', 'a.txt', 'dir com espaço/ação -x.txt'].sort())
    expect(names(r.dir, s2.commit)).not.toContain('README.md')
  })

  it('.gitignore respeitado', async () => {
    const r = repo({ 'README.md': '# r\n', '.gitignore': 'node_modules/\n' })
    r.write('node_modules/x.js', 'x\n')
    r.write('src/y.js', 'y\n')
    const s = await takeSnapshot(await info(r.dir), 1)
    expect(names(r.dir, s.commit)).toEqual(['.gitignore', 'README.md', 'src/y.js'])
  })

  it('solto que passa a ser ignorado sai do índice próprio', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    r.write('temp.log', 'log\n')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('.gitignore', '*.log\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(names(r.dir, s1.commit)).toContain('temp.log')
    expect(names(r.dir, s2.commit)).not.toContain('temp.log')
    expect(ownIndex(r.dir)).not.toContain('temp.log')
  })

  it('solto de 2 MB + 1 byte fica fora e vai em big; com 2 MB exatos entra', async () => {
    const r = repo()
    writeFileSync(join(r.dir, 'exato.bin'), Buffer.alloc(MB2, 1))
    writeFileSync(join(r.dir, 'grande.bin'), Buffer.alloc(MB2 + 1, 2))
    const s = await takeSnapshot(await info(r.dir), 1)
    expect(SNAPSHOT_LIMITS.untrackedMaxBytes).toBe(MB2)
    expect(names(r.dir, s.commit)).toEqual(['README.md', 'exato.bin'])
    expect(s.big.map(b => [b.path, b.size])).toEqual([['grande.bin', MB2 + 1]])
    expect(s.big[0].mtimeMs).toBe(statSync(join(r.dir, 'grande.bin')).mtimeMs)
    expect(s.mode).toBe('full')
  })

  it('solto que cresce além de 2 MB sai do índice próprio no marco seguinte, sem gravar o conteúdo grande', async () => {
    const r = repo()
    r.write('cresce.bin', 'pequeno\n')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    expect(names(r.dir, s1.commit)).toContain('cresce.bin')
    const bigBody = Buffer.alloc(MB2 + 1, 7)
    writeFileSync(join(r.dir, 'cresce.bin'), bigBody)
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(names(r.dir, s2.commit)).not.toContain('cresce.bin')
    expect(s2.big.map(b => b.path)).toEqual(['cresce.bin'])
    expect(ownIndex(r.dir)).not.toContain('cresce.bin')
    // O conteúdo grande não foi parar na base de objetos do operador.
    const bigSha = r.run('hash-object', 'cresce.bin').trim()
    expect(() => r.run('cat-file', '-e', bigSha)).toThrow()
  })

  it('pathspecs literais: arquivos chamados *.txt e :(x) entram sem casar com outros', async () => {
    const r = repo()
    r.write('*.txt', 'estrela\n')
    r.write(':(x)', 'magia\n')
    r.write('a.txt', 'a\n')
    writeFileSync(join(r.dir, 'grande.txt'), Buffer.alloc(MB2 + 1, 3))
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    expect(names(r.dir, s1.commit)).toEqual(['*.txt', ':(x)', 'README.md', 'a.txt'])
    expect(blob(r.dir, s1.commit, '*.txt')).toBe('estrela\n')
    // Ignorar só o `*.txt` literal: o rm --cached não pode levar o a.txt junto.
    r.write('.gitignore', '\\*.txt\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(names(r.dir, s2.commit)).toEqual(['.gitignore', ':(x)', 'README.md', 'a.txt'])
  })

  it('retrato limitado', async () => {
    const r = repo({ 'README.md': '# r\n', 'rastreado.txt': 'r\n' })
    for (const n of [1, 2, 3, 4]) r.write(`velho${n}.txt`, `${n}\n`)
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    expect(s1.mode).toBe('limited')
    expect(s1.listing!.length).toBe(4)
    expect(s1.listing!.map(e => e.path)).toEqual(['velho1.txt', 'velho2.txt', 'velho3.txt', 'velho4.txt'])
    expect(names(r.dir, s1.commit)).toEqual(['README.md', 'rastreado.txt'])

    r.write('novo.txt', 'novo\n')
    r.write('rastreado.txt', 'r2\n')
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: s1.listing })
    expect(s2.mode).toBe('limited')
    expect(s2.listing!.length).toBe(5)
    expect(names(r.dir, s2.commit)).toEqual(['README.md', 'novo.txt', 'rastreado.txt'])
    expect(blob(r.dir, s2.commit, 'rastreado.txt')).toBe('r2\n')

    // O solto criado durante um turno continua nos marcos seguintes e acompanha mudanças.
    r.write('novo.txt', 'novo2\n')
    const s3 = await takeSnapshot(repoInfo, 3, { limits, previousListing: s2.listing })
    expect(names(r.dir, s3.commit)).toEqual(['README.md', 'novo.txt', 'rastreado.txt'])
    expect(blob(r.dir, s3.commit, 'novo.txt')).toBe('novo2\n')
  })

  it('limitado depois de um completo: os soltos criados no intervalo entram; os antigos continuam', async () => {
    const r = repo({ 'README.md': '# r\n' })
    r.write('velho1.txt', '1\n')
    r.write('velho2.txt', '2\n')
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    expect(s1.mode).toBe('full')
    expect(s1.listing).toBeNull()
    expect(names(r.dir, s1.commit)).toEqual(['README.md', 'velho1.txt', 'velho2.txt'])

    // O turno cria soltos que levam o marco seguinte ao modo limitado.
    for (const n of [1, 2, 3]) r.write(`novo${n}.txt`, `novo ${n}\n`)
    r.write('enorme.bin', Buffer.alloc(MB2 + 1, 1))
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: 'full' })
    expect(s2.mode).toBe('limited')
    expect(names(r.dir, s2.commit)).toEqual(['README.md', 'novo1.txt', 'novo2.txt', 'novo3.txt', 'velho1.txt', 'velho2.txt'])
    expect(s2.big.map(e => e.path)).toEqual(['enorme.bin'])

    // Sem saber nada do marco anterior, segue como antes: nenhum solto novo
    // entra (o primeiro marco de uma pasta com milhares de soltos).
    r.write('outro.txt', 'outro\n')
    const s3 = await takeSnapshot(repoInfo, 3, { limits })
    expect(s3.mode).toBe('limited')
    expect(names(r.dir, s3.commit)).toEqual(names(r.dir, s2.commit))
  })

  it('retrato limitado também pela soma dos bytes', async () => {
    const r = repo()
    r.write('a.txt', 'x'.repeat(600))
    r.write('b.txt', 'y'.repeat(600))
    const s = await takeSnapshot(await info(r.dir), 1, { limits: { ...SNAPSHOT_LIMITS, limitedBytes: 1000 } })
    expect(s.mode).toBe('limited')
    expect(names(r.dir, s.commit)).toEqual(['README.md'])
  })

  it('submódulo entra como gitlink (modo 160000)', async () => {
    const sub = repo({ 's.txt': 's\n' })
    const r = repo({ 'a.txt': 'a\n' })
    r.run('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub')
    r.run('commit', '-q', '-m', 'submódulo')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    const t1 = tree(r.dir, s1.commit)
    expect(t1.get('sub')).toBe('160000')
    expect(t1.has('sub/s.txt')).toBe(false)
    // O commit dentro do submódulo vira o novo gitlink do marco.
    const subDir = join(r.dir, 'sub')
    runGit(subDir, 'config', 'user.name', 'Teste')
    runGit(subDir, 'config', 'user.email', 'teste@localhost')
    runGit(subDir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(subDir, 's.txt'), 's2\n')
    runGit(subDir, 'commit', '-q', '-am', 'dentro')
    const subHead = runGit(subDir, 'rev-parse', 'HEAD').trim()
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(runGit(r.dir, 'rev-parse', `${s2.commit}:sub`).trim()).toBe(subHead)
  })

  it('repositório aninhado solto (não submódulo) não entra como gitlink', async () => {
    const r = repo()
    const nested = join(r.dir, 'aninhado')
    runGit(r.dir, 'init', '-q', 'aninhado')
    writeFileSync(join(nested, 'f.txt'), 'f\n')
    const s = await takeSnapshot(await info(r.dir), 1)
    expect(names(r.dir, s.commit)).toEqual(['README.md'])
  })
})

describe('refs ocultas', () => {
  it('ref fica em refs/claudinei/<chave>/<n> e não aparece em git branch nem git log', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const branchesBefore = r.run('branch', '-a')
    const logBefore = r.run('log', '--oneline', '--branches', '--tags', '--remotes')
    const s = await takeSnapshot(repoInfo, 7)
    expect(refName(repoInfo.key, 7)).toBe(`refs/claudinei/${repoInfo.key}/7`)
    expect(s.ref).toBe(`refs/claudinei/${repoInfo.key}/7`)
    expect(r.run('rev-parse', s.ref).trim()).toBe(s.commit)
    expect(r.run('branch', '-a')).toBe(branchesBefore)
    expect(r.run('log', '--oneline')).not.toMatch(/claudinei/)
    expect(r.run('log', '--oneline', '--branches', '--tags', '--remotes')).toBe(logBefore)
    // Commit sem pai, mensagem "claudinei <n>", autor Claudinei.
    expect(r.run('rev-list', '--parents', '-n', '1', s.commit).trim()).toBe(s.commit)
    expect(r.run('log', '-1', '--format=%s|%an <%ae>|%cn', s.commit).trim()).toBe('claudinei 7|Claudinei <claudinei@localhost>|Claudinei')
  })

  it('worktree ligado: índice e refs pela chave dele, sem mexer no índice do principal', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const wt = join(tempDir(), 'wt')
    r.run('worktree', 'add', '-q', '-b', 'outro', wt)
    writeFileSync(join(wt, 'a.txt'), 'no worktree\n')
    const main = await info(r.dir)
    const linked = await info(wt)
    const mainIndex = sha(readFileSync(join(main.gitDir, 'index')))
    const linkedIndex = sha(readFileSync(join(linked.gitDir, 'index')))
    const s = await takeSnapshot(linked, 1)
    expect(s.ref).toBe(`refs/claudinei/${linked.key}/1`)
    expect(s.branch).toBe('outro')
    expect(blob(r.dir, s.commit, 'a.txt')).toBe('no worktree\n')
    expect(existsSync(join(linked.gitDir, 'claudinei-index'))).toBe(true)
    expect(existsSync(join(main.gitDir, 'claudinei-index'))).toBe(false)
    expect(sha(readFileSync(join(main.gitDir, 'index')))).toBe(mainIndex)
    expect(sha(readFileSync(join(linked.gitDir, 'index')))).toBe(linkedIndex)
  })

  it('deleteRefs apaga as refs pedidas (existentes ou não) e nada mais', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    const s2 = await takeSnapshot(repoInfo, 2)
    await deleteRefs(repoInfo, [s1.ref, refName(repoInfo.key, 99)])
    await deleteRefs(repoInfo, [])
    const refs = r.run('for-each-ref', '--format=%(refname)').trim().split('\n').sort()
    expect(refs).toEqual([s2.ref, 'refs/heads/main'].sort())
  })

  it('deleteRefs recusa ref fora de refs/claudinei/', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const s = await takeSnapshot(repoInfo, 1)
    const before = r.run('for-each-ref')
    for (const bad of ['refs/heads/main', 'HEAD', 'refs/claudinei', 'refs/claudinei/../heads/main',
      `refs/claudinei/${repoInfo.key}/1\ndelete refs/heads/main`, 'refs/claudineix/a', 'refs/stash']) {
      await expect(deleteRefs(repoInfo, [s.ref, bad])).rejects.toThrow()
    }
    // Recusa tudo de uma vez: nem a ref válida da lista foi apagada.
    expect(r.run('for-each-ref')).toBe(before)
  })
})

describe('createSerialQueue', () => {
  it('fila serial: duas chamadas na mesma chave não se sobrepõem; chaves diferentes rodam juntas', async () => {
    const q = createSerialQueue()
    const log: string[] = []
    const gate = (name: string, ms: number) => async (): Promise<string> => {
      log.push(`+${name}`)
      await new Promise(r => setTimeout(r, ms))
      log.push(`-${name}`)
      return name
    }
    const a1 = q.run('a', gate('a1', 40))
    const a2 = q.run('a', gate('a2', 10))
    const b1 = q.run('b', gate('b1', 10))
    expect(await Promise.all([a1, a2, b1])).toEqual(['a1', 'a2', 'b1'])
    // a2 só começa depois de a1 terminar; b1 começa antes de a1 terminar.
    expect(log.indexOf('+a2')).toBeGreaterThan(log.indexOf('-a1'))
    expect(log.indexOf('+b1')).toBeLessThan(log.indexOf('-a1'))
  })

  it('erro de uma tarefa não trava a fila; idle espera a chave (ou todas) esvaziar', async () => {
    const q = createSerialQueue()
    const failed = q.run('a', async () => { throw new Error('falhou') })
    const sync = q.run('a', () => { throw new Error('síncrono') })
    let done = false
    const after = q.run('a', async () => { await new Promise(r => setTimeout(r, 20)); done = true; return 1 })
    await expect(failed).rejects.toThrow('falhou')
    await expect(sync).rejects.toThrow('síncrono')
    await q.idle('a')
    expect(done).toBe(true)
    expect(await after).toBe(1)
    let other = false
    void q.run('b', async () => { await new Promise(r => setTimeout(r, 20)); other = true })
    await q.idle()
    expect(other).toBe(true)
    await q.idle('nunca-usada')
  })

  it('idle de uma chave espera também o que entrou na fila enquanto esperava', async () => {
    const q = createSerialQueue()
    let last = false
    void q.run('a', async () => {
      await new Promise(r => setTimeout(r, 10))
      void q.run('a', async () => { await new Promise(r => setTimeout(r, 10)); last = true })
    })
    await q.idle('a')
    expect(last).toBe(true)
  })
})

// Arquivo que encolhe para 0 não pode quebrar o lstat dos soltos.
describe('takeSnapshot: soltos que mudam', () => {
  it('solto vazio entra; solto apagado entre marcos sai', async () => {
    const r = repo()
    r.write('vazio.txt', 'x')
    truncateSync(join(r.dir, 'vazio.txt'), 0)
    r.write('some.txt', 'some\n')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    expect(names(r.dir, s1.commit)).toEqual(['README.md', 'some.txt', 'vazio.txt'])
    rmSync(join(r.dir, 'some.txt'))
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(names(r.dir, s2.commit)).toEqual(['README.md', 'vazio.txt'])
  })
})
