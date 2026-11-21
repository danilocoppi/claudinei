import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Db } from '../db.js'
import { git } from '../checkpoint/git.js'
import type { RepoInfo, createRepoResolver } from '../checkpoint/repo.js'
import type { createSerialQueue } from '../checkpoint/serial.js'
import { changedFiles, commitExists, fileDiff } from '../checkpoint/diff.js'
import {
  applyPrepared, blobStatesAt, planRestore, prepareRestore, staleEntries, type BlobState, type RestoreItem,
  type RestorePlanItem,
} from '../checkpoint/restore.js'
import type { SessionManager } from '../claude/manager.js'
import { UserError } from '../user-error.js'
import { attributeTurn, markSide, summarize, UnattributableTurnError } from './attribution.js'
import type { MarkKind, MarkRow, RunFile, RunRow, TurnRow, UndoStore } from './store.js'
import type { UndoCtx } from './types.js'
import type {
  AttributedFile, FileChange, FileClass, FileDiff, PreviewFile, RestoreAction, RestoreResult, TurnDto, UndoPreview,
  UndoRunDto, ViewerFull,
} from '../../../shared/undo.js'

/**
 * O serviço de desfazer e refazer (spec, "Desfazer turno").
 *
 * - **Prévia**: para cada arquivo do turno (ou dos turnos), as três
 *   comparações do restore.ts. `own` sem sobreposição nasce marcado; `uncertain`
 *   nasce desmarcado; `overlapped` (outro terminal declarou o mesmo caminho na
 *   janela do turno) aparece sempre como conflito. Grandes, sem retrato e
 *   submódulos vão para `notUndoable`. O `token` é o sha1 do "agora" de cada
 *   arquivo: o apply recusa (`undo_changed`, com a prévia nova) se mudou.
 * - **Apply**: recusa com bloqueio, turno indisponível ou token velho; segura
 *   o repositório (`holdInput`/`holds`); tira o marco "antes do desfazer";
 *   prepara; reconfere o bloqueio e o "agora" de todos os arquivos e escreve
 *   na mesma seção síncrona (qualquer arquivo mudado: nada escrito,
 *   `undo_changed`); tira o marco "depois"; grava o desfazer, a nota e publica.
 * - **Refazer**: o mesmo, com `antes = pre_mark` e `depois = post_mark`, só nos
 *   arquivos que o desfazer escreveu. Sem nota. Quem não é administrador não
 *   refaz um desfazer com arquivos fora da pasta do projeto (R16).
 *
 * Quem vê o quê: o administrador vê tudo; os outros, só os arquivos dentro da
 * pasta do projeto do terminal. O resto vira `hiddenOutside`, sem nome, e não
 * entra no desfazer deles. O `undo_run` publicado vai a todos que veem o
 * projeto, então leva só os caminhos de dentro (R15).
 *
 * O git do operador fica intocado: aqui só há leitura (`rev-parse`,
 * `symbolic-ref`, `cat-file`, `ls-tree`, `diff-tree`, `diff`); a escrita é a
 * do restore.ts, no disco.
 */

// Os tipos que a web também usa moram em shared/undo.ts.
export type { PreviewFile, UndoPreview, UndoRunDto, ViewerFull } from '../../../shared/undo.js'

/** 409: o "agora" mudou desde a prévia. A rota responde `{ code: 'undo_changed', preview }`. */
export class UndoChangedError extends UserError {
  constructor(readonly preview: UndoPreview) {
    super('undo_changed', 'os arquivos mudaram desde a prévia; confira de novo antes de desfazer')
  }
}

export interface UndoRequest { token: string; decisions: Record<string, RestoreAction> }

export interface UndoServiceDeps {
  db: Db
  store: UndoStore
  resolver: Pick<ReturnType<typeof createRepoResolver>, 'get' | 'peek'>
  /** Não usado: os marcos já passam pela fila no `takeMark`, e o serviço só lê o git. */
  queue?: ReturnType<typeof createSerialQueue>
  manager: Pick<SessionManager, 'list'>
  projects: { get(id: number): { id: number; name: string; path: string } | undefined }
  canSee(viewer: ViewerFull, projectId: number): boolean
  broadcast(m: object): void
  /** O `takeMark` do rastreador: marco na fila do repositório, com os trechos abertos no `active`. */
  takeMark(repo: RepoInfo, kind: MarkKind): Promise<number>
  /** Fim da escrita (bem ou mal): a Task 10 liga ao cutucão do árbitro. */
  onWriteEnd?(repoTop: string): void
  log?(m: string): void
}

