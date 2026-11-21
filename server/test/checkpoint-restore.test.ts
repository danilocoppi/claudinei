import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepo, type RepoInfo } from '../src/checkpoint/repo.js'
import { takeSnapshot, type Snapshot } from '../src/checkpoint/snapshot.js'
import { changedFiles } from '../src/checkpoint/diff.js'
import {
  applyPrepared, blobStatesAt, planRestore, prepareRestore,
  type RestoreAction, type RestoreItem, type RestorePlanItem,
} from '../src/checkpoint/restore.js'
import { makeRepo, makeTempDir } from './helpers/git-repo.js'

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
async function info(dir: string): Promise<RepoInfo> {
  const r = await resolveRepo(dir)
  if (!r) throw new Error('sem repo')
  return r
}

/** Os itens do desfazer entre dois marcos: cada arquivo que mudou, com o "antes" e o "depois". */
async function itemsOf(repoInfo: RepoInfo, from: Snapshot, to: Snapshot): Promise<RestoreItem[]> {
  const paths = (await changedFiles(repoInfo, from, to)).map(f => f.path)
  const before = await blobStatesAt(repoInfo, from.commit, paths)
  const after = await blobStatesAt(repoInfo, to.commit, paths)
  return paths.map(path => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }))
}
function byPath(plan: RestorePlanItem[]): Record<string, RestorePlanItem> {
  return Object.fromEntries(plan.map(p => [p.path, p]))
}
function expectedOf(plan: RestorePlanItem[]): Record<string, string | null> {
  return Object.fromEntries(plan.map(p => [p.path, p.nowDigest]))
}
/** Prévia, preparo e escrita, como o serviço fará. */
async function undo(repoInfo: RepoInfo, items: RestoreItem[], decisions: Record<string, RestoreAction> = {}) {
  const plan = await planRestore(repoInfo, items)
  const prepared = await prepareRestore(repoInfo, items, decisions, expectedOf(plan))
  const res = applyPrepared(prepared)
  return { plan: byPath(plan), results: Object.fromEntries(res.map(r => [r.path, r.result])) }
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')
const isExec = (dir: string, rel: string): boolean => (statSync(join(dir, rel)).mode & 0o100) !== 0
const lines = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `linha ${i + 1}`).join('\n') + '\n'

describe('blobStatesAt', () => {
  it('modo e sha de arquivo, executável e link; ausente fica fora; nome com - e espaço', async () => {
    const r = repo({ 'a.txt': 'a\n', '-traço.txt': 't\n', 'dir com espaço/ação.txt': 'x\n', 'exe.sh': 'e\n' })
    chmodSync(join(r.dir, 'exe.sh'), 0o755)
    symlinkSync('a.txt', join(r.dir, 'lk'))
    r.run('add', '-A')
    r.run('commit', '-q', '-m', 'mais')
    const repoInfo = await info(r.dir)
    const head = r.run('rev-parse', 'HEAD').trim()
    const states = await blobStatesAt(repoInfo, head, ['a.txt', '-traço.txt', 'dir com espaço/ação.txt', 'exe.sh', 'lk', 'nao-existe'])
    expect(states.get('a.txt')).toEqual({ sha: r.run('rev-parse', 'HEAD:a.txt').trim(), mode: '100644' })
    expect(states.get('-traço.txt')?.mode).toBe('100644')
    expect(states.get('dir com espaço/ação.txt')?.mode).toBe('100644')
    expect(states.get('exe.sh')?.mode).toBe('100755')
    expect(states.get('lk')?.mode).toBe('120000')
    expect(states.has('nao-existe')).toBe(false)
    // Só o que foi pedido, mesmo quando o caminho é uma pasta.
    expect([...(await blobStatesAt(repoInfo, head, ['dir com espaço'])).keys()]).toEqual([])
  })

  it('recusa commit que não é hash', async () => {
    const r = repo()
    await expect(blobStatesAt(await info(r.dir), '--output=/tmp/x', ['a'])).rejects.toThrow()
  })
})

