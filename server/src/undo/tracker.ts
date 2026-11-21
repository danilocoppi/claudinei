import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { takeSnapshot, type SNAPSHOT_LIMITS } from '../checkpoint/snapshot.js'
import type { RepoInfo, createRepoResolver } from '../checkpoint/repo.js'
import type { createSerialQueue } from '../checkpoint/serial.js'
import { filesRevertedNote, turnKey, withNote, type EndKind, type TurnOrigin } from '../../../shared/undo.js'
import { declaredPaths } from './declared.js'
import type { MarkKind, TurnRow, UndoStore } from './store.js'
import type { TurnObserver, UndoCtx } from './types.js'

/**
 * O rastreador de turnos: transforma os avisos do manager (mensagem, status,
 * evento, terminal interativo) em turnos e marcos do desfazer.
 *
 * Um **trecho** é o turno para os arquivos: cada mensagem abre um. Mensagem que
 * entra com o trecho aberto fecha o anterior e abre o seguinte num marco só.
 *
 * No caminho síncrono (o do envio) só há gravação no SQLite e contas em
 * memória. O git roda depois, na fila única do repositório; os marcos saem na
 * ordem em que foram pedidos, e o `active` de cada um é calculado no pedido.
 */

interface Segment {
  turnId: number
  localId: string
  projectPath: string | null
  interactive: boolean
  /** undefined: a pasta ainda não foi resolvida; null: sem git. */
  repo: RepoInfo | null | undefined
  /** Resolve quando `repo` fica conhecido (já com `repo` preenchido). */
  ready: Promise<RepoInfo | null>
  /** O marco de início terminou (bem ou mal); antes disso, ferramenta = retrato atrasado. */
  startDone: boolean
  late: boolean
  /** A sessão esteve em working com o trecho aberto: só então idle/needs_attention o fecham. */
  sawWorking: boolean
  /** Fim pelo último `result` visto no trecho. */
  result: EndKind | null
  /** Gravação dos caminhos declarados em curso; o fim espera por ela. */
  declaring: Promise<void>
}

interface Closing { seg: Segment; end: Promise<EndKind>; conversation: string | null }

/** Um pedido de marco: abre um trecho, fecha outro, ou os dois no mesmo marco. */
interface MarkRequest { kind: MarkKind; opens?: Segment; closes?: Closing }

const EXITS = new Set(['idle', 'needs_attention', 'dead', 'stopped'])
const GOAL_PREFIX = '[Claudinei: goal'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || 'erro desconhecido'

/** O resultado do motor como fim de turno. */
function resultKind(subtype: string): EndKind {
  return subtype === 'interrupted' || subtype === 'error_during_execution' ? 'interrupted' : 'result'
}

/** Caminho relativo a `base`, com `/`; null se cai fora dela. */
function toRel(base: string, abs: string): string | null {
  const r = relative(base, abs)
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return null
  return sep === '/' ? r : r.split(sep).join('/')
}

