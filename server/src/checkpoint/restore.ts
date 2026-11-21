import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, GitError, splitZ } from './git.js'
import type { RepoInfo } from './repo.js'
import { DIFF_MAX_BYTES, DIFF_MAX_LINES } from './diff.js'
import type { RestoreAction, RestoreResult, RestoreVerdict } from '../../../shared/undo.js'

// Os tipos que a web também usa moram em shared/undo.ts.
export type { RestoreAction, RestoreResult, RestoreVerdict } from '../../../shared/undo.js'

/**
 * Desfazer os arquivos de um turno: as três comparações e a escrita.
 *
 * Para cada arquivo há três versões: "antes" (marco de início), "depois"
 * (marco de fim) e "agora" (o disco). A comparação é por bytes, como o
 * operador vê o arquivo, e não por hash do git: "antes" e "depois" saem do
 * `cat-file --filters` (smudge, LFS e autocrlf, como num checkout; o link
 * simbólico sai cru, é o alvo), e "agora" são os bytes do disco com o bit de
 * execução do lstat (o link é o readlink, nunca o arquivo apontado).
 *
 * - agora = antes: `already`;
 * - agora = depois: `revert`, o alvo é o "antes" (ou apagar, se não existia);
 * - o resto: `conflict`.
 *
 * O git do operador fica intocado: aqui só rodam `ls-tree` e `cat-file` na
 * pasta dele, e `merge-file` e `diff --no-index` sobre arquivos temporários
 * em os.tmpdir(). A escrita é só no disco, nunca no índice, HEAD ou branches.
 *
 * Nunca se escreve fora de `repo.top`: caminho absoluto, com `.`/`..`/vazio ou
 * dentro de `.git` é recusado, e um caminho cujas pastas-pai incluem um link
 * simbólico (ou um arquivo) fica "bloqueado": vira conflito em que só cabe
 * `keep`. O link nunca é seguido: na escrita, a folha é trocada por rename e
 * apagada com unlink, então um link no lugar do arquivo é substituído, não
 * atravessado.
 */

export interface BlobState { sha: string; mode: '100644' | '100755' | '120000' }
/** `null` = o arquivo não existia naquele marco. */
export interface RestoreItem { path: string; before: BlobState | null; after: BlobState | null }
export interface RestorePlanItem {
  path: string
  verdict: RestoreVerdict
  /** Só em conflict: o inverso do turno aplica sem choque (`git merge-file`). */
  mergeable: boolean
  /** sha1 de modo + bytes do disco; null = ausente; `dir`/`blocked`/`other` para o que não é arquivo nem link. */
  nowDigest: string | null
  /** conflict: diff unificado de "depois" → "agora" (≤ 2000 linhas). */
  sinceTurn?: string
  /** O sinceTurn foi cortado no teto. */
  sinceTurnTruncated?: boolean
}

/** Interno: o que applyPrepared faz com um arquivo. */
export interface PreparedEntry {
  path: string
  segs: string[]
  /** Digest do "agora" que a prévia viu; a escrita só acontece se o disco ainda for este. */
  expected: string | null
  op: { kind: 'write'; mode: BlobState['mode']; bytes: Buffer } | { kind: 'delete' } | { kind: 'none' }
  /** Resultado quando o disco ainda é o esperado. */
  result: Exclude<RestoreResult, 'changed_since_preview' | 'failed'>
  /** O disco já mudou no preparo: nada a escrever. */
  stale: boolean
}
export interface PreparedRestore { repo: RepoInfo; entries: PreparedEntry[] }
/** O que applyPrepared fez com cada arquivo; `error` só em `failed`. */
export interface AppliedEntry { path: string; result: RestoreResult; error?: string }

const HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const MODES = new Set(['100644', '100755', '120000'])
const LINK = '120000'
// Lotes do ls-tree, para a linha de comando não passar do ARG_MAX.
const LS_TREE_BATCH = 500
// Arquivos analisados em paralelo (cada um custa até 3 processos git).
const CONCURRENCY = 4
// Como o git: NUL nos primeiros 8000 bytes é binário.
const BINARY_PROBE = 8000

function assertHash(value: string, what: string): void {
  if (!HASH.test(value)) throw new Error(`${what} inválido: ${JSON.stringify(value)}`)
}