describe('as três comparações e a escrita', () => {
  it('agora = depois volta ao antes', async () => {
    const r = repo({ 'a.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'depois\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const { plan, results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(plan['a.txt']).toMatchObject({ verdict: 'revert', mergeable: false })
    expect(plan['a.txt'].nowDigest).toMatch(/^[0-9a-f]{40}$/)
    expect(results).toEqual({ 'a.txt': 'reverted' })
    expect(read(r.dir, 'a.txt')).toBe('antes\n')
  })

  it('agora = antes fica already', async () => {
    const r = repo({ 'a.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'depois\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('a.txt', 'antes\n')
    const { plan, results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(plan['a.txt'].verdict).toBe('already')
    expect(results).toEqual({ 'a.txt': 'already' })
    expect(read(r.dir, 'a.txt')).toBe('antes\n')
  })

  it('conflito com merge limpo: desfaz a linha 2 do turno e mantém a 9 de depois', async () => {
    const r = repo({ 'a.txt': lines(12) })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', lines(12, { 2: 'TURNO' }))
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('a.txt', lines(12, { 2: 'TURNO', 9: 'OPERADOR' }))
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = byPath(await planRestore(repoInfo, items))
    expect(plan['a.txt']).toMatchObject({ verdict: 'conflict', mergeable: true })
    // O que mudou desde o turno: a linha 9, com o caminho legível no cabeçalho.
    expect(plan['a.txt'].sinceTurn).toContain('-linha 9')
    expect(plan['a.txt'].sinceTurn).toContain('+OPERADOR')
    expect(plan['a.txt'].sinceTurn).toContain('a/a.txt')
    expect(plan['a.txt'].sinceTurn).not.toContain('TURNO\n+')
    const { results } = await undo(repoInfo, items, { 'a.txt': 'merge' })
    expect(results).toEqual({ 'a.txt': 'merged' })
    expect(read(r.dir, 'a.txt')).toBe(lines(12, { 9: 'OPERADOR' }))
  })

  it('conflito com choque: os dois na mesma linha, mergeable false e merge recusado', async () => {
    const r = repo({ 'a.txt': lines(12) })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', lines(12, { 2: 'TURNO' }))
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('a.txt', lines(12, { 2: 'OPERADOR' }))
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    expect(plan[0]).toMatchObject({ verdict: 'conflict', mergeable: false })
    await expect(prepareRestore(repoInfo, items, { 'a.txt': 'merge' }, expectedOf(plan))).rejects.toThrow(/merge/)
    expect(read(r.dir, 'a.txt')).toBe(lines(12, { 2: 'OPERADOR' }))
  })

  it('binário em conflito não é mergeable', async () => {
    const r = repo({ 'b.bin': '' })
    writeFileSync(join(r.dir, 'b.bin'), Buffer.from([0, 1, 2, 10, 3, 10]))
    r.run('commit', '-q', '-am', 'bin')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    writeFileSync(join(r.dir, 'b.bin'), Buffer.from([0, 1, 9, 10, 3, 10]))
    const s2 = await takeSnapshot(repoInfo, 2)
    writeFileSync(join(r.dir, 'b.bin'), Buffer.from([0, 1, 9, 10, 7, 10]))
    const [p] = await planRestore(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(p).toMatchObject({ verdict: 'conflict', mergeable: false })
  })

  it('force volta ao antes e perde o depois; keep não escreve', async () => {
    const r = repo({ 'f.txt': 'antes\n', 'k.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('f.txt', 'turno\n')
    r.write('k.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('f.txt', 'operador\n')
    r.write('k.txt', 'operador\n')
    const { plan, results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2), { 'f.txt': 'force', 'k.txt': 'keep' })
    expect(plan['f.txt'].verdict).toBe('conflict')
    expect(results).toEqual({ 'f.txt': 'forced', 'k.txt': 'kept' })
    expect(read(r.dir, 'f.txt')).toBe('antes\n')
    expect(read(r.dir, 'k.txt')).toBe('operador\n')
  })

  it('conflito sem decisão fica como está', async () => {
    const r = repo({ 'a.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('a.txt', 'operador\n')
    const { results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(results).toEqual({ 'a.txt': 'kept' })
    expect(read(r.dir, 'a.txt')).toBe('operador\n')
  })

  it('arquivo criado no turno é apagado; apagado no turno é recriado com o conteúdo e o modo', async () => {
    const r = repo({ 'velho.sh': '#!/bin/sh\necho\n' })
    chmodSync(join(r.dir, 'velho.sh'), 0o755)
    r.run('commit', '-q', '-am', 'exe')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'velho.sh'))
    r.write('nova/pasta/novo.txt', 'novo\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const { plan, results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(plan['velho.sh']).toMatchObject({ verdict: 'revert', nowDigest: null })
    expect(results).toEqual({ 'nova/pasta/novo.txt': 'reverted', 'velho.sh': 'reverted' })
    expect(existsSync(join(r.dir, 'nova/pasta/novo.txt'))).toBe(false)
    // Pasta vazia que sobra fica.
    expect(existsSync(join(r.dir, 'nova/pasta'))).toBe(true)
    expect(read(r.dir, 'velho.sh')).toBe('#!/bin/sh\necho\n')
    expect(isExec(r.dir, 'velho.sh')).toBe(true)
    expect(r.run('status', '--porcelain', '--', 'velho.sh')).toBe('')
  })

  it('apagado no turno dentro de pasta apagada: a pasta volta', async () => {
    const r = repo({ 'p/q/f.txt': 'f\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    rmSync(join(r.dir, 'p'), { recursive: true })
    const s2 = await takeSnapshot(repoInfo, 2)
    const { results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(results).toEqual({ 'p/q/f.txt': 'reverted' })
    expect(read(r.dir, 'p/q/f.txt')).toBe('f\n')
  })

  it('bit de execução volta', async () => {
    const r = repo({ 'x.sh': 'echo\n', 'y.sh': 'echo\n' })
    chmodSync(join(r.dir, 'y.sh'), 0o755)
    r.run('commit', '-q', '-am', 'y exe')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    chmodSync(join(r.dir, 'x.sh'), 0o755)
    chmodSync(join(r.dir, 'y.sh'), 0o644)
    const s2 = await takeSnapshot(repoInfo, 2)
    const { results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(results).toEqual({ 'x.sh': 'reverted', 'y.sh': 'reverted' })
    expect(isExec(r.dir, 'x.sh')).toBe(false)
    expect(isExec(r.dir, 'y.sh')).toBe(true)
    expect(r.run('status', '--porcelain')).toBe('')
  })

  it('link simbólico criado no turno: desfazer remove o link e não o alvo', async () => {
    const r = repo({ 'alvo.txt': 'alvo\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    symlinkSync('alvo.txt', join(r.dir, 'lk'))
    const s2 = await takeSnapshot(repoInfo, 2)
    const { plan, results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(plan['lk'].verdict).toBe('revert')
    expect(results).toEqual({ lk: 'reverted' })
    expect(existsSync(join(r.dir, 'lk'))).toBe(false)
    expect(read(r.dir, 'alvo.txt')).toBe('alvo\n')
  })

  it('link trocado por arquivo volta a ser link; arquivo trocado por link volta a ser arquivo', async () => {
    const r = repo({ 'alvo.txt': 'alvo\n', 'era-arquivo': 'conteúdo\n' })
    symlinkSync('alvo.txt', join(r.dir, 'era-link'))
    r.run('add', 'era-link')
    r.run('commit', '-q', '-m', 'link')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'era-link'))
    r.write('era-link', 'agora é arquivo\n')
    unlinkSync(join(r.dir, 'era-arquivo'))
    symlinkSync('alvo.txt', join(r.dir, 'era-arquivo'))
    const s2 = await takeSnapshot(repoInfo, 2)
    const { results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(results).toEqual({ 'era-arquivo': 'reverted', 'era-link': 'reverted' })
    expect(lstatSync(join(r.dir, 'era-link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(r.dir, 'era-link'))).toBe('alvo.txt')
    expect(lstatSync(join(r.dir, 'era-arquivo')).isFile()).toBe(true)
    expect(read(r.dir, 'era-arquivo')).toBe('conteúdo\n')
    // O alvo do link nunca foi escrito.
    expect(read(r.dir, 'alvo.txt')).toBe('alvo\n')
    expect(r.run('status', '--porcelain')).toBe('')
  })

  it('link que o turno trocou de alvo: compara o alvo (readlink), não o arquivo apontado', async () => {
    const r = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    symlinkSync('a.txt', join(r.dir, 'lk'))
    r.run('add', 'lk')
    r.run('commit', '-q', '-m', 'link')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'lk'))
    symlinkSync('b.txt', join(r.dir, 'lk'))
    const s2 = await takeSnapshot(repoInfo, 2)
    // Mexer no arquivo apontado não muda o "agora" do link.
    r.write('b.txt', 'b mudado\n')
    const items = (await itemsOf(repoInfo, s1, s2)).filter(i => i.path === 'lk')
    const { plan, results } = await undo(repoInfo, items)
    expect(plan['lk'].verdict).toBe('revert')
    expect(results).toEqual({ lk: 'reverted' })
    expect(readlinkSync(join(r.dir, 'lk'))).toBe('a.txt')
    expect(read(r.dir, 'b.txt')).toBe('b mudado\n')
  })

  it('comitado entre o turno e o desfazer: volta os arquivos sem commit e o HEAD fica igual', async () => {
    const r = repo({ 'a.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    r.write('novo.txt', 'novo\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.run('add', '-A')
    r.run('commit', '-q', '-m', 'o operador comitou o turno')
    const head = r.run('rev-parse', 'HEAD').trim()
    const branches = r.run('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
    const index = readFileSync(join(repoInfo.gitDir, 'index'))
    const { results } = await undo(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(results).toEqual({ 'a.txt': 'reverted', 'novo.txt': 'reverted' })
    expect(r.run('rev-parse', 'HEAD').trim()).toBe(head)
    expect(r.run('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')).toBe(branches)
    expect(readFileSync(join(repoInfo.gitDir, 'index')).equals(index)).toBe(true)
    // A reversão fica sem commit e sem stage, para o operador comitar.
    expect(r.run('status', '--porcelain')).toBe(' M a.txt\n D novo.txt\n')
    expect(r.run('diff', '--cached', '--name-only')).toBe('')
    expect(r.run('stash', 'list')).toBe('')
  })

  it('checkout para outro branch com o arquivo diferente dá conflict', async () => {
    const r = repo({ 'a.txt': 'main\n' })
    r.run('checkout', '-q', '-b', 'outro')
    r.write('a.txt', 'outro branch\n')
    r.run('commit', '-q', '-am', 'outro')
    r.run('checkout', '-q', 'main')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.run('commit', '-q', '-am', 'turno')
    r.run('checkout', '-q', 'outro')
    const [p] = await planRestore(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(p).toMatchObject({ path: 'a.txt', verdict: 'conflict' })
    expect(p.sinceTurn).toContain('+outro branch')
  })

  it('changed_since_preview: escrita entre prepareRestore e applyPrepared não é sobrescrita', async () => {
    const r = repo({ 'a.txt': 'antes\n', 'b.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    r.write('b.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    const prepared = await prepareRestore(repoInfo, items, {}, expectedOf(plan))
    // O editor salva entre a prévia e a escrita.
    r.write('a.txt', 'editor salvou\n')
    const res = applyPrepared(prepared)
    expect(Array.isArray(res)).toBe(true) // síncrono: nada de Promise
    expect(res).toEqual([{ path: 'a.txt', result: 'changed_since_preview' }, { path: 'b.txt', result: 'reverted' }])
    expect(read(r.dir, 'a.txt')).toBe('editor salvou\n')
    expect(read(r.dir, 'b.txt')).toBe('antes\n')
  })

  it('changed_since_preview: escrita entre a prévia e o preparo também', async () => {
    const r = repo({ 'a.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    r.write('a.txt', 'editor salvou\n')
    const prepared = await prepareRestore(repoInfo, items, {}, expectedOf(plan))
    // Mesmo voltando ao "depois" antes da escrita, a prévia já não vale.
    r.write('a.txt', 'turno\n')
    expect(applyPrepared(prepared)).toEqual([{ path: 'a.txt', result: 'changed_since_preview' }])
    expect(read(r.dir, 'a.txt')).toBe('turno\n')
  })

  it('erro de E/S num arquivo vira failed com a mensagem e os outros seguem (R11)', async () => {
    const r = repo({ 'a.txt': 'antes\n', 'trava/b.txt': 'antes\n', 'c.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'turno\n')
    r.write('trava/b.txt', 'turno\n')
    r.write('c.txt', 'turno\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    const prepared = await prepareRestore(repoInfo, items, {}, expectedOf(plan))
    // Pasta só de leitura: o arquivo temporário ao lado não pode ser criado.
    chmodSync(join(r.dir, 'trava'), 0o555)
    cleanups.push(() => chmodSync(join(r.dir, 'trava'), 0o755))
    const res = applyPrepared(prepared)
    expect(res.map(x => [x.path, x.result])).toEqual([['a.txt', 'reverted'], ['c.txt', 'reverted'], ['trava/b.txt', 'failed']])
    expect(res[2].error).toMatch(/EACCES|permission/i)
    expect(read(r.dir, 'a.txt')).toBe('antes\n')
    expect(read(r.dir, 'c.txt')).toBe('antes\n')
    expect(read(r.dir, 'trava/b.txt')).toBe('turno\n')
  })

  it('autocrlf=true: arquivo com CRLF no disco conta como igual ao depois', async () => {
    const r = repo({ 'a.txt': 'um\ndois\n' })
    r.run('config', 'core.autocrlf', 'true')
    // O checkout com autocrlf poria CRLF no disco.
    r.write('a.txt', 'um\r\ndois\r\n')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'um\r\nDOIS\r\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const items = await itemsOf(repoInfo, s1, s2)
    expect(items.map(i => i.path)).toEqual(['a.txt'])
    const { plan, results } = await undo(repoInfo, items)
    expect(plan['a.txt'].verdict).toBe('revert')
    expect(results).toEqual({ 'a.txt': 'reverted' })
    expect(read(r.dir, 'a.txt')).toBe('um\r\ndois\r\n')
  })

  it('caminhos com espaço, acento e começando com -', async () => {
    const r = repo({ 'dir com espaço/ação -x.txt': 'antes\n', '-começa.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('dir com espaço/ação -x.txt', 'turno\n')
    r.write('-começa.txt', 'turno\n')
    r.write('-novo com espaço.txt', 'novo\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('-começa.txt', 'turno\noperador\n')
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = byPath(await planRestore(repoInfo, items))
    expect(plan['-começa.txt']).toMatchObject({ verdict: 'conflict', mergeable: false })
    // Cabeçalho legível: acento sem aspas nem octal.
    expect(plan['-começa.txt'].sinceTurn).toContain('b/-começa.txt')
    const { results } = await undo(repoInfo, items, { '-começa.txt': 'force' })
    expect(results).toEqual({ '-começa.txt': 'forced', '-novo com espaço.txt': 'reverted', 'dir com espaço/ação -x.txt': 'reverted' })
    expect(read(r.dir, 'dir com espaço/ação -x.txt')).toBe('antes\n')
    expect(read(r.dir, '-começa.txt')).toBe('antes\n')
    expect(existsSync(join(r.dir, '-novo com espaço.txt'))).toBe(false)
  })

  it('pasta agora onde havia arquivo: conflict, só keep, e a pasta fica', async () => {
    const r = repo({ p: 'arquivo\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'p'))
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('p/dentro.txt', 'do operador\n')
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    expect(plan[0]).toMatchObject({ path: 'p', verdict: 'conflict', mergeable: false })
    await expect(prepareRestore(repoInfo, items, { p: 'force' }, expectedOf(plan))).rejects.toThrow()
    const { results } = await undo(repoInfo, items, { p: 'keep' })
    expect(results).toEqual({ p: 'kept' })
    expect(read(r.dir, 'p/dentro.txt')).toBe('do operador\n')
  })

  it('sinceTurn para em 2000 linhas', async () => {
    const r = repo({ 'g.txt': lines(10) })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('g.txt', lines(10, { 1: 'TURNO' }))
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('g.txt', Array.from({ length: 5000 }, (_, i) => `nova ${i}`).join('\n') + '\n')
    const [p] = await planRestore(repoInfo, await itemsOf(repoInfo, s1, s2))
    expect(p.verdict).toBe('conflict')
    expect(p.sinceTurn!.split('\n').length - 1).toBe(2000)
    expect(p.sinceTurnTruncated).toBe(true)
  })

  it('não deixa arquivos temporários para trás', async () => {
    const before = new Set(readdirSync(tmpdir()))
    const r = repo({ 'a.txt': lines(12) })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', lines(12, { 2: 'TURNO' }))
    const s2 = await takeSnapshot(repoInfo, 2)
    r.write('a.txt', lines(12, { 2: 'TURNO', 9: 'OPERADOR' }))
    await undo(repoInfo, await itemsOf(repoInfo, s1, s2), { 'a.txt': 'merge' })
    const left = readdirSync(tmpdir()).filter(n => !before.has(n) && n.startsWith('claudinei-restore-'))
    expect(left).toEqual([])
    expect(readdirSync(r.dir).filter(n => n.includes('claudinei'))).toEqual([])
  })
})

describe('nunca escreve fora do topo', () => {
  it('recusa caminho absoluto, com .., vazio ou dentro de .git', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const head = r.run('rev-parse', 'HEAD:a.txt').trim()
    const state = { sha: head, mode: '100644' as const }
    for (const path of ['/etc/passwd', '../fora.txt', 'a/../../fora.txt', 'a/./b', '', 'a//b', '.git/config', 'x/.GIT/hooks/pre-commit', 'a\0b']) {
      const items = [{ path, before: state, after: null }]
      await expect(planRestore(repoInfo, items), path).rejects.toThrow(/caminho/)
      await expect(prepareRestore(repoInfo, items, {}, { [path]: null }), path).rejects.toThrow(/caminho/)
    }
  })

  it('pasta trocada por link para fora do repositório: conflict e nada escrito lá', async () => {
    const r = repo({ 'd/x.txt': 'antes\n', 'd/y.txt': 'y\n' })
    const outside = tempDir()
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('d/x.txt', 'turno\n')
    unlinkSync(join(r.dir, 'd/y.txt'))
    const s2 = await takeSnapshot(repoInfo, 2)
    // Depois do turno, `d` vira link para fora, com o mesmo "depois" lá dentro.
    writeFileSync(join(outside, 'x.txt'), 'turno\n')
    rmSync(join(r.dir, 'd'), { recursive: true })
    symlinkSync(outside, join(r.dir, 'd'))
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = byPath(await planRestore(repoInfo, items))
    expect(plan['d/x.txt']).toMatchObject({ verdict: 'conflict', mergeable: false })
    expect(plan['d/y.txt']).toMatchObject({ verdict: 'conflict', mergeable: false })
    for (const action of ['force', 'merge', 'revert'] as const) {
      await expect(prepareRestore(repoInfo, items, { 'd/x.txt': action }, expectedOf(Object.values(plan)))).rejects.toThrow()
      await expect(prepareRestore(repoInfo, items, { 'd/y.txt': action }, expectedOf(Object.values(plan)))).rejects.toThrow()
    }
    const { results } = await undo(repoInfo, items, { 'd/x.txt': 'keep', 'd/y.txt': 'keep' })
    expect(results).toEqual({ 'd/x.txt': 'kept', 'd/y.txt': 'kept' })
    expect(readdirSync(outside)).toEqual(['x.txt'])
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('turno\n')
  })

  it('pasta trocada por link entre o preparo e a escrita: changed_since_preview e nada escrito fora', async () => {
    const r = repo({ 'd/x.txt': 'antes\n', 'd/y.txt': 'y\n' })
    const outside = tempDir()
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('d/x.txt', 'turno\n')
    unlinkSync(join(r.dir, 'd/y.txt'))
    r.write('d/z.txt', 'criado\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = await planRestore(repoInfo, items)
    expect(plan.map(p => p.verdict)).toEqual(['revert', 'revert', 'revert'])
    const prepared = await prepareRestore(repoInfo, items, {}, expectedOf(plan))
    // Troca de `d` por um link para fora com o mesmo conteúdo.
    writeFileSync(join(outside, 'x.txt'), 'turno\n')
    writeFileSync(join(outside, 'z.txt'), 'criado\n')
    renameSync(join(r.dir, 'd'), join(r.dir, 'd-real'))
    symlinkSync(outside, join(r.dir, 'd'))
    const res = applyPrepared(prepared)
    expect(res.map(x => x.result)).toEqual(['changed_since_preview', 'changed_since_preview', 'changed_since_preview'])
    expect(readdirSync(outside).sort()).toEqual(['x.txt', 'z.txt'])
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('turno\n')
    expect(readFileSync(join(outside, 'z.txt'), 'utf8')).toBe('criado\n')
  })

  it('link para pasta dentro do repositório também não serve de caminho', async () => {
    const r = repo({ 'real/f.txt': 'antes\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'real/f.txt'))
    mkdirSync(join(r.dir, 'outra'))
    const s2 = await takeSnapshot(repoInfo, 2)
    // `real` vira link para `outra`: recriar real/f.txt escreveria em outra/f.txt.
    rmSync(join(r.dir, 'real'), { recursive: true })
    symlinkSync('outra', join(r.dir, 'real'))
    const items = await itemsOf(repoInfo, s1, s2)
    const plan = byPath(await planRestore(repoInfo, items))
    expect(plan['real/f.txt'].verdict).toBe('conflict')
    await undo(repoInfo, items, { 'real/f.txt': 'keep' })
    expect(readdirSync(join(r.dir, 'outra'))).toEqual([])
  })
})