const ACTIONS = new Set<RestoreAction>(['revert', 'merge', 'force', 'keep'])
/** Sem retrato do conteúdo: aparecem na prévia, sem desfazer, e o diff vem vazio. */
const NOT_UNDOABLE = new Set<FileChange['status']>(['too_big', 'unsnapshotted', 'submodule'])
/** O "agora" não é arquivo nem link: só `keep` cabe. */
const NOT_A_FILE = new Set(['dir', 'blocked', 'other'])
const WRITTEN = new Set<RestoreResult>(['reverted', 'merged', 'forced'])
/** Projeto fora do topo do repositório: nenhum caminho cai "dentro" dele. */
const NOWHERE = '\0fora'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || 'erro desconhecido'
const sortPaths = <T extends { path: string }>(list: T[]): T[] =>
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

/** O turno como a web o vê. */
export function turnDto(t: TurnRow, lastRun: RunRow | undefined): TurnDto {
  const state: TurnDto['state'] = t.endedAt === null ? 'running'
    : t.snapshot === 'pending' ? 'failed'
      : t.snapshot
  return {
    id: t.id, localId: t.localId, projectId: t.projectId, engine: t.engine, origin: t.origin, key: t.textKey,
    midTurn: t.midTurn, state, ...(t.snapshotError ? { stateReason: t.snapshotError } : {}), limited: t.limited,
    endKind: t.endKind, summary: t.summary, lastRun: lastRun ? { id: lastRun.id, redone: lastRun.redoneAt !== null } : null,
    startedAt: t.startedAt, endedAt: t.endedAt,
  }
}

export function runDto(r: RunRow): UndoRunDto {
  return {
    id: r.id, kind: r.kind, turnIds: r.turnIds, redone: r.redoneAt !== null,
    files: r.files.map(f => ({ path: f.path, result: f.result, ...(f.error ? { error: f.error } : {}) })),
  }
}

/** O desfazer só com os caminhos dentro da pasta do projeto; os de fora viram `hiddenOutside`. */
export function insideRun(run: UndoRunDto, inProject: (path: string) => boolean): UndoRunDto {
  const files = run.files.filter(f => inProject(f.path))
  return { ...run, files, hiddenOutside: run.files.length - files.length }
}

/** O caminho absoluto cai dentro do topo (para pasta que o resolver ainda não viu). */
function underTop(path: string, top: string): boolean {
  const abs = resolve(path)
  return abs === top || abs.startsWith(top + sep)
}

/** O caminho (relativo ao topo) cai na pasta do projeto; a mesma regra da atribuição. */
function inProjectOf(projectRel: string): (path: string) => boolean {
  if (!projectRel) return () => true
  return path => path === projectRel || path.startsWith(`${projectRel}/`)
}

/** Os turnos resolvidos: o repositório, o terminal e a pasta do projeto dentro dele. */
interface Scope {
  turns: TurnRow[]
  /** Marcos de início e fim de cada turno, na ordem de `turns`. */
  marks: Array<{ start: MarkRow; end: MarkRow }>
  repo: RepoInfo
  projectId: number
  engine: string
  localId: string
  projectRel: string
  inProject(path: string): boolean
}

/** Um arquivo da prévia com o que o apply precisa para traduzir a decisão. */
interface Entry { file: PreviewFile; plan: RestorePlanItem; item: RestoreItem }

interface Computed {
  preview: UndoPreview
  entries: Map<string, Entry>
}