export function createTurnTracker(deps: {
  store: UndoStore
  resolver: ReturnType<typeof createRepoResolver>
  queue: ReturnType<typeof createSerialQueue>
  projectPath(projectId: number): string | null
  /** Lança UserError('undo_writing') durante a escrita de um desfazer no repo. */
  holdInput?(ctx: UndoCtx): void
  onTurnOpened?(turnId: number): void
  /** Depois de o marco de fim (ou o fim sem marco) estar gravado. */
  onTurnClosed?(turnId: number): void
  log?(m: string): void
  /** Só para testes: os limites do retrato. */
  snapshotLimits?: typeof SNAPSHOT_LIMITS
}) {
  const { store, resolver, queue } = deps
  const log = deps.log ?? ((m: string) => console.error(`[undo] ${m}`))

  /** O trecho aberto de cada sessão. */
  const open = new Map<string, Segment>()
  /** O trecho que saiu de working e espera a microtask que decide o fim. */
  const closing = new Map<string, Segment>()
  /** O trecho mais recente de cada sessão (aberto ou não), para encadear a resolução. */
  const lastSeg = new Map<string, Segment>()
  const lastStatus = new Map<string, string>()
  const lastConversation = new Map<string, string>()
  const realProjects = new Map<string, Promise<string>>()
  /** Último pedido de marco à espera de uma pasta ser resolvida. */
  let deferred: Promise<void> | null = null
  /** Tudo o que roda fora do caminho síncrono, para o idle(). */
  const inflight = new Set<Promise<void>>()

  function track(p: Promise<unknown>, what?: string): void {
    const settled = p.then(() => {}, (e) => { if (what) log(`${what}: ${errText(e)}`) })
    inflight.add(settled)
    void settled.then(() => inflight.delete(settled))
  }

  function safe(what: string, fn: () => void): void {
    try { fn() } catch (e) { log(`${what}: ${errText(e)}`) }
  }

  /** Os trechos abertos agora, com o pedido aplicado. */
  function openNow(plus?: Segment, minus?: Segment): Segment[] {
    const segs = new Set(open.values())
    if (plus) segs.add(plus)
    if (minus) segs.delete(minus)
    return [...segs]
  }

  /**
   * Ids, entre `segs` (os abertos na hora do pedido), dos trechos do
   * repositório. Trecho de pasta ainda não resolvida só conta se é da mesma
   * pasta de `self` (vai resolver no mesmo repositório).
   */
  function activeIds(key: string, segs: Segment[], self?: Segment): number[] {
    return segs
      .filter(s => s.repo === undefined ? !!self && s.projectPath === self.projectPath : s.repo?.key === key)
      .map(s => s.turnId)
      .sort((a, b) => a - b)
  }

  // ── Marcos ──

  async function writeMark(repo: RepoInfo, kind: MarkKind, active: number[]): Promise<{ id: number; limited: boolean }> {
    // O que se sabe dos soltos no marco anterior (só pesa no modo limitado).
    const prev = store.latestMarks(repo.key, 1)[0]
    const previousListing = !prev ? null
      : prev.mode === 'full' ? 'full' as const
      : prev.listingHash ? store.listing(prev.listingHash) : null
    const n = store.nextMarkN(repo.key)
    const snap = await takeSnapshot(repo, n, { previousListing, limits: deps.snapshotLimits })
    const listingHash = snap.listing ? store.putListing(snap.listing) : null
    const id = store.insertMark({
      repoKey: repo.key, n, repoTop: repo.top, ref: snap.ref, commitSha: snap.commit, headSha: snap.head,
      branch: snap.branch, mode: snap.mode, kind, active, big: snap.big, listingHash,
    })
    return { id, limited: snap.mode === 'limited' }
  }

  /** Marco de fim que falhou: o turno fica sem ponto de restauração, com o motivo. */
  function failSnapshot(turnId: number, error: string): void {
    const t = store.turn(turnId)
    if (t && (t.snapshot === 'ok' || t.snapshot === 'late' || t.snapshot === 'pending')) store.setSnapshot(turnId, 'failed', error)
  }

  async function finishClose(c: Closing, markId: number | null, error: string | null): Promise<void> {
    const kind = await c.end
    await c.seg.declaring
    store.setEnd(c.seg.turnId, markId, kind, c.conversation)
    if (error !== null) failSnapshot(c.seg.turnId, error)
    safe('onTurnClosed', () => deps.onTurnClosed?.(c.seg.turnId))
  }

  async function runMark(repo: RepoInfo, req: MarkRequest, active: number[]): Promise<void> {
    let mark: { id: number; limited: boolean } | null = null
    let error: string | null = null
    try {
      mark = await writeMark(repo, req.kind, active)
    } catch (e) {
      error = errText(e)
      log(`marco ${req.kind} em ${repo.top} falhou: ${error}`)
    }
    if (req.opens) {
      if (mark) store.setStart(req.opens.turnId, mark.id, 'ok', undefined, mark.limited)
      else store.setStart(req.opens.turnId, null, 'failed', error ?? undefined)
      req.opens.startDone = true
    }
    if (req.closes) await finishClose(req.closes, mark?.id ?? null, error)
  }

  /** Enfileira o marco do pedido; sem git, só grava o fim. */
  function request(req: MarkRequest): void {
    const seg = req.opens ?? req.closes!.seg
    // Os abertos na hora do pedido; o filtro pelo repositório espera a pasta resolver.
    const segs = openNow(req.opens, req.closes?.seg)
    const go = (repo: RepoInfo | null): void => {
      if (!repo) {
        if (req.opens) req.opens.startDone = true
        if (req.closes) track(finishClose(req.closes, null, null), 'fim sem git')
        return
      }
      const active = activeIds(repo.key, segs, seg)
      track(queue.run(repo.key, () => runMark(repo, req, active)), `marco ${req.kind}`)
    }
    if (seg.repo !== undefined && !deferred) {
      go(seg.repo)
      return
    }
    // Pasta ainda não resolvida (ou outro pedido esperando uma): entra na fila
    // dos adiados, para os marcos saírem na ordem dos pedidos.
    const tail = (deferred ?? Promise.resolve()).then(() => seg.ready).then(go)
      .catch(e => log(`marco ${req.kind}: ${errText(e)}`))
    deferred = tail
    track(tail)
    void tail.then(() => { if (deferred === tail) deferred = null })
  }

  // ── Trechos ──

  function newSegment(ctx: UndoCtx, origin: TurnOrigin, opts: { textKey?: string | null; midTurn?: boolean; interactive?: boolean }): Segment {
    const projectPath = deps.projectPath(ctx.projectId)
    const known = projectPath === null ? null : resolver.peek(projectPath)
    const turnId = store.openTurn({
      localId: ctx.localId, projectId: ctx.projectId, engine: ctx.engine, origin,
      bornSessionId: lastConversation.get(ctx.localId) ?? null, textKey: opts.textKey ?? null, midTurn: opts.midTurn,
      repoKey: known?.key ?? null, repoTop: known?.top ?? null, snapshot: known === null ? 'no_git' : 'pending',
    })
    const seg: Segment = {
      turnId, localId: ctx.localId, projectPath, interactive: !!opts.interactive, repo: known,
      ready: Promise.resolve(known ?? null), startDone: known === null, late: false,
      sawWorking: lastStatus.get(ctx.localId) === 'working', result: null, declaring: Promise.resolve(),
    }
    if (known !== undefined) {
      // Renova em segundo plano o cache vencido (pasta que ganhou git, repo movido).
      if (projectPath !== null) track(resolver.get(projectPath))
    } else {
      // Pasta nunca vista: resolve fora do envio. Encadeado no trecho anterior
      // da mesma sessão, para os marcos dos dois saírem na ordem.
      const before = lastSeg.get(ctx.localId)
      const base = before && before.repo === undefined && before.projectPath === projectPath
        ? before.ready
        : resolver.get(projectPath!)
      seg.ready = base.then(repo => {
        seg.repo = repo
        if (repo) store.setRepo(turnId, repo.key, repo.top)
        else store.setSnapshot(turnId, 'no_git')
        return repo
      })
      track(seg.ready, 'resolução da pasta')
    }
    lastSeg.set(ctx.localId, seg)
    return seg
  }

  /** O fechamento de `prev` e a abertura de `seg` cabem num marco só (mesmo repositório). */
  function sameMark(prev: Segment, seg: Segment): boolean {
    if (seg.repo === undefined) return prev.repo === undefined && prev.projectPath === seg.projectPath
    return prev.repo !== undefined && (prev.repo?.key ?? null) === (seg.repo?.key ?? null)
  }

  /**
   * Abre um trecho na sessão. Se já há um aberto, ele fecha no mesmo marco
   * (`prevEnd` diz com que fim).
   */
  function begin(ctx: UndoCtx, origin: TurnOrigin, kind: MarkKind,
    opts: { textKey?: string | null; interactive?: boolean; prevEnd?: (prev: Segment) => EndKind }): Segment {
    const prev = open.get(ctx.localId)
    const seg = newSegment(ctx, origin, { textKey: opts.textKey, midTurn: !!prev && kind === 'message', interactive: opts.interactive })
    if (prev) seg.sawWorking ||= prev.sawWorking
    open.set(ctx.localId, seg)
    safe('onTurnOpened', () => deps.onTurnOpened?.(seg.turnId))
    if (!prev) {
      request({ kind, opens: seg })
      return seg
    }
    const closes: Closing = {
      seg: prev, end: Promise.resolve(opts.prevEnd?.(prev) ?? prev.result ?? 'result'),
      conversation: lastConversation.get(ctx.localId) ?? null,
    }
    if (sameMark(prev, seg)) {
      request({ kind, opens: seg, closes })
    } else {
      request({ kind: 'turn_end', closes })
      request({ kind, opens: seg })
    }
    return seg
  }

  /** Saída de working: fecha já (o próximo envio abre trecho novo), decide o fim numa microtask. */
  function closeOnStatus(ctx: UndoCtx, seg: Segment, status: string, info: { engineSessionId: string | null; shuttingDown: boolean }): void {
    open.delete(ctx.localId)
    closing.set(ctx.localId, seg)
    const byStatus: EndKind = status === 'dead' ? 'dead'
      : status === 'stopped' ? (info.shuttingDown ? 'restart' : 'stopped')
      : 'cut'
    // No Claude o status chega antes do result do mesmo turno (no mesmo tique):
    // a microtask deixa o result entrar. Result mais tardio não muda o fim.
    const end = new Promise<EndKind>(res => queueMicrotask(() => {
      if (closing.get(ctx.localId) === seg) closing.delete(ctx.localId)
      res(seg.result ?? byStatus)
    }))
    request({ kind: 'turn_end', closes: { seg, end, conversation: info.engineSessionId } })
  }

  function recordDeclared(seg: Segment, abs: string[]): void {
    const projectPath = seg.projectPath!
    const job = seg.declaring.then(async () => {
      const repo = seg.repo !== undefined ? seg.repo : await seg.ready
      let rel: Array<string | null>
      if (repo) {
        // O topo é o caminho real; a pasta do projeto pode passar por link.
        let real = realProjects.get(projectPath)
        if (!real) {
          real = realpath(projectPath).catch(() => projectPath)
          realProjects.set(projectPath, real)
        }
        const realProject = await real
        rel = abs.map(p => {
          const inProject = toRel(projectPath, p)
          return toRel(repo.top, inProject !== null ? join(realProject, inProject) : p)
        })
      } else {
        // Sem git: relativos à pasta do projeto.
        rel = abs.map(p => toRel(projectPath, p))
      }
      const paths = rel.filter((p): p is string => p !== null)
      if (paths.length) store.addDeclared(seg.turnId, paths)
    }).catch(e => log(`caminhos declarados: ${errText(e)}`))
    seg.declaring = job
    track(job)
  }

  // ── Observador ──

  const observer: TurnObserver = {
    onInput(ctx, text, origin, send) {
      deps.holdInput?.(ctx)
      let files: string[] | null = null
      try { files = store.takeNote(ctx.projectId, ctx.engine) } catch (e) { log(`nota: ${errText(e)}`) }
      const final = files?.length ? withNote(filesRevertedNote(files), text) : text
      try {
        send(final)
      } catch (e) {
        // A mensagem não saiu: a nota volta a esperar a próxima.
        if (files) safe('devolver a nota', () => store.addNote(ctx.projectId, ctx.engine, files!))
        throw e
      }
      // A mensagem já saiu: falha daqui em diante só fica no log.
      safe('abrir trecho', () => {
        const turnOrigin: TurnOrigin = origin === 'claudinei' && text.startsWith(GOAL_PREFIX) ? 'goal' : origin
        // Mensagem no meio do turno: o marco `message` fecha o trecho e abre o seguinte.
        const prev = open.get(ctx.localId)
        const kind: MarkKind = prev && !prev.interactive ? 'message' : 'turn_start'
        begin(ctx, turnOrigin, kind, { textKey: turnKey(final), prevEnd: p => p.interactive ? 'stopped' : p.result ?? 'result' })
      })
    },

    onStatus(ctx, status, info) {
      lastStatus.set(ctx.localId, status)
      if (info.engineSessionId) lastConversation.set(ctx.localId, info.engineSessionId)
      const seg = open.get(ctx.localId)
      if (status === 'working') {
        if (seg) { seg.sawWorking = true; return }
        // Turno que o motor abriu sozinho, ou o working do próprio envio (o
        // onInput abre o trecho logo depois do send). A compactação liga a
        // marca depois do status: tudo se decide na microtask.
        queueMicrotask(() => safe('trecho do motor', () => {
          if (lastStatus.get(ctx.localId) !== 'working' || open.has(ctx.localId) || info.compaction()) return
          begin(ctx, 'engine', 'turn_start', {})
        }))
        return
      }
      if (!seg || seg.interactive || !EXITS.has(status)) return
      // Motor que só passa a working depois do envio: o idle repetido antes disso não corta o trecho.
      if ((status === 'idle' || status === 'needs_attention') && !seg.sawWorking) return
      safe('fechar trecho', () => closeOnStatus(ctx, seg, status, info))
    },

    onEvent(ctx, event) {
      safe('evento', () => {
        if (event.kind === 'result') {
          const kind = resultKind(event.subtype)
          // O result que chega logo depois do status vale para o trecho que fechou.
          const target = closing.get(ctx.localId) ?? open.get(ctx.localId)
          if (target) target.result = kind
          return
        }
        const seg = open.get(ctx.localId)
        if (!seg) return
        if (event.kind === 'system' && event.subtype === 'turn_started') {
          const id = (event.raw as { turnId?: unknown } | null)?.turnId
          if (typeof id === 'string' && id) store.setAnchor(seg.turnId, id)
          return
        }
        if (event.kind !== 'assistant' || !Array.isArray(event.message.content)) return
        if (!event.message.content.some(b => b.type === 'tool_use')) return
        if (!seg.startDone && !seg.late) {
          seg.late = true
          store.markLate(seg.turnId)
        }
        if (seg.projectPath === null) return
        const abs = declaredPaths(event, seg.projectPath)
        if (abs.length) recordDeclared(seg, abs)
      })
    },

    onInteractive(ctx, phase) {
      safe(`terminal interativo (${phase})`, () => {
        if (phase === 'open') {
          begin(ctx, 'interactive', 'terminal_open', { interactive: true, prevEnd: p => p.result ?? 'stopped' })
          return
        }
        const seg = open.get(ctx.localId)
        if (!seg?.interactive) return
        open.delete(ctx.localId)
        request({ kind: 'terminal_close', closes: { seg, end: Promise.resolve<EndKind>('stopped'), conversation: null } })
      })
    },
  }

  /** Fecha um turno que ficou aberto quando o serviço caiu. */
  function endUncertain(t: TurnRow, markId: number | null, error: string | null): void {
    store.setEnd(t.id, markId, 'uncertain', null)
    if (t.snapshot === 'pending' && t.startMark === null) store.setSnapshot(t.id, 'failed', 'o serviço parou antes do marco de início')
    else if (error !== null) failSnapshot(t.id, error)
    safe('onTurnClosed', () => deps.onTurnClosed?.(t.id))
  }

  return {
    ...observer,

    /** Na subida: todo turno aberto ganha um marco turn_end agora (um por repositório) e o fim `uncertain`. */
    async boot(): Promise<void> {
      const mine = new Set([...open.values(), ...closing.values()].map(s => s.turnId))
      const turns = store.openTurns().filter(t => !mine.has(t.id))
      const byRepo = new Map<string, TurnRow[]>()
      const jobs: Promise<void>[] = []
      for (const t of turns) {
        if (t.repoKey && t.repoTop) {
          const k = `${t.repoKey}\0${t.repoTop}`
          byRepo.set(k, [...byRepo.get(k) ?? [], t])
        } else {
          endUncertain(t, null, null)
        }
      }
      for (const group of byRepo.values()) {
        const { repoKey, repoTop } = group[0]
        jobs.push((async () => {
          const repo = await resolver.get(repoTop!).catch(() => null)
          if (!repo || repo.key !== repoKey) {
            for (const t of group) endUncertain(t, null, 'repositório não encontrado na subida')
            return
          }
          const active = activeIds(repo.key, openNow())
          await queue.run(repo.key, async () => {
            let markId: number | null = null
            let error: string | null = null
            try {
              markId = (await writeMark(repo, 'turn_end', active)).id
            } catch (e) {
              error = errText(e)
              log(`marco da subida em ${repo.top} falhou: ${error}`)
            }
            for (const t of group) endUncertain(t, markId, error)
          })
        })())
      }
      const all = Promise.all(jobs)
      track(all)
      await all
    },

    /** Espera a fila e tudo o que o rastreador pôs para rodar. */
    async idle(): Promise<void> {
      for (;;) {
        if (inflight.size) { await Promise.all([...inflight]); continue }
        await queue.idle()
        await Promise.resolve()
        if (!inflight.size) return
      }
    },

    /** Id do turno do trecho aberto na sessão. */
    openSegment(localId: string): number | undefined {
      return open.get(localId)?.turnId
    },

    /** Marco fora de turno (desfazer), na mesma fila; active = trechos abertos do repo. */
    takeMark(repo: RepoInfo, kind: MarkKind): Promise<number> {
      const active = activeIds(repo.key, openNow())
      const job = queue.run(repo.key, async () => (await writeMark(repo, kind, active)).id)
      track(job)
      return job
    },
  }
}

export type TurnTracker = ReturnType<typeof createTurnTracker>