/**
 * Partes de um caminho relativo ao topo, ou erro. Recusa o que poderia sair
 * do topo ou entrar no `.git`: absoluto, vazio, NUL, `.`/`..`/vazio no meio e
 * qualquer parte `.git` (sem distinção de caixa).
 */
function safeSegments(path: string): string[] {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || path.startsWith('/')) {
    throw new Error(`caminho recusado: ${JSON.stringify(path)}`)
  }
  const segs = path.split('/')
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git') {
      throw new Error(`caminho recusado: ${JSON.stringify(path)}`)
    }
  }
  return segs
}

function assertState(path: string, state: BlobState | null): void {
  if (state === null) return
  assertHash(state.sha, `blob de ${path}`)
  if (!MODES.has(state.mode)) throw new Error(`modo não suportado em ${path}: ${state.mode}`)
}

// ---------------------------------------------------------------- "agora"

type NowState =
  | { kind: 'absent' }
  | { kind: 'file'; bytes: Buffer; exec: boolean }
  | { kind: 'link'; target: Buffer }
  /** Pasta no lugar do arquivo: nunca é apagada (nada de rm -r). */
  | { kind: 'dir' }
  /** Uma pasta-pai é link simbólico ou arquivo: escrever ali atravessaria o link. */
  | { kind: 'blocked' }
  /** FIFO, socket, dispositivo: nunca lido nem escrito. */
  | { kind: 'other' }

function lstatOrNull(full: string) {
  return lstatSync(full, { throwIfNoEntry: false })
}

/**
 * O "agora" de um arquivo, lido sem seguir link nenhum. Síncrono: o mesmo
 * código serve à prévia e à reconferência dentro de applyPrepared, então os
 * dois digests nunca divergem por diferença de leitura.
 */
function readNow(top: string, segs: string[]): NowState {
  let dir = top
  for (const seg of segs.slice(0, -1)) {
    dir = join(dir, seg)
    const st = lstatOrNull(dir)
    if (!st) return { kind: 'absent' }
    if (!st.isDirectory()) return { kind: 'blocked' }
  }
  const full = join(dir, segs[segs.length - 1])
  const st = lstatOrNull(full)
  if (!st) return { kind: 'absent' }
  if (st.isSymbolicLink()) return { kind: 'link', target: readlinkSync(full, { encoding: 'buffer' }) }
  if (st.isDirectory()) return { kind: 'dir' }
  if (!st.isFile()) return { kind: 'other' }
  // O git só olha o bit de execução do dono.
  return { kind: 'file', bytes: readFileSync(full), exec: (st.mode & 0o100) !== 0 }
}

function digestOf(mode: string, bytes: Buffer): string {
  return createHash('sha1').update(mode).update('\0').update(bytes).digest('hex')
}

function nowDigest(now: NowState): string | null {
  switch (now.kind) {
    case 'absent': return null
    case 'file': return digestOf(now.exec ? '100755' : '100644', now.bytes)
    case 'link': return digestOf(LINK, now.target)
    default: return now.kind
  }
}

// ---------------------------------------------------------- "antes" e "depois"

interface Side { mode: BlobState['mode']; bytes: Buffer }

/** Bytes de um blob como o checkout os poria no disco. */
async function readSide(repo: RepoInfo, path: string, state: BlobState | null): Promise<Side | null> {
  if (state === null) return null
  const args = state.mode === LINK
    ? ['cat-file', 'blob', state.sha]
    : ['cat-file', '--filters', `--path=${path}`, state.sha]
  const res = await git(repo.top, args)
  return { mode: state.mode, bytes: res.stdout }
}

function sideDigest(side: Side | null): string | null {
  return side === null ? null : digestOf(side.mode, side.bytes)
}

