import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { git } from '../checkpoint/git.js'
import { createRepoResolver, type RepoInfo } from '../checkpoint/repo.js'
import { createSerialQueue } from '../checkpoint/serial.js'
import { changedFiles, commitExists } from '../checkpoint/diff.js'
import { UserError } from '../user-error.js'
import { listIntervals, markSide } from './attribution.js'
import { runRetention } from './retention.js'
import { changeDiff, errText, inProjectOf, projectRelOf, underTop } from './scope.js'
import { createUndoService, turnDto } from './service.js'
import { createUndoStore, type MarkRow, type TurnRow } from './store.js'
import { createTurnTracker } from './tracker.js'
import type { TurnObserver } from './types.js'
import type {
  AttributedFile, ChangedFilesDto, FileDiff, IntervalDto, TerminalTurnsDto, ViewerFull,
} from '../../../shared/undo.js'

/**
 * O conjunto do desfazer turno, montado num lugar só: store, fila por
 * repositório, rastreador de turnos, serviço (prévia, desfazer, refazer) e
 * retenção. O app cria um por processo; index.ts liga o rastreador ao manager
 * (`observerOf`), roda a subida (`boot`) antes de religar as sessões e a
 * retenção a cada 24 h.
 */

export interface UndoDeps {
  db: Db
  manager: Pick<SessionManager, 'list'>
  projects: { get(id: number): { id: number; name: string; path: string } | undefined }
  broadcast(m: object): void
  /** A escrita de um desfazer terminou: cutuca o árbitro de cada terminal do repositório. */
  poke?(projectId: number, engine: string): void
  log?(m: string): void
}

/** Quem pede vê o projeto: o administrador vê tudo. */
export function viewerCanSee(v: ViewerFull, projectId: number): boolean {
  return v.isAdmin || v.projectIds === 'all' || v.projectIds.includes(projectId)
}

/** Até quantos intervalos "entre turnos" a rota lista. */
const INTERVALS_MAX = 50
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** Avisos dos marcos: `limited` se algum dos dois é limitado. */
const markWarnings = (...marks: MarkRow[]): string[] => (marks.some(m => m.mode === 'limited') ? ['limited'] : [])

function turnWarnings(t: TurnRow): string[] {
  const out: string[] = []
  if (t.snapshot === 'late') out.push('late')
  if (t.limited) out.push('limited')
  if (t.endKind === 'uncertain') out.push('uncertain_end')
  return out
}

