import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepo, type RepoInfo } from '../src/checkpoint/repo.js'
import { SNAPSHOT_LIMITS, deleteRefs, takeSnapshot } from '../src/checkpoint/snapshot.js'
import { changedFiles, commitExists, fileDiff, type FileChange } from '../src/checkpoint/diff.js'
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
async function info(dir: string): Promise<RepoInfo> {
  const r = await resolveRepo(dir)
  if (!r) throw new Error('sem repo')
  return r
}
function byPath(list: FileChange[]): Record<string, FileChange> {
  return Object.fromEntries(list.map(f => [f.path, f]))
}
/** Muda o mtime de um arquivo para uma data fixa (o conteúdo fica). */
function touchAt(path: string, year: number): void {
  utimesSync(path, new Date(year, 0, 1), new Date(year, 0, 1))
}

describe('changedFiles', () => {
  it('added, modified, deleted e mode com +/− do numstat', async () => {
    const r = repo({ 'mod.txt': 'um\ndois\ntrês\n', 'apaga.txt': 'a\nb\n', 'exe.sh': 'echo\n', 'fica.txt': 'f\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('mod.txt', 'um\nDOIS\ntrês\nquatro\n')
    unlinkSync(join(r.dir, 'apaga.txt'))
    chmodSync(join(r.dir, 'exe.sh'), 0o755)
    r.write('novo.txt', 'n1\nn2\nn3\n')
    const s2 = await takeSnapshot(repoInfo, 2)

    const files = await changedFiles(repoInfo, s1, s2)
    expect(files.map(f => f.path)).toEqual(['apaga.txt', 'exe.sh', 'mod.txt', 'novo.txt'])
    const f = byPath(files)
    expect(f['mod.txt']).toEqual({ path: 'mod.txt', status: 'modified', added: 2, removed: 1, binary: false })
    expect(f['apaga.txt']).toEqual({ path: 'apaga.txt', status: 'deleted', added: 0, removed: 2, binary: false })
    expect(f['exe.sh']).toEqual({ path: 'exe.sh', status: 'mode', added: 0, removed: 0, binary: false })
    expect(f['novo.txt']).toEqual({ path: 'novo.txt', status: 'added', added: 3, removed: 0, binary: false })
    // Mesmo marco dos dois lados: nada.
    expect(await changedFiles(repoInfo, s2, s2)).toEqual([])
  })

  it('bit de execução junto com conteúdo é modified, não mode', async () => {
    const r = repo({ 'exe.sh': 'echo\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('exe.sh', 'echo 2\n')
    chmodSync(join(r.dir, 'exe.sh'), 0o755)
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'exe.sh', status: 'modified', added: 1, removed: 1, binary: false },
    ])
  })

  it('link simbólico trocado por arquivo comum é modified; link criado é added', async () => {
    const r = repo({ 'alvo.txt': 'alvo\n' })
    symlinkSync('alvo.txt', join(r.dir, 'link'))
    r.run('add', 'link')
    r.run('commit', '-q', '-m', 'link')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'link'))
    r.write('link', 'agora é arquivo\n')
    symlinkSync('alvo.txt', join(r.dir, 'novo-link'))
    const s2 = await takeSnapshot(repoInfo, 2)
    const f = byPath(await changedFiles(repoInfo, s1, s2))
    expect(Object.keys(f).sort()).toEqual(['link', 'novo-link'])
    expect(f['link']).toMatchObject({ status: 'modified', binary: false, added: 1, removed: 1 })
    expect(f['novo-link']).toMatchObject({ status: 'added', binary: false, added: 1, removed: 0 })
  })

  it('binário: binary true, sem linhas (criado, mudado e apagado), e fileDiff dá sizeKb', async () => {
    const r = repo({ 'velho.bin': '' })
    writeFileSync(join(r.dir, 'velho.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
    writeFileSync(join(r.dir, 'muda.bin'), Buffer.from([0, 9, 9]))
    r.run('add', 'velho.bin', 'muda.bin')
    r.run('commit', '-q', '-m', 'binários')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    unlinkSync(join(r.dir, 'velho.bin'))
    writeFileSync(join(r.dir, 'muda.bin'), Buffer.concat([Buffer.from([0]), Buffer.alloc(5000, 7)]))
    writeFileSync(join(r.dir, 'novo.bin'), Buffer.concat([Buffer.from([0]), Buffer.alloc(3071, 1)]))
    const s2 = await takeSnapshot(repoInfo, 2)

    const f = byPath(await changedFiles(repoInfo, s1, s2))
    expect(f['velho.bin']).toEqual({ path: 'velho.bin', status: 'deleted', added: 0, removed: 0, binary: true })
    expect(f['muda.bin']).toEqual({ path: 'muda.bin', status: 'modified', added: 0, removed: 0, binary: true })
    expect(f['novo.bin']).toEqual({ path: 'novo.bin', status: 'added', added: 0, removed: 0, binary: true })

    expect(await fileDiff(repoInfo, s1.commit, s2.commit, 'novo.bin')).toEqual(
      { path: 'novo.bin', binary: true, sizeKb: 3, text: '', truncated: false })
    // 5001 bytes: arredonda para cima.
    expect(await fileDiff(repoInfo, s1.commit, s2.commit, 'muda.bin')).toEqual(
      { path: 'muda.bin', binary: true, sizeKb: 5, text: '', truncated: false })
    // Apagado: o lado novo não existe; o tamanho vem do lado antigo.
    expect(await fileDiff(repoInfo, s1.commit, s2.commit, 'velho.bin')).toEqual(
      { path: 'velho.bin', binary: true, sizeKb: 1, text: '', truncated: false })
  })

  it('solto grande criado no intervalo aparece como too_big com o tamanho', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    r.write('grande-antigo.bin', Buffer.alloc(MB2 + 10, 1))
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('grande.bin', Buffer.alloc(MB2 + 1, 2))
    r.write('pequeno.txt', 'p\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(s2.big.map(e => e.path).sort()).toEqual(['grande-antigo.bin', 'grande.bin'])

    const files = await changedFiles(repoInfo, s1, s2)
    // O grande que já existia e não mudou não aparece.
    expect(files).toEqual([
      { path: 'grande.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 1 },
      { path: 'pequeno.txt', status: 'added', added: 1, removed: 0, binary: false },
    ])
  })

  it('grande que mudou de tamanho ou de data é too_big', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    r.write('cresce.bin', Buffer.alloc(MB2 + 10, 1))
    r.write('data.bin', Buffer.alloc(MB2 + 10, 1))
    touchAt(join(r.dir, 'data.bin'), 2020)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('cresce.bin', Buffer.alloc(MB2 + 20, 1))
    touchAt(join(r.dir, 'data.bin'), 2021)
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'cresce.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 20 },
      { path: 'data.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 10 },
    ])
  })

  it('solto pequeno que cresceu além do limite é too_big, não deleted (desfazer o apagaria)', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    r.write('cresce.txt', 'pouco\n')
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('cresce.txt', Buffer.alloc(MB2 + 1, 65))
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'cresce.txt', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 1 },
    ])
  })

  it('grande que encolheu para dentro do retrato ou foi apagado é too_big (o antes não tem retrato)', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    r.write('encolhe.bin', Buffer.alloc(MB2 + 5, 1))
    r.write('some.bin', Buffer.alloc(MB2 + 7, 1))
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('encolhe.bin', 'agora pequeno\n')
    unlinkSync(join(r.dir, 'some.bin'))
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'encolhe.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 5 },
      { path: 'some.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 7 },
    ])
  })

  it('limitado: solto antigo que mudou aparece como unsnapshotted; criado no turno aparece como added', async () => {
    const r = repo({ 'rastreado.txt': 'r\n' })
    for (const n of [1, 2, 3, 4]) r.write(`velho${n}.txt`, `${n}\n`)
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    expect(s1.mode).toBe('limited')
    r.write('velho1.txt', 'mudou de tamanho\n')
    touchAt(join(r.dir, 'velho2.txt'), 2020) // só a data
    r.write('novo.txt', 'novo\n')
    r.write('rastreado.txt', 'r2\n')
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: s1.listing })
    expect(s2.mode).toBe('limited')

    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'novo.txt', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'rastreado.txt', status: 'modified', added: 1, removed: 1, binary: false },
      { path: 'velho1.txt', status: 'unsnapshotted', added: 0, removed: 0, binary: false, size: 17 },
      { path: 'velho2.txt', status: 'unsnapshotted', added: 0, removed: 0, binary: false, size: 2 },
    ])

    // O criado no turno segue no retrato e é diff normal no turno seguinte.
    r.write('novo.txt', 'novo\nmais\n')
    const s3 = await takeSnapshot(repoInfo, 3, { limits, previousListing: s2.listing })
    expect(await changedFiles(repoInfo, s2, s3)).toEqual([
      { path: 'novo.txt', status: 'modified', added: 1, removed: 0, binary: false },
    ])
  })

  it('limitado depois de um completo: os soltos criados no turno aparecem como added', async () => {
    const r = repo({ 'rastreado.txt': 'r\n' })
    r.write('velho.txt', 'v\n')
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    expect(s1.mode).toBe('full')
    for (const n of [1, 2, 3]) r.write(`novo${n}.txt`, `novo ${n}\n`)
    r.write('velho.txt', 'v\nmudou\n')
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: 'full' })
    expect(s2.mode).toBe('limited')
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'novo1.txt', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'novo2.txt', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'novo3.txt', status: 'added', added: 1, removed: 0, binary: false },
      // O solto antigo estava no retrato completo e continua no limitado: diff normal.
      { path: 'velho.txt', status: 'modified', added: 1, removed: 0, binary: false },
    ])
  })

  it('limitado: grande antigo que encolheu (e segue fora do retrato) é too_big', async () => {
    const r = repo()
    for (const n of [1, 2, 3, 4]) r.write(`velho${n}.txt`, `${n}\n`)
    r.write('grande.bin', Buffer.alloc(MB2 + 3, 1))
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    r.write('grande.bin', 'pequeno\n')
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: s1.listing })
    expect(s2.mode).toBe('limited')
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'grande.bin', status: 'too_big', added: 0, removed: 0, binary: false, size: MB2 + 3 },
    ])
  })

  it('saída do modo limitado: solto antigo que entra no retrato é unsnapshotted, não added', async () => {
    const r = repo()
    for (const n of [1, 2, 3, 4]) r.write(`velho${n}.txt`, `${n}\n`)
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1, { limits: { ...SNAPSHOT_LIMITS, limitedFiles: 3 } })
    expect(s1.mode).toBe('limited')
    unlinkSync(join(r.dir, 'velho4.txt'))
    r.write('novo.txt', 'novo\n')
    // Agora são 4 soltos; com o limite em 4, o modo volta a ser completo.
    const s2 = await takeSnapshot(repoInfo, 2, { limits: { ...SNAPSHOT_LIMITS, limitedFiles: 4 }, previousListing: s1.listing })
    expect(s2.mode).toBe('full')
    const f = byPath(await changedFiles(repoInfo, s1, s2))
    expect(f['novo.txt']).toMatchObject({ status: 'added' })
    for (const n of [1, 2, 3]) expect(f[`velho${n}.txt`]).toMatchObject({ status: 'unsnapshotted' })
    // O apagado nunca esteve no retrato: aparece sem retrato, com o tamanho de antes.
    expect(f['velho4.txt']).toEqual({ path: 'velho4.txt', status: 'unsnapshotted', added: 0, removed: 0, binary: false, size: 2 })
  })

  it('limitado: solto antigo apagado no turno aparece como unsnapshotted com o tamanho de antes', async () => {
    const r = repo()
    for (const n of [1, 2, 3, 4, 5]) r.write(`velho${n}.txt`, `${n}`.repeat(n) + '\n')
    const repoInfo = await info(r.dir)
    const limits = { ...SNAPSHOT_LIMITS, limitedFiles: 3 }
    const s1 = await takeSnapshot(repoInfo, 1, { limits })
    expect(s1.mode).toBe('limited')
    unlinkSync(join(r.dir, 'velho3.txt'))
    r.write('novo.txt', 'novo\n')
    const s2 = await takeSnapshot(repoInfo, 2, { limits, previousListing: s1.listing })
    expect(s2.mode).toBe('limited')
    expect(await changedFiles(repoInfo, s1, s2)).toEqual([
      { path: 'novo.txt', status: 'added', added: 1, removed: 0, binary: false },
      { path: 'velho3.txt', status: 'unsnapshotted', added: 0, removed: 0, binary: false, size: 4 },
    ])
    // O criado no turno e apagado depois está no retrato: é deleted normal.
    unlinkSync(join(r.dir, 'novo.txt'))
    const s3 = await takeSnapshot(repoInfo, 3, { limits, previousListing: s2.listing })
    expect(await changedFiles(repoInfo, s2, s3)).toEqual([
      { path: 'novo.txt', status: 'deleted', added: 0, removed: 1, binary: false },
    ])
  })

  it('submódulo que avançou aparece como submodule', async () => {
    const sub = repo({ 's.txt': 's\n' })
    const r = repo({ 'a.txt': 'a\n' })
    r.run('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub')
    r.run('commit', '-q', '-m', 'submódulo')
    // O operador pediu para o git ignorar o submódulo: o diff do marco não pode esconder.
    r.run('config', '-f', '.gitmodules', 'submodule.sub.ignore', 'all')
    r.run('config', 'diff.ignoreSubmodules', 'all')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    const subDir = join(r.dir, 'sub')
    runGit(subDir, 'config', 'user.name', 'Teste')
    runGit(subDir, 'config', 'user.email', 'teste@localhost')
    runGit(subDir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(subDir, 's.txt'), 's2\n')
    runGit(subDir, 'commit', '-q', '-am', 'dentro')
    const s2 = await takeSnapshot(repoInfo, 2)
    const files = (await changedFiles(repoInfo, s1, s2)).filter(f => f.path !== '.gitmodules')
    expect(files).toEqual([{ path: 'sub', status: 'submodule', added: 0, removed: 0, binary: false }])
  })

  it('caminho com espaço, acento, tab e começando com "-" ou ":"', async () => {
    const weird = ['dir com espaço/ação -x.txt', '-começa.txt', ':(x)dois', 'tab\there.txt', 'aspas "e" \\barra.txt']
    const r = repo({ 'README.md': '# r\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    for (const p of weird) r.write(p, `linha de ${p}\n`)
    const s2 = await takeSnapshot(repoInfo, 2)
    for (const p of weird) r.write(p, `linha de ${p}\noutra\n`)
    const s3 = await takeSnapshot(repoInfo, 3)

    const created = await changedFiles(repoInfo, s1, s2)
    expect(created.map(f => f.path).sort()).toEqual([...weird].sort())
    for (const f of created) expect(f).toMatchObject({ status: 'added', added: 1, removed: 0 })
    const changed = await changedFiles(repoInfo, s2, s3)
    expect(changed.map(f => f.path).sort()).toEqual([...weird].sort())
    for (const f of changed) expect(f).toMatchObject({ status: 'modified', added: 1, removed: 0 })

    for (const p of weird) {
      const d = await fileDiff(repoInfo, s2.commit, s3.commit, p)
      expect(d.binary).toBe(false)
      expect(d.truncated).toBe(false)
      expect(d.text).toContain('+outra\n')
      // Só o arquivo pedido, nunca outro que case como padrão.
      expect(d.text.match(/^diff --git /gm)).toHaveLength(1)
    }
  })
})