/** Estado de cada caminho num commit (`ls-tree`). Caminho ausente, pasta ou submódulo fica fora do mapa. */
export async function blobStatesAt(repo: RepoInfo, commit: string, paths: string[]): Promise<Map<string, BlobState>> {
  assertHash(commit, 'commit')
  const wanted = new Set(paths)
  const out = new Map<string, BlobState>()
  for (let i = 0; i < paths.length; i += LS_TREE_BATCH) {
    const batch = paths.slice(i, i + LS_TREE_BATCH)
    // -r: um caminho que é pasta no commit lista o que tem dentro, filtrado abaixo.
    const res = await git(repo.top, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...batch])
    for (const rec of splitZ(res.stdout)) {
      // `<modo> SP <tipo> SP <sha> TAB <caminho>`
      const tab = rec.indexOf('\t')
      const [mode, type, sha] = rec.slice(0, tab).split(' ')
      const path = rec.slice(tab + 1)
      if (type !== 'blob' || !MODES.has(mode) || !wanted.has(path)) continue
      out.set(path, { sha, mode: mode as BlobState['mode'] })
    }
  }
  return out
}

// ----------------------------------------------------------- temporários

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'claudinei-restore-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE).includes(0)
}

/**
 * O inverso do turno sobre o "agora": `git merge-file -p <agora> <depois> <antes>`
 * em cópias temporárias. null = não aplica limpo (choque, binário, link,
 * arquivo criado ou apagado no turno, ou o "agora" não é arquivo).
 */
async function inverseMerge(now: NowState, after: Side | null, before: Side | null): Promise<Side | null> {
  if (now.kind !== 'file' || !after || !before || after.mode === LINK || before.mode === LINK) return null
  if (isBinary(now.bytes) || isBinary(after.bytes) || isBinary(before.bytes)) return null
  return withTempDir(async dir => {
    const files = { agora: now.bytes, depois: after.bytes, antes: before.bytes }
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
    const res = await git(dir, [
      'merge-file', '-p', '-L', 'agora', '-L', 'depois', '-L', 'antes', '--',
      join(dir, 'agora'), join(dir, 'depois'), join(dir, 'antes'),
    ], { allowFail: true })
    // >0: número de conflitos; <0 (255): erro, binário.
    if (res.code !== 0) return null
    // O bit de execução também é de três vias: se o turno o mudou e ninguém mexeu depois, volta.
    const nowMode = now.exec ? '100755' : '100644'
    return { mode: nowMode === after.mode ? before.mode : nowMode, bytes: res.stdout }
  })
}

/** Põe um lado numa pasta temporária, como arquivo (com o bit de execução) ou link. */
function materialize(full: string, side: { mode: string; bytes: Buffer }): void {
  mkdirSync(dirname(full), { recursive: true })
  if (side.mode === LINK) symlinkSync(side.bytes, full)
  else {
    writeFileSync(full, side.bytes)
    chmodSync(full, side.mode === '100755' ? 0o755 : 0o644)
  }
}

/**
 * O que mudou desde o turno: diff unificado de "depois" → "agora", com
 * `git diff --no-index` sobre cópias temporárias em `a/<caminho>` e
 * `b/<caminho>` (cabeçalho legível, sem aspas nem octal nos acentos).
 * Nenhum programa do operador roda (diff externo, textconv), e a cor fica
 * desligada. undefined: o "agora" não é arquivo nem link.
 */
async function sinceTurn(path: string, after: Side | null, now: NowState): Promise<{ text: string; truncated: boolean } | undefined> {
  let nowSide: Side | null
  if (now.kind === 'absent') nowSide = null
  else if (now.kind === 'file') nowSide = { mode: now.exec ? '100755' : '100644', bytes: now.bytes }
  else if (now.kind === 'link') nowSide = { mode: LINK, bytes: now.target }
  else return undefined
  return withTempDir(async dir => {
    const a = `a/${path}`
    const b = `b/${path}`
    if (after) materialize(join(dir, a), after)
    if (nowSide) materialize(join(dir, b), nowSide)
    const res = await git(dir, [
      '-c', 'core.quotePath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
      '-U3', '--no-prefix', '--', after ? a : '/dev/null', nowSide ? b : '/dev/null',
    ], { allowFail: true, truncate: { maxLines: DIFF_MAX_LINES }, maxBuffer: DIFF_MAX_BYTES })
    const truncated = res.truncated === true
    // 0: iguais; 1: diferentes. Mais que isso é erro do git.
    if (!truncated && res.code > 1) throw new GitError(['diff', '--no-index'], res.code, res.stderr)
    return { text: res.stdout.toString('utf8'), truncated }
  })
}

// ------------------------------------------------------------ comparações

interface Analysis {
  segs: string[]
  now: NowState
  digest: string | null
  before: Side | null
  after: Side | null
  verdict: RestoreVerdict
}