export function createUndo(deps: UndoDeps) {
  const log = deps.log ?? ((m: string) => console.error(`[undo] ${m}`))
  const store = createUndoStore(deps.db)
  const resolver = createRepoResolver()
  const queue = createSerialQueue()

  /** Os terminais (projeto + motor) com sessão cuja pasta cai no repositório de topo `top`. */
  function terminalsOf(top: string): Array<{ projectId: number; engine: string }> {
    const found = new Map<string, { projectId: number; engine: string }>()
    for (const s of deps.manager.list()) {
      const p = deps.projects.get(s.projectId)
      if (!p) continue
      const known = resolver.peek(p.path)
      const same = known !== undefined ? !!known && known.top === top : underTop(p.path, top)
      if (same) found.set(`${s.projectId}\0${s.engine}`, { projectId: s.projectId, engine: s.engine })
    }
    return [...found.values()]
  }

  // O serviço e o rastreador se chamam: o rastreador recusa mensagem durante a
  // escrita (holdInput) e publica o resumo no fim do turno; o serviço tira os
  // marcos do desfazer pela fila do rastreador.
  let service: ReturnType<typeof createUndoService>
  const tracker = createTurnTracker({
    store, resolver, queue,
    projectPath: id => deps.projects.get(id)?.path ?? null,
    holdInput: ctx => service.holdInput(ctx),
    onTurnClosed: id => { void service.summarizeTurn(id) },
    log,
  })
  service = createUndoService({
    db: deps.db, store, resolver, queue, manager: deps.manager, projects: deps.projects,
    canSee: viewerCanSee, broadcast: m => deps.broadcast(m),
    // Lido na hora: quem envolve o takeMark do rastreador (testes) é respeitado.
    takeMark: (repo, kind) => tracker.takeMark(repo, kind),
    // Fora da pilha da escrita: o árbitro reconfere a sessão por conta própria.
    onWriteEnd: top => queueMicrotask(() => {
      try {
        for (const t of terminalsOf(top)) deps.poke?.(t.projectId, t.engine)
      } catch (e) {
        log(`cutucar os terminais de ${top}: ${errText(e)}`)
      }
    }),
    log,
  })

  // ── Retenção ──

  let retaining: Promise<{ turns: number; marks: number }> | null = null

  /** Uma passada por vez; falha só no log. */
  function retain(): Promise<{ turns: number; marks: number }> {
    if (retaining) return retaining
    const run = runRetention({ store, db: deps.db, resolver, queue, log })
      .catch((e) => {
        log(`retenção falhou: ${errText(e)}`)
        return { turns: 0, marks: 0 }
      })
      .finally(() => { if (retaining === run) retaining = null })
    retaining = run
    return run
  }

  // ── Intervalos ──

  /** A árvore de cada commit num `rev-parse` só; um por um se algum sumiu. Commit sem árvore: null. */
  async function treesOf(repo: RepoInfo, commits: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    const valid = [...new Set(commits)].filter(c => HASH.test(c))
    if (!valid.length) return out
    const res = await git(repo.top, ['rev-parse', ...valid.map(c => `${c}^{tree}`)], { allowFail: true })
    const lines = res.stdout.toString('utf8').split('\n').filter(Boolean)
    if (res.code === 0 && lines.length === valid.length) {
      valid.forEach((c, i) => out.set(c, lines[i]))
      return out
    }
    for (const c of valid) {
      const one = await git(repo.top, ['rev-parse', '-q', '--verify', `${c}^{tree}`], { allowFail: true })
      out.set(c, one.code === 0 ? one.stdout.toString('utf8').trim() : null)
    }
    return out
  }

  /** Os intervalos fora de turno que mudaram algo (R17): árvores diferentes, ou grandes/soltos diferentes. */
  async function changedIntervals(repo: RepoInfo): Promise<IntervalDto[]> {
    const list = listIntervals(store, repo.key, INTERVALS_MAX)
    if (!list.length) return []
    const trees = await treesOf(repo, list.flatMap(iv => [iv.from.commitSha, iv.to.commitSha]))
    return list
      .filter(({ from, to }) => {
        const a = trees.get(from.commitSha)
        const b = trees.get(to.commitSha)
        if (!a || !b) return false
        return a !== b || from.listingHash !== to.listingHash || JSON.stringify(from.big) !== JSON.stringify(to.big)
      })
      .map(({ from, to, kind }) => ({ from: from.id, to: to.id, kind, at: to.createdAt }))
  }

  /** O intervalo pedido a partir de um terminal: os dois marcos do repositório da pasta do projeto. */
  async function intervalScope(fromId: number, toId: number, projectId: number) {
    const missing = (): UserError => new UserError('undo_interval_not_found', 'intervalo não encontrado')
    const from = store.mark(fromId)
    const to = store.mark(toId)
    if (!from || !to || from.repoKey !== to.repoKey || from.n >= to.n) throw missing()
    const p = deps.projects.get(projectId)
    const repo = p ? await resolver.get(p.path) : null
    if (!p || !repo || repo.key !== from.repoKey) throw missing()
    for (const c of [from.commitSha, to.commitSha]) {
      if (!(await commitExists(repo, c))) throw new UserError('snapshot_lost', 'o retrato deste intervalo sumiu do repositório')
    }
    const inProject = inProjectOf(await projectRelOf(repo, p.path))
    const changes = await changedFiles(repo, markSide(store, from), markSide(store, to))
    return { repo, from, to, inProject, changes }
  }

  return {
    store, resolver, queue, tracker, service,

    /** Subida: fecha os turnos que ficaram abertos (fim incerto) e solta a retenção em segundo plano. */
    async boot(): Promise<void> {
      await tracker.boot()
      void retain()
    },

    retain,

    /** Espera o rastreador e a retenção em curso (testes e encerramento). */
    async idle(): Promise<void> {
      await tracker.idle()
      if (retaining) await retaining
    },

    /** Para o árbitro: o repositório do terminal está em escrita. */
    holds(projectId: number, engine: string): boolean {
      return service.holds(projectId, engine)
    },

    /**
     * Os turnos do terminal (R2): `turns` são os não interativos, não voltados e
     * da conversa atual (ou sem conversa registrada); `outside`, os demais não
     * interativos; `interactive` à parte. Mais os intervalos que mudaram algo.
     */
    async terminalTurns(t: { projectId: number; engine: string; engineSessionId: string | null }): Promise<TerminalTurnsDto> {
      const p = deps.projects.get(t.projectId)
      const repo = p ? await resolver.get(p.path).catch(() => null) : null
      const out: TerminalTurnsDto = { git: !!repo, turns: [], outside: [], interactive: [], intervals: [] }
      for (const row of store.terminalTurns(t.projectId, t.engine)) {
        const dto = turnDto(row, store.lastRunFor(row.id))
        if (row.origin === 'interactive') out.interactive.push(dto)
        else if (row.rewoundAt === null && (row.conversationId === null || row.conversationId === t.engineSessionId)) out.turns.push(dto)
        else out.outside.push(dto)
      }
      if (repo) {
        try {
          out.intervals = await changedIntervals(repo)
        } catch (e) {
          log(`intervalos de ${repo.top}: ${errText(e)}`)
        }
      }
      return out
    },

    async turnFiles(turnId: number, viewer: ViewerFull): Promise<ChangedFilesDto> {
      const r = await service.turnFiles(turnId, viewer)
      const t = store.turn(turnId)
      return { ...r, warnings: t ? turnWarnings(t) : [] }
    },

    async intervalFiles(fromId: number, toId: number, projectId: number, viewer: ViewerFull): Promise<ChangedFilesDto> {
      const s = await intervalScope(fromId, toId, projectId)
      // Fora de turno: ninguém é dono.
      const all: AttributedFile[] = s.changes.map(c => ({ ...c, class: 'uncertain', overlapped: false, inProject: s.inProject(c.path) }))
      const files = viewer.isAdmin ? all : all.filter(f => f.inProject)
      return { files, hiddenOutside: all.length - files.length, warnings: markWarnings(s.from, s.to) }
    },

    async intervalDiff(fromId: number, toId: number, projectId: number, path: string, viewer: ViewerFull): Promise<FileDiff> {
      if (typeof path !== 'string' || !path) throw new UserError('undo_path_not_in_turn', 'arquivo fora do intervalo')
      const s = await intervalScope(fromId, toId, projectId)
      if (!viewer.isAdmin && !s.inProject(path)) throw new UserError('forbidden_path', 'arquivo fora da pasta do projeto')
      const file = s.changes.find(c => c.path === path)
      if (!file) throw new UserError('undo_path_not_in_turn', 'arquivo fora do intervalo', { path })
      return changeDiff(s.repo, file, s.from.commitSha, s.to.commitSha)
    },
  }
}

export type Undo = ReturnType<typeof createUndo>

/**
 * O observador que index.ts passa ao manager, que nasce antes do app: lê o
 * conjunto do desfazer na hora de cada aviso. Antes de ele existir, a mensagem
 * sai sem passar por ele.
 */
export function observerOf(get: () => Undo | undefined): TurnObserver {
  return {
    onInput(ctx, text, origin, send) {
      const undo = get()
      if (undo) undo.tracker.onInput(ctx, text, origin, send)
      else send(text)
    },
    onStatus: (ctx, status, info) => get()?.tracker.onStatus(ctx, status, info),
    onEvent: (ctx, event) => get()?.tracker.onEvent(ctx, event),
    onInteractive: (ctx, phase) => get()?.tracker.onInteractive(ctx, phase),
  }
}