export function createUndoService(deps: UndoServiceDeps) {
  const { store, resolver } = deps
  const log = deps.log ?? ((m: string) => console.error(`[undo] ${m}`))
  /** Repositórios com escrita em curso: chave → topo. */
  const held = new Map<string, string>()

  // ── Visibilidade ──

  const sees = (viewer: ViewerFull | null, projectId: number): boolean => viewer === null || deps.canSee(viewer, projectId)
  /** O pedido vê arquivos fora da pasta do projeto. */
  const seesAll = (viewer: ViewerFull | null): boolean => viewer === null || viewer.isAdmin

  function requireProject(viewer: ViewerFull | null, projectId: number): void {
    if (!sees(viewer, projectId)) throw new UserError('forbidden_project', 'sem acesso a este terminal')
  }

  async function projectRelOf(repo: RepoInfo, projectId: number): Promise<string> {
    const p = deps.projects.get(projectId)
    if (!p) return NOWHERE
    const real = await realpath(p.path).catch(() => resolve(p.path))
    const rel = relative(repo.top, real)
    if (!rel) return ''
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return NOWHERE
    return sep === '/' ? rel : rel.split(sep).join('/')
  }

  // ── Turnos e marcos ──

  function lost(turnIds: number[]): never {
    for (const id of turnIds) store.setSnapshot(id, 'lost', 'o retrato sumiu do repositório')
    throw new UserError('snapshot_lost', 'o retrato deste turno sumiu do repositório')
  }

  /**
   * O commit do marco ainda existe? false só quando falta de verdade: o
   * repositório responde (`rev-parse --git-dir`) e uma segunda leitura confirma
   * a falta. Falha do git (tempo esgotado, git ausente, repositório que não
   * responde) dá `snapshot_check_failed`, que se pode tentar de novo, e nada
   * fica gravado como `lost`.
   */
  async function commitPresent(repo: RepoInfo, commit: string): Promise<boolean> {
    const failed = (why: string): UserError =>
      new UserError('snapshot_check_failed', `não deu para conferir o retrato agora; tente de novo (${why})`)
    try {
      if (await commitExists(repo, commit)) return true
      const alive = await git(repo.top, ['rev-parse', '--git-dir'], { allowFail: true })
      if (alive.code !== 0) throw failed(alive.stderr.trim() || 'o repositório não responde')
      return await commitExists(repo, commit)
    } catch (e) {
      if (e instanceof UserError) throw e
      throw failed(errText(e))
    }
  }

  /** O repositório pelo topo gravado; null se a pasta não é mais esse repositório. */
  async function repoAt(top: string, key: string): Promise<RepoInfo | null> {
    const repo = await resolver.get(top).catch(() => null)
    return repo && repo.key === key ? repo : null
  }

  /**
   * Carrega e confere os turnos. `undo`: só o retrato `ok` serve; `view`
   * (arquivos e diff) aceita também o atrasado. Marco cujo commit sumiu grava
   * `lost` e responde `snapshot_lost`.
   */
  async function scopeOf(turnIds: number[], viewer: ViewerFull | null, mode: 'undo' | 'view'): Promise<Scope> {
    const ids = [...new Set(turnIds)]
    if (!ids.length || ids.some(id => !Number.isInteger(id))) throw new UserError('undo_no_turns', 'nenhum turno para desfazer')
    const turns = ids.map(id => {
      const t = store.turn(id)
      if (!t) throw new UserError('undo_turn_not_found', `turno ${id} não encontrado`, { id })
      return t
    })
    for (const t of turns) requireProject(viewer, t.projectId)
    const first = turns[0]
    if (turns.some(t => t.projectId !== first.projectId || t.engine !== first.engine)) {
      throw new UserError('undo_mixed_terminals', 'os turnos são de terminais diferentes')
    }
    if (turns.some(t => t.snapshot === 'lost')) throw new UserError('snapshot_lost', 'o retrato deste turno sumiu do repositório')
    const allowed = mode === 'undo' ? ['ok'] : ['ok', 'late']
    for (const t of turns) {
      const ready = t.endedAt !== null && t.startMark !== null && t.endMark !== null && allowed.includes(t.snapshot)
      if (!ready || !t.repoKey || !t.repoTop) {
        const reason = t.endedAt === null ? 'running' : t.snapshot
        throw new UserError('undo_unavailable', 'este turno não tem ponto de restauração', { reason })
      }
    }
    if (turns.some(t => t.repoKey !== first.repoKey)) throw new UserError('undo_unavailable', 'os turnos são de repositórios diferentes', { reason: 'repo' })
    // Pasta apagada ou que deixou de ser o repositório: sem gravar `lost`
    // (pode ser passageiro, como um disco desmontado).
    const repo = await repoAt(first.repoTop!, first.repoKey!)
    if (!repo) throw new UserError('snapshot_lost', 'o repositório deste turno não foi encontrado')

    const marks = turns.map(t => ({ t, start: store.mark(t.startMark!), end: store.mark(t.endMark!) }))
    const missing = new Set<number>()
    const commits = new Map<string, number[]>()
    for (const { t, start, end } of marks) {
      if (!start || !end || start.repoKey !== repo.key || end.repoKey !== repo.key) {
        missing.add(t.id)
        continue
      }
      for (const c of [start.commitSha, end.commitSha]) commits.set(c, [...commits.get(c) ?? [], t.id])
    }
    for (const [commit, owners] of commits) {
      if (!(await commitPresent(repo, commit))) for (const id of owners) missing.add(id)
    }
    if (missing.size) lost([...missing])

    const projectRel = await projectRelOf(repo, first.projectId)
    // Em ordem na linha do tempo (o início de cada turno).
    const ordered = marks.map(m => ({ t: m.t, start: m.start!, end: m.end! })).sort((a, b) => a.start.n - b.start.n || a.t.id - b.t.id)
    return {
      turns: ordered.map(m => m.t), marks: ordered.map(m => ({ start: m.start, end: m.end })), repo,
      projectId: first.projectId, engine: first.engine, localId: first.localId, projectRel, inProject: inProjectOf(projectRel),
    }
  }

  async function attribute(scope: Scope, i: number): Promise<AttributedFile[]> {
    try {
      return await attributeTurn(scope.repo, store, scope.turns[i], scope.projectRel)
    } catch (e) {
      if (e instanceof UnattributableTurnError) throw new UserError('undo_unavailable', 'este turno não tem ponto de restauração', { reason: 'marks' })
      throw e
    }
  }

  // ── Bloqueio, branch, token ──

  type Blocker = { kind: 'working' | 'in_terminal'; projectId: number }

  /**
   * Alguma sessão de projeto do mesmo repositório trabalhando, ou aberta no
   * terminal interativo. `working` vence `in_terminal`. `sync`: sem esperar o
   * git (seção da escrita); pasta nunca resolvida conta pelo caminho.
   */
  function scanBlockers(repo: RepoInfo, sameRepo: (path: string) => boolean): Blocker | null {
    let found: Blocker | null = null
    for (const s of deps.manager.list()) {
      if (s.status !== 'working' && s.status !== 'in_terminal') continue
      const p = deps.projects.get(s.projectId)
      if (!p || !sameRepo(p.path)) continue
      if (s.status === 'working') return { kind: 'working', projectId: s.projectId }
      found ??= { kind: 'in_terminal', projectId: s.projectId }
    }
    return found
  }

  function syncBlocker(repo: RepoInfo): Blocker | null {
    return scanBlockers(repo, path => {
      const known = resolver.peek(path)
      if (known !== undefined) return known?.key === repo.key
      return underTop(path, repo.top)
    })
  }

  async function blocker(repo: RepoInfo): Promise<Blocker | null> {
    // Resolve antes as pastas das sessões que importam; depois a varredura é síncrona.
    const paths = deps.manager.list()
      .filter(s => s.status === 'working' || s.status === 'in_terminal')
      .map(s => deps.projects.get(s.projectId)?.path)
      .filter((p): p is string => !!p)
    await Promise.all(paths.map(p => resolver.get(p).catch(() => null)))
    return syncBlocker(repo)
  }

  function blockedDto(b: Blocker | null, viewer: ViewerFull | null): UndoPreview['blockedBy'] {
    if (!b) return null
    return { kind: b.kind, terminal: sees(viewer, b.projectId) ? deps.projects.get(b.projectId)?.name ?? null : null }
  }

  function throwBlocked(b: NonNullable<UndoPreview['blockedBy']>): never {
    const { terminal } = b
    throw new UserError('undo_blocked', terminal
      ? `esperando o turno de ${terminal} terminar`
      : 'esperando o turno de outro terminal terminar', { kind: b.kind, terminal: terminal ?? '' })
  }

  async function currentHead(repo: RepoInfo): Promise<{ head: string | null; branch: string | null }> {
    const h = await git(repo.top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true })
    const head = h.code === 0 ? h.stdout.toString('utf8').trim() || null : null
    if (!head) return { head: null, branch: null }
    const b = await git(repo.top, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })
    return { head, branch: b.code === 0 ? b.stdout.toString('utf8').trim() || null : null }
  }

  /** O branch do marco contra o de agora; com HEAD destacado nos dois, compara o commit. */
  async function branchChange(repo: RepoInfo, mark: MarkRow): Promise<UndoPreview['branchChanged']> {
    const now = await currentHead(repo)
    if (mark.branch !== now.branch) return { from: mark.branch, to: now.branch }
    if (mark.branch === null && mark.headSha !== now.head) {
      return { from: mark.headSha?.slice(0, 12) ?? null, to: now.head?.slice(0, 12) ?? null }
    }
    return null
  }

  function tokenOf(files: Array<{ path: string; digest: string | null }>): string {
    const h = createHash('sha1')
    for (const f of files) h.update(JSON.stringify([f.path, f.digest])).update('\n')
    return h.digest('hex')
  }

  // ── A prévia ──

  /** Uma entrada por caminho: classe, de onde volta e a comparação. */
  interface Candidate { change: FileChange; class: FileClass; overlapped: boolean; before: string; after: string }

  async function build(
    repo: RepoInfo, turnIds: number[], candidates: Candidate[], hiddenOutside: number, lastEnd: MarkRow,
    viewer: ViewerFull | null,
  ): Promise<Computed> {
    const notUndoable = sortPaths(candidates.filter(c => NOT_UNDOABLE.has(c.change.status)).map(c => c.change))
    const restorable = sortPaths(candidates.filter(c => !NOT_UNDOABLE.has(c.change.status)).map(c => ({ ...c, path: c.change.path })))

    // O estado de cada caminho nos marcos de antes e depois, um ls-tree por commit.
    const byCommit = new Map<string, string[]>()
    for (const c of restorable) {
      for (const commit of [c.before, c.after]) byCommit.set(commit, [...byCommit.get(commit) ?? [], c.path])
    }
    const states = new Map<string, Map<string, BlobState>>()
    for (const [commit, paths] of byCommit) states.set(commit, await blobStatesAt(repo, commit, [...new Set(paths)]))
    const items: RestoreItem[] = restorable.map(c => ({
      path: c.path, before: states.get(c.before)!.get(c.path) ?? null, after: states.get(c.after)!.get(c.path) ?? null,
    }))
    const plan = await planRestore(repo, items)

    const entries = new Map<string, Entry>()
    const files: PreviewFile[] = restorable.map((c, i) => {
      const p = plan[i]
      // Mesmo arquivo mexido por outro terminal na janela do turno: conflito (spec).
      const verdict = c.overlapped && p.verdict === 'revert' ? 'conflict' : p.verdict
      const file: PreviewFile = {
        path: c.path, class: c.class, verdict,
        mergeable: verdict === 'conflict' && p.verdict === 'conflict' && p.mergeable,
        overlapped: c.overlapped,
        checked: verdict === 'revert' && c.class === 'own',
        ...(p.sinceTurn !== undefined ? { sinceTurn: p.sinceTurn } : {}),
        ...(p.sinceTurnTruncated ? { sinceTurnTruncated: true } : {}),
      }
      entries.set(c.path, { file, plan: p, item: items[i] })
      return file
    })

    const [blocked, branchChanged] = await Promise.all([blocker(repo), branchChange(repo, lastEnd)])
    const preview: UndoPreview = {
      token: tokenOf(plan.map(p => ({ path: p.path, digest: p.nowDigest }))),
      turnIds, blockedBy: blockedDto(blocked, viewer), branchChanged, files, notUndoable, hiddenOutside,
    }
    return { preview, entries }
  }

  /**
   * A prévia de um ou mais turnos do mesmo terminal. Cada arquivo volta ao
   * início do primeiro turno da lista que o mexeu e compara com o fim do
   * último que o mexeu. Incerto em algum turno fica incerto; sobreposto em
   * algum, sobreposto.
   */
  async function computeUndo(turnIds: number[], viewer: ViewerFull | null): Promise<{ scope: Scope; computed: Computed }> {
    const scope = await scopeOf(turnIds, viewer, 'undo')
    const byPath = new Map<string, Candidate>()
    const hidden = new Set<string>()
    for (let i = 0; i < scope.turns.length; i++) {
      for (const f of await attribute(scope, i)) {
        if (!seesAll(viewer) && !f.inProject) {
          hidden.add(f.path)
          continue
        }
        const { class: cls, overlapped, inProject: _, ...change } = f
        const prev = byPath.get(f.path)
        const { start, end } = scope.marks[i]
        if (!prev) {
          byPath.set(f.path, { change, class: cls, overlapped, before: start.commitSha, after: end.commitSha })
          continue
        }
        prev.after = end.commitSha
        if (cls === 'uncertain') prev.class = 'uncertain'
        prev.overlapped ||= overlapped
        // Sem retrato em algum turno: sem desfazer no conjunto.
        if (NOT_UNDOABLE.has(change.status) || !NOT_UNDOABLE.has(prev.change.status)) prev.change = change
      }
    }
    const lastEnd = scope.marks.reduce((a, m) => (m.end.n > a.n ? m.end : a), scope.marks[0].end)
    const ids = scope.turns.map(t => t.id)
    return { scope, computed: await build(scope.repo, ids, [...byPath.values()], hidden.size, lastEnd, viewer) }
  }

  /** O desfazer que se pode refazer, com os dois marcos. */
  async function redoScope(runId: number, viewer: ViewerFull | null) {
    const run = store.run(runId)
    if (!run) throw new UserError('undo_run_not_found', `desfazer ${runId} não encontrado`, { id: runId })
    requireProject(viewer, run.projectId)
    if (run.kind !== 'undo') throw new UserError('undo_not_redoable', 'só um desfazer pode ser refeito')
    if (run.redoneAt !== null) throw new UserError('undo_already_redone', 'este desfazer já foi refeito')
    const pre = run.preMark === null ? undefined : store.mark(run.preMark)
    const post = run.postMark === null ? undefined : store.mark(run.postMark)
    if (!pre || !post || pre.repoKey !== run.repoKey || post.repoKey !== run.repoKey) {
      throw new UserError('snapshot_lost', 'o retrato do desfazer sumiu', { reason: 'marks' })
    }
    const repo = await repoAt(pre.repoTop, run.repoKey)
    if (!repo) throw new UserError('snapshot_lost', 'o repositório deste desfazer não foi encontrado')
    for (const c of [pre.commitSha, post.commitSha]) {
      if (!(await commitPresent(repo, c))) throw new UserError('snapshot_lost', 'o retrato do desfazer sumiu do repositório')
    }
    const inProject = inProjectOf(await projectRelOf(repo, run.projectId))
    return { run, pre, post, repo, inProject }
  }

  async function computeRedo(runId: number, viewer: ViewerFull | null) {
    const s = await redoScope(runId, viewer)
    const written = new Set(s.run.files.filter(f => WRITTEN.has(f.result)).map(f => f.path))
    // R16: refazer só a parte visível deixaria os arquivos de fora desfeitos e
    // gastaria o Refazer do administrador. Quem não é administrador pede a ele.
    if (!seesAll(viewer) && [...written].some(p => !s.inProject(p))) {
      throw new UserError('redo_hidden_files', 'este desfazer mexeu em arquivos fora da pasta do projeto; só o administrador pode refazê-lo')
    }
    // O diff do próprio desfazer diz o que tem retrato (grandes e soltos do modo limitado não têm).
    const changes = written.size
      ? (await changedFiles(s.repo, markSide(store, s.pre), markSide(store, s.post))).filter(c => written.has(c.path))
      : []
    const candidates: Candidate[] = changes.map(change => ({
      change, class: 'own', overlapped: false, before: s.pre.commitSha, after: s.post.commitSha,
    }))
    const computed = await build(s.repo, s.run.turnIds, candidates, 0, s.post, viewer)
    return { ...s, computed }
  }

  // ── Decisões ──

  /**
   * Traduz as decisões do operador para o prepareRestore. Sem decisão: o
   * marcado volta, o resto fica. Incerto marcado = decisão explícita. Conflito
   * (inclusive o sobreposto): `force`, `merge` (só se mergeable) ou `keep`.
   * Já como antes (`already`): nada a escrever; `keep` e `revert` (o "marcar
   * tudo" da tela pode mandá-lo) passam sem efeito, `force`/`merge` são recusados.
   */
  function translate(entries: Map<string, Entry>, decisions: unknown): Record<string, RestoreAction> {
    if (decisions === null || typeof decisions !== 'object' || Array.isArray(decisions)) {
      throw new UserError('undo_bad_decision', 'decisões inválidas')
    }
    const given = decisions as Record<string, unknown>
    const bad = (path: string, action: unknown): never => {
      throw new UserError('undo_bad_decision', `decisão inválida para ${path}: ${String(action)}`, { path, action: String(action) })
    }
    for (const [path, action] of Object.entries(given)) {
      if (!entries.has(path)) bad(path, action)
      if (typeof action !== 'string' || !ACTIONS.has(action as RestoreAction)) bad(path, action)
    }
    const out: Record<string, RestoreAction> = {}
    for (const [path, { file, plan }] of entries) {
      const d = Object.prototype.hasOwnProperty.call(given, path) ? given[path] as RestoreAction : undefined
      if (plan.verdict === 'already') {
        if (d === 'force' || d === 'merge') bad(path, d)
        out[path] = 'keep'
        continue
      }
      if (d === undefined) {
        out[path] = file.checked ? 'revert' : 'keep'
        continue
      }
      if (d === 'keep') {
        out[path] = 'keep'
        continue
      }
      if (file.verdict === 'revert') {
        if (d === 'merge') bad(path, d)
        out[path] = d
        continue
      }
      // Conflito na tela.
      if (d === 'revert' || NOT_A_FILE.has(plan.nowDigest ?? '')) bad(path, d)
      if (d === 'merge' && !file.mergeable) bad(path, d)
      out[path] = d
    }
    return out
  }

  // ── A escrita ──

  /**
   * Passos 2 a 8 do apply: segura o repositório, marco antes, preparo,
   * reconferência e escrita síncronas, marco depois, desfazer gravado, nota e
   * publicação. `onWriteEnd` sempre, inclusive se falhar no meio.
   */
  async function write(o: {
    repo: RepoInfo; viewer: ViewerFull | null; computed: Computed; req: UndoRequest
    /** A pasta do projeto do terminal: o `undo_run` publicado só leva o que cai nela. */
    inProject: (path: string) => boolean
    recompute: () => Promise<Computed>
    record: (files: RunFile[], preMark: number, postMark: number | null) => RunRow
  }): Promise<UndoRunDto> {
    const { repo, computed } = o
    if (computed.preview.blockedBy) throwBlocked(computed.preview.blockedBy)
    if (!o.req || o.req.token !== computed.preview.token) throw new UndoChangedError(computed.preview)
    const decisions = translate(computed.entries, o.req.decisions ?? {})
    if (held.has(repo.key)) throw new UserError('undo_writing', 'o Claudinei já está desfazendo arquivos nesta pasta')

    held.set(repo.key, repo.top)
    try {
      let preMark: number
      try {
        preMark = await deps.takeMark(repo, 'undo_pre')
      } catch (e) {
        throw new UserError('undo_snapshot_failed', `não deu para tirar o marco antes do desfazer: ${errText(e)}`)
      }
      const entries = [...computed.entries.values()]
      const expected = Object.fromEntries(entries.map(e => [e.item.path, e.plan.nowDigest]))
      const prepared = await prepareRestore(repo, entries.map(e => e.item), decisions, expected)

      // Seção síncrona: nenhum evento do Node entre as reconferências e a escrita.
      const late = syncBlocker(repo)
      if (late) throwBlocked(blockedDto(late, o.viewer)!)
      // Algum arquivo mudou desde a prévia (antes ou depois do preparo): nada
      // escrito. Solta o repositório e só então recalcula a prévia (await).
      if (staleEntries(prepared).length) {
        held.delete(repo.key)
        throw new UndoChangedError((await o.recompute()).preview)
      }
      // A reconferência por arquivo dentro de applyPrepared fica como última
      // defesa (changed_since_preview): aqui já não há fresta para ela.
      const results = applyPrepared(prepared)

      let postMark: number | null = null
      try {
        postMark = await deps.takeMark(repo, 'undo_post')
      } catch (e) {
        log(`marco depois do desfazer em ${repo.top} falhou: ${errText(e)}`)
      }
      held.delete(repo.key)
      const files: RunFile[] = results.map(r => ({ path: r.path, result: r.result, ...(r.error ? { error: r.error } : {}) }))
      const row = o.record(files, preMark, postMark)
      const run = runDto(row)
      // R15: vai a todos que veem o projeto, então só os caminhos de dentro.
      const inside = insideRun(run, o.inProject)
      deps.broadcast({ type: 'undo_run', projectId: row.projectId, engine: row.engine, run: inside })
      return seesAll(o.viewer) ? run : inside
    } finally {
      held.delete(repo.key)
      try { deps.onWriteEnd?.(repo.top) } catch (e) { log(`onWriteEnd: ${errText(e)}`) }
    }
  }

  /**
   * O repositório da pasta do projeto está em escrita. Pasta que o resolver
   * nunca viu conta pelo prefixo do caminho, como no syncBlocker: um projeto
   * irmão do mesmo repositório ainda não resolvido também fica segurado.
   */
  function heldFor(projectId: number): boolean {
    if (!held.size) return false
    const p = deps.projects.get(projectId)
    if (!p) return false
    const known = resolver.peek(p.path)
    if (known !== undefined) return !!known && held.has(known.key)
    for (const top of held.values()) if (underTop(p.path, top)) return true
    return false
  }

  // ── Leitura ──

  async function turnFiles(turnId: number, viewer: ViewerFull): Promise<{ files: AttributedFile[]; hiddenOutside: number }> {
    const scope = await scopeOf([turnId], viewer, 'view')
    const all = await attribute(scope, 0)
    if (seesAll(viewer)) return { files: all, hiddenOutside: 0 }
    const files = all.filter(f => f.inProject)
    return { files, hiddenOutside: all.length - files.length }
  }

  return {
    /** Grava o resumo (visão da pasta do projeto) e publica `undo_turn`. Nunca rejeita. */
    async summarizeTurn(turnId: number): Promise<void> {
      try {
        const t = store.turn(turnId)
        if (!t) return
        if (t.endedAt !== null && (t.snapshot === 'ok' || t.snapshot === 'late') && t.startMark !== null && t.endMark !== null) {
          try {
            const scope = await scopeOf([turnId], null, 'view')
            store.setSummary(turnId, summarize(await attribute(scope, 0), { isAdmin: false }))
          } catch (e) {
            // Retrato perdido já ficou gravado; o turno sai sem resumo.
            if (!(e instanceof UserError) || e.code === 'snapshot_check_failed') log(`resumo do turno ${turnId}: ${errText(e)}`)
          }
        }
        const fresh = store.turn(turnId)!
        deps.broadcast({
          type: 'undo_turn', projectId: fresh.projectId, localId: fresh.localId, engine: fresh.engine,
          turn: turnDto(fresh, store.lastRunFor(turnId)),
        })
      } catch (e) {
        log(`resumo do turno ${turnId}: ${errText(e)}`)
      }
    },

    turnFiles,

    /**
     * O diff de um arquivo do turno. Fora da pasta do projeto, para quem não é
     * administrador: `forbidden_path`. Grande, sem retrato ou submódulo: diff
     * sem texto (a tela mostra o selo).
     */
    async turnDiff(turnId: number, path: string, viewer: ViewerFull): Promise<FileDiff> {
      const scope = await scopeOf([turnId], viewer, 'view')
      if (typeof path !== 'string' || !path) throw new UserError('undo_path_not_in_turn', 'arquivo fora do turno')
      if (!seesAll(viewer) && !scope.inProject(path)) throw new UserError('forbidden_path', 'arquivo fora da pasta do projeto')
      const file = (await attribute(scope, 0)).find(f => f.path === path)
      if (!file) throw new UserError('undo_path_not_in_turn', 'arquivo fora do turno', { path })
      if (NOT_UNDOABLE.has(file.status)) return { path, binary: false, text: '', truncated: false }
      return fileDiff(scope.repo, scope.marks[0].start.commitSha, scope.marks[0].end.commitSha, path)
    },

    async preview(turnIds: number[], viewer: ViewerFull): Promise<UndoPreview> {
      return (await computeUndo(turnIds, viewer)).computed.preview
    },

    async apply(turnIds: number[], req: UndoRequest, viewer: ViewerFull, opts: { note?: boolean } = {}): Promise<UndoRunDto> {
      const { scope, computed } = await computeUndo(turnIds, viewer)
      const ids = scope.turns.map(t => t.id)
      // O desfazer e a nota juntos: um sem o outro deixaria o agente sem saber.
      const recordUndo = deps.db.transaction((files: RunFile[], preMark: number, postMark: number | null): number => {
        const id = store.insertRun({
          projectId: scope.projectId, engine: scope.engine, kind: 'undo', turnIds: ids, repoKey: scope.repo.key,
          preMark, postMark, files,
        })
        const reverted = files.filter(f => WRITTEN.has(f.result)).map(f => f.path)
        if (opts.note !== false && reverted.length) store.addNote(scope.projectId, scope.engine, reverted)
        return id
      })
      return write({
        repo: scope.repo, viewer, computed, req, inProject: scope.inProject,
        recompute: async () => (await computeUndo(turnIds, viewer)).computed,
        record: (files, preMark, postMark) => store.run(recordUndo(files, preMark, postMark))!,
      })
    },

    async previewRedo(runId: number, viewer: ViewerFull): Promise<UndoPreview> {
      return (await computeRedo(runId, viewer)).computed.preview
    },

    async redo(runId: number, req: UndoRequest, viewer: ViewerFull): Promise<UndoRunDto> {
      const s = await computeRedo(runId, viewer)
      const recordRedo = deps.db.transaction((files: RunFile[], preMark: number, postMark: number | null): number => {
        const id = store.insertRun({
          projectId: s.run.projectId, engine: s.run.engine, kind: 'redo', turnIds: s.run.turnIds, repoKey: s.repo.key,
          preMark, postMark, files, redoOf: s.run.id,
        })
        store.setRedone(s.run.id)
        return id
      })
      return write({
        repo: s.repo, viewer, computed: s.computed, req, inProject: s.inProject,
        recompute: async () => (await computeRedo(runId, viewer)).computed,
        record: (files, preMark, postMark) => {
          const id = recordRedo(files, preMark, postMark)
          // Sem nota: e a que espera do desfazer perde o que voltou (o agente
          // nunca soube que esses arquivos saíram).
          const back = new Set(files.filter(f => WRITTEN.has(f.result)).map(f => f.path))
          const pending = store.takeNote(s.run.projectId, s.run.engine)
          const rest = pending?.filter(p => !back.has(p)) ?? []
          if (rest.length) store.addNote(s.run.projectId, s.run.engine, rest)
          return store.run(id)!
        },
      })
    },

    /** Para o rastreador: mensagem em repositório com escrita em curso é recusada. */
    holdInput(ctx: UndoCtx): void {
      if (heldFor(ctx.projectId)) {
        throw new UserError('undo_writing', 'o Claudinei está desfazendo arquivos nesta pasta; tente de novo em alguns segundos')
      }
    },

    /** Para o árbitro: o repositório do terminal está em escrita. O motor não muda nada (a unidade é o repositório). */
    holds(projectId: number, _engine: string): boolean {
      return heldFor(projectId)
    },
  }
}

export type UndoService = ReturnType<typeof createUndoService>