async function analyze(repo: RepoInfo, item: RestoreItem, segs: string[]): Promise<Analysis> {
  const [before, after] = await Promise.all([readSide(repo, item.path, item.before), readSide(repo, item.path, item.after)])
  const now = readNow(repo.top, segs)
  const digest = nowDigest(now)
  // `already` primeiro: com antes = depois (nada a desfazer), não há o que escrever.
  const verdict: RestoreVerdict = digest === sideDigest(before) ? 'already'
    : digest === sideDigest(after) ? 'revert'
      : 'conflict'
  return { segs, now, digest, before, after, verdict }
}

/** Valida tudo antes de qualquer trabalho: um caminho ruim recusa a lista inteira. */
function validate(items: RestoreItem[]): string[][] {
  return items.map(item => {
    const segs = safeSegments(item.path)
    assertState(item.path, item.before)
    assertState(item.path, item.after)
    return segs
  })
}

async function mapLimit<T, R>(list: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return out
}

/** A prévia: veredito, merge possível, digest do "agora" e o que mudou desde o turno. */
export async function planRestore(repo: RepoInfo, items: RestoreItem[]): Promise<RestorePlanItem[]> {
  const segsList = validate(items)
  return mapLimit(items, CONCURRENCY, async (item, i) => {
    const a = await analyze(repo, item, segsList[i])
    const plan: RestorePlanItem = { path: item.path, verdict: a.verdict, mergeable: false, nowDigest: a.digest }
    if (a.verdict === 'conflict') {
      plan.mergeable = (await inverseMerge(a.now, a.after, a.before)) !== null
      const since = await sinceTurn(item.path, a.after, a.now)
      if (since) {
        plan.sinceTurn = since.text
        if (since.truncated) plan.sinceTurnTruncated = true
      }
    }
    return plan
  })
}

/**
 * Prepara a escrita: relê tudo, confere o "agora" com o digest da prévia
 * (`expected`) e calcula os bytes-alvo. Diferente da prévia, a entrada sai
 * marcada e applyPrepared devolve `changed_since_preview` sem escrever.
 *
 * Decisões: sem decisão, `revert` volta e `conflict` fica (`keep`). `merge`
 * só em conflito com merge limpo; `revert` não vale em conflito (é `force`);
 * `force`/`merge` sobre pasta, caminho bloqueado ou coisa que não é arquivo
 * são recusados. Decisão inválida é erro: nada é preparado.
 */
export async function prepareRestore(
  repo: RepoInfo, items: RestoreItem[], decisions: Record<string, RestoreAction>, expected: Record<string, string | null>,
): Promise<PreparedRestore> {
  const segsList = validate(items)
  for (const item of items) {
    if (!Object.prototype.hasOwnProperty.call(expected, item.path)) throw new Error(`sem o digest da prévia para ${JSON.stringify(item.path)}`)
  }
  const entries = await mapLimit(items, CONCURRENCY, async (item, i): Promise<PreparedEntry> => {
    const a = await analyze(repo, item, segsList[i])
    const base = { path: item.path, segs: a.segs, expected: expected[item.path] }
    if (a.digest !== expected[item.path]) return { ...base, op: { kind: 'none' }, result: 'kept', stale: true }
    const decision = Object.prototype.hasOwnProperty.call(decisions, item.path) ? decisions[item.path] : undefined
    const fail = (why: string): never => { throw new Error(`${why}: ${JSON.stringify(item.path)} (${a.verdict}, ${decision})`) }
    const toBefore = (): PreparedEntry['op'] => a.before ? { kind: 'write', mode: a.before.mode, bytes: a.before.bytes } : { kind: 'delete' }
    if (a.verdict === 'already') return { ...base, op: { kind: 'none' }, result: 'already', stale: false }
    const action = decision ?? (a.verdict === 'revert' ? 'revert' : 'keep')
    if (action === 'keep') return { ...base, op: { kind: 'none' }, result: 'kept', stale: false }
    if (a.verdict === 'revert') {
      if (action === 'merge') fail('merge só vale em conflito')
      if (action !== 'revert' && action !== 'force') fail('decisão desconhecida')
      return { ...base, op: toBefore(), result: action === 'force' ? 'forced' : 'reverted', stale: false }
    }
    // Conflito.
    if (a.now.kind === 'dir' || a.now.kind === 'blocked' || a.now.kind === 'other') fail('só keep cabe aqui: o caminho não é arquivo nem link')
    if (action === 'force') return { ...base, op: toBefore(), result: 'forced', stale: false }
    if (action === 'merge') {
      const merged = await inverseMerge(a.now, a.after, a.before)
      if (!merged) fail('merge sem conflito não é possível')
      return { ...base, op: { kind: 'write', mode: merged!.mode, bytes: merged!.bytes }, result: 'merged', stale: false }
    }
    return fail(action === 'revert' ? 'revert não vale em conflito (use force)' : 'decisão desconhecida')
  })
  return { repo, entries }
}