describe('fileDiff', () => {
  it('diff unificado com -U3 e prefixos a/ b/', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`)
    const r = repo({ 'f.txt': lines.join('\n') + '\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    lines[9] = 'L10'
    r.write('f.txt', lines.join('\n') + '\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const d = await fileDiff(repoInfo, s1.commit, s2.commit, 'f.txt')
    expect(d.path).toBe('f.txt')
    expect(d.binary).toBe(false)
    expect(d.truncated).toBe(false)
    expect(d.sizeKb).toBeUndefined()
    expect(d.text).toMatch(/^diff --git a\/f\.txt b\/f\.txt\n/)
    // Três linhas de contexto de cada lado (o cabeçalho do trecho pode trazer a "função").
    expect(d.text).toMatch(/--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -7,7 \+7,7 @@[^\n]*\n l7\n l8\n l9\n-l10\n\+L10\n l11\n l12\n l13\n$/)
    // Arquivo que não mudou: diff vazio.
    expect(await fileDiff(repoInfo, s1.commit, s2.commit, 'README.md')).toEqual(
      { path: 'README.md', binary: false, text: '', truncated: false })
  })

  it('fileDiff corta em 2000 linhas com truncated', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('grande.txt', Array.from({ length: 2500 }, (_, i) => `linha ${i}`).join('\n') + '\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const d = await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt')
    expect(d.truncated).toBe(true)
    expect(d.binary).toBe(false)
    expect(d.text.endsWith('\n')).toBe(true)
    expect(d.text.split('\n').length - 1).toBe(2000)
    expect(d.text).toContain('+linha 0\n')
    expect(d.text).not.toContain('+linha 2499\n')
    // Com teto próprio.
    const small = await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt', 10)
    expect(small.truncated).toBe(true)
    expect(small.text.split('\n').length - 1).toBe(10)
    // Diff com exatamente o teto de linhas não é truncado.
    const full = await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt', 100_000)
    const total = full.text.split('\n').length - 1
    expect(full.truncated).toBe(false)
    expect((await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt', total)).truncated).toBe(false)
  })

  it('diff acima do teto de bytes volta cortado (truncated), não erro', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('grande.txt', Array.from({ length: 2500 }, (_, i) => `linha ${i}`).join('\n') + '\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    const d = await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt', 2000, { maxBuffer: 1024 })
    expect(d.truncated).toBe(true)
    expect(d.binary).toBe(false)
    expect(d.text).toMatch(/^diff --git a\/grande\.txt b\/grande\.txt\n/)
    expect(d.text).toContain('+linha 0\n')
    // Só linhas inteiras, dentro do teto.
    expect(d.text.endsWith('\n')).toBe(true)
    expect(Buffer.byteLength(d.text)).toBeLessThanOrEqual(1024)
    const lines = d.text.split('\n').length - 1
    expect(lines).toBeGreaterThan(10)
    expect(lines).toBeLessThan(2000)
    // O teto de linhas continua valendo quando vem antes do de bytes.
    const few = await fileDiff(repoInfo, s1.commit, s2.commit, 'grande.txt', 5, { maxBuffer: 1024 })
    expect(few.truncated).toBe(true)
    expect(few.text.split('\n').length - 1).toBe(5)
  })

  it('config do operador não muda o diff nem roda programas (prefixos, cor, diff externo, textconv)', async () => {
    const r = repo({ 'f.txt': 'um\n', 'g.cfg': 'x\n' })
    const marker = join(tempDir(), 'rodou')
    const script = join(tempDir(), 'prog.sh')
    writeFileSync(script, `#!/bin/sh\necho rodou >> '${marker}'\necho falso\n`)
    chmodSync(script, 0o755)
    r.write('.gitattributes', '*.cfg diff=conv\n')
    r.run('config', 'diff.noprefix', 'true')
    r.run('config', 'diff.mnemonicPrefix', 'true')
    r.run('config', 'color.ui', 'always')
    r.run('config', 'color.diff', 'always')
    r.run('config', 'diff.external', script)
    r.run('config', 'diff.conv.textconv', script)
    r.run('config', 'diff.conv.command', script)
    r.run('config', 'diff.context', '0')
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('f.txt', 'um\ndois\n')
    r.write('g.cfg', 'x\ny\n')
    const s2 = await takeSnapshot(repoInfo, 2)

    const files = byPath(await changedFiles(repoInfo, s1, s2))
    expect(files['g.cfg']).toMatchObject({ status: 'modified', added: 1, removed: 0, binary: false })
    const d = await fileDiff(repoInfo, s1.commit, s2.commit, 'f.txt')
    expect(d.text).toBe('diff --git a/f.txt b/f.txt\nindex 8a6e397..2395415 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n um\n+dois\n')
    const g = await fileDiff(repoInfo, s1.commit, s2.commit, 'g.cfg')
    expect(g.text).toContain('--- a/g.cfg\n+++ b/g.cfg\n')
    expect(g.text).toContain(' x\n+y\n')
    expect(g.text).not.toContain('falso')
    expect(existsSync(marker)).toBe(false)
  })

  it('commit inválido é recusado antes de chegar ao git', async () => {
    const r = repo()
    const repoInfo = await info(r.dir)
    const s = await takeSnapshot(repoInfo, 1)
    await expect(fileDiff(repoInfo, '--output=/tmp/x', s.commit, 'README.md')).rejects.toThrow()
    await expect(changedFiles(repoInfo, { commit: 'HEAD', big: [], listing: null }, s)).rejects.toThrow()
  })
})