// ----------------------------------------------------------------- escrita

/** Cria as pastas-pai que faltam, uma por uma, sem atravessar link nem arquivo. */
function ensureParents(top: string, segs: string[]): string {
  let dir = top
  for (const seg of segs.slice(0, -1)) {
    dir = join(dir, seg)
    const st = lstatOrNull(dir)
    if (!st) mkdirSync(dir)
    else if (!st.isDirectory()) throw new Error(`pasta-pai não é pasta: ${dir}`)
  }
  return dir
}

function tempSibling(dir: string): string {
  return join(dir, `.claudinei-restore-${process.pid}-${randomBytes(6).toString('hex')}`)
}

/**
 * Troca a folha pelo alvo: escreve ao lado e faz rename por cima. O rename
 * substitui um link sem segui-lo, e um arquivo com hard link fora do repo
 * não é escrito por dentro (o inode antigo fica com quem o tinha).
 */
function writeLeaf(top: string, segs: string[], now: NowState, mode: BlobState['mode'], bytes: Buffer): void {
  const dir = ensureParents(top, segs)
  const full = join(dir, segs[segs.length - 1])
  const tmp = tempSibling(dir)
  try {
    if (mode === LINK) symlinkSync(bytes, tmp)
    else {
      const exec = mode === '100755'
      // 'wx': cria, nunca abre o que já existe. O umask vale, como no checkout.
      writeFileSync(tmp, bytes, { flag: 'wx', mode: exec ? 0o777 : 0o666 })
      // Arquivo que já existia: guarda as permissões dele e só ajusta o bit de execução.
      const prev = now.kind === 'file' ? lstatOrNull(full) : undefined
      if (prev?.isFile()) {
        const perm = prev.mode & 0o7777
        chmodSync(tmp, exec ? perm | ((perm & 0o444) >> 2) : perm & ~0o111)
      }
    }
    renameSync(tmp, full)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* não chegou a existir */ }
    throw e
  }
}

/**
 * A escrita. SÍNCRONA de propósito: entre a reconferência do disco e a
 * escrita de cada arquivo não cabe nenhum evento do Node (nenhum envio, nenhum
 * outro desfazer). Para cada entrada, relê o "agora" e compara com o digest da
 * prévia; diferente dá `changed_since_preview` e o arquivo não é tocado.
 * Pasta vazia que sobra de um apagado fica. Erro de E/S num arquivo
 * (permissão, disco cheio) vira `failed` com a mensagem, e os outros seguem
 * (R11): quem chama sabe exatamente o que foi escrito.
 */
export function applyPrepared(p: PreparedRestore): AppliedEntry[] {
  const top = p.repo.top
  return p.entries.map((entry): AppliedEntry => {
    if (entry.op.kind === 'none' && entry.result === 'kept' && !entry.stale) return { path: entry.path, result: 'kept' }
    try {
      const now = readNow(top, entry.segs)
      if (entry.stale || nowDigest(now) !== entry.expected) return { path: entry.path, result: 'changed_since_preview' }
      if (entry.op.kind === 'write') writeLeaf(top, entry.segs, now, entry.op.mode, entry.op.bytes)
      else if (entry.op.kind === 'delete' && (now.kind === 'file' || now.kind === 'link')) unlinkSync(join(top, ...entry.segs))
      return { path: entry.path, result: entry.result }
    } catch (e) {
      return { path: entry.path, result: 'failed', error: (e instanceof Error ? e.message : String(e)) || 'erro de E/S' }
    }
  })
}