describe('commitExists', () => {
  it('commitExists falso depois de apagar a ref e rodar git gc --prune=now no repo do teste', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const s1 = await takeSnapshot(repoInfo, 1)
    r.write('a.txt', 'a2\n')
    const s2 = await takeSnapshot(repoInfo, 2)
    expect(await commitExists(repoInfo, s1.commit)).toBe(true)
    expect(await commitExists(repoInfo, s2.commit)).toBe(true)
    await deleteRefs(repoInfo, [s1.ref])
    // gc só no repositório temporário do teste.
    r.run('gc', '-q', '--prune=now')
    expect(await commitExists(repoInfo, s1.commit)).toBe(false)
    expect(await commitExists(repoInfo, s2.commit)).toBe(true)
  })

  it('commitExists falso para o que não é commit nem hash', async () => {
    const r = repo({ 'a.txt': 'a\n' })
    const repoInfo = await info(r.dir)
    const blobSha = r.run('rev-parse', 'HEAD:a.txt').trim()
    expect(await commitExists(repoInfo, blobSha)).toBe(false)
    expect(await commitExists(repoInfo, '0'.repeat(40))).toBe(false)
    expect(await commitExists(repoInfo, 'HEAD')).toBe(false)
    expect(await commitExists(repoInfo, '--help')).toBe(false)
    expect(await commitExists(repoInfo, '')).toBe(false)
  })
})
