import { changedFiles, type MarkSide } from '../checkpoint/diff.js'
import type { RepoInfo } from '../checkpoint/repo.js'
import type { AttributedFile, FileChange, TurnSummary } from '../../../shared/undo.js'
import type { MarkRow, TurnRow, UndoStore } from './store.js'

/**
 * Atribuição entre terminais da mesma pasta (spec, "Vários terminais na mesma
 * pasta"). Os marcos formam a linha do tempo do repositório; o `active` do
 * marco k diz quais turnos estavam abertos no intervalo (k, k+1).
 *
 * A mudança de um arquivo num intervalo é do turno se só ele estava ativo.
 * Com outros ativos, decide pelos caminhos declarados (Edit/Write/… de cada
 * turno, relativos ao topo):
 *
 * - só o turno declarou → `own`;
 * - ele e outro ativo declararam → `own` com `overlapped` (vira conflito na prévia);
 * - só outro declarou → não é do turno;
 * - ninguém declarou → `uncertain`.
 *
 * O resultado é o diff líquido do início ao fim do turno: o arquivo que mudou
 * e voltou não entra. Só leitura no git (o diff-tree do `changedFiles`).
 */

// Os tipos que a web também usa moram em shared/undo.ts.
export type { FileClass, AttributedFile } from '../../../shared/undo.js'

export interface Viewer { isAdmin: boolean }

export interface Interval { from: MarkRow; to: MarkRow; kind: 'between' | 'undo' }

/**
 * O turno não tem os dois marcos (em andamento, ou o retrato falhou) ou eles
 * não batem com o repositório. Quem chama (Task 9) confere o estado do retrato
 * antes; chegar aqui assim é erro de quem chamou.
 */
export class UnattributableTurnError extends Error {
  constructor(readonly turnId: number, reason: string) {
    super(`turno ${turnId} sem atribuição: ${reason}`)
    this.name = 'UnattributableTurnError'
  }
}

/** O lado do marco para o `changedFiles`. */
export function markSide(store: UndoStore, row: MarkRow): MarkSide {
  return {
    commit: row.commitSha,
    big: row.big,
    listing: row.mode === 'full' || !row.listingHash ? null : store.listing(row.listingHash),
  }
}

/** O caminho cai na pasta do projeto (`projectRel` relativo ao topo; vazio = o repositório inteiro). */
function inProjectOf(projectRel: string): (path: string) => boolean {
  let base = projectRel.replace(/\/+$/, '')
  if (base.startsWith('./')) base = base.slice(2)
  if (!base || base === '.') return () => true
  return path => path === base || path.startsWith(`${base}/`)
}

function turnMarks(store: UndoStore, repo: RepoInfo, turn: TurnRow): { start: MarkRow; end: MarkRow } {
  if (turn.startMark === null) throw new UnattributableTurnError(turn.id, 'sem marco de início')
  if (turn.endMark === null) throw new UnattributableTurnError(turn.id, 'sem marco de fim')
  const start = store.mark(turn.startMark)
  const end = store.mark(turn.endMark)
  if (!start || !end) throw new UnattributableTurnError(turn.id, 'marco apagado')
  if (start.repoKey !== repo.key || end.repoKey !== repo.key) throw new UnattributableTurnError(turn.id, 'marco de outro repositório')
  if (end.n < start.n) throw new UnattributableTurnError(turn.id, 'marco de fim antes do início')
  return { start, end }
}

/** Intervalos seguidos com os mesmos outros ativos, juntos num diff só. */
interface Run { from: number; to: number; others: number[] }

function runsOf(marks: MarkRow[], turnId: number): Run[] {
  const runs: Run[] = []
  for (let i = 0; i + 1 < marks.length; i++) {
    const others = marks[i].active.filter(id => id !== turnId)
    const last = runs[runs.length - 1]
    if (last && last.others.join(',') === others.join(',')) last.to = i + 1
    else runs.push({ from: i, to: i + 1, others })
  }
  return runs
}

const own = (c: FileChange, inProject: boolean): AttributedFile => ({ ...c, class: 'own', overlapped: false, inProject })

export async function attributeTurn(repo: RepoInfo, store: UndoStore, turn: TurnRow, projectRel: string): Promise<AttributedFile[]> {
  const { start, end } = turnMarks(store, repo, turn)
  const inProject = inProjectOf(projectRel)
  if (start.id === end.id) return []
  const net = await changedFiles(repo, markSide(store, start), markSide(store, end))
  if (!net.length) return []

  const marks = store.marksRange(repo.key, start.n, end.n)
  if (marks[0]?.id !== start.id || marks[marks.length - 1]?.id !== end.id) {
    throw new UnattributableTurnError(turn.id, 'linha do tempo incompleta')
  }
  const runs = runsOf(marks, turn.id)
  // Só ele ativo do começo ao fim: um diff só, tudo dele.
  if (runs.every(r => r.others.length === 0)) return net.map(c => own(c, inProject(c.path)))

  // A linha pode estar mais nova que a passada (caminhos declarados no fim).
  const mine = new Set((store.turn(turn.id) ?? turn).declared)
  const declaredBy = new Map<number, Set<string>>()
  const declared = (id: number): Set<string> => {
    let set = declaredBy.get(id)
    if (!set) {
      set = new Set(store.turn(id)?.declared ?? [])
      declaredBy.set(id, set)
    }
    return set
  }

  interface Verdict { own: boolean; uncertain: boolean; overlapped: boolean }
  const verdicts = new Map<string, Verdict>()
  for (const run of runs) {
    const changes = run.from === 0 && run.to === marks.length - 1
      ? net
      : await changedFiles(repo, markSide(store, marks[run.from]), markSide(store, marks[run.to]))
    for (const c of changes) {
      let v = verdicts.get(c.path)
      if (!v) {
        v = { own: false, uncertain: false, overlapped: false }
        verdicts.set(c.path, v)
      }
      if (!run.others.length) {
        v.own = true
        continue
      }
      const byOther = run.others.some(id => declared(id).has(c.path))
      if (byOther) v.overlapped = true
      if (mine.has(c.path)) v.own = true
      else if (!byOther) v.uncertain = true
      // Só outro declarou: não é deste turno (a menos que outro intervalo diga que é).
    }
  }

  const out: AttributedFile[] = []
  for (const c of net) {
    const v = verdicts.get(c.path)
    // Mudou no líquido sem aparecer em nenhum intervalo (grandes e soltos do
    // modo limitado): sem como dizer de quem é, fica incerto.
    if (!v) out.push({ ...c, class: 'uncertain', overlapped: false, inProject: inProject(c.path) })
    else if (v.own) out.push({ ...c, class: 'own', overlapped: v.overlapped, inProject: inProject(c.path) })
    else if (v.uncertain) out.push({ ...c, class: 'uncertain', overlapped: v.overlapped, inProject: inProject(c.path) })
  }
  return out
}

/**
 * O resumo do turno. Não-admin conta só os arquivos da pasta do projeto; os de
 * fora vão para `outside`, sem nome. `files`, `added` e `removed` são dos
 * próprios (`own`); os incertos vão em `uncertain`; `unsnapshotted` conta os
 * visíveis de qualquer classe que mudaram sem retrato.
 */
export function summarize(files: AttributedFile[], viewer: Viewer): TurnSummary {
  const visible = viewer.isAdmin ? files : files.filter(f => f.inProject)
  const mine = visible.filter(f => f.class === 'own')
  return {
    files: mine.length,
    added: mine.reduce((s, f) => s + f.added, 0),
    removed: mine.reduce((s, f) => s + f.removed, 0),
    outside: files.length - visible.length,
    uncertain: visible.filter(f => f.class === 'uncertain').length,
    unsnapshotted: visible.filter(f => f.status === 'unsnapshotted').length,
  }
}

/**
 * Os intervalos fora de turno do repositório, do mais novo para o mais velho,
 * até `limit`: pares de marcos seguidos (`n` e `n + 1`) em que o `from` não
 * tinha turno ativo. `kind: 'undo'` quando o `from` é o marco "antes do
 * desfazer". Par com marco apagado no meio (retenção) não conta: a janela
 * cobriria turnos que sumiram.
 *
 * Só os pares: não diz se o intervalo mudou algo (seria um diff por par). Quem
 * mostra calcula os arquivos ao abrir, com `markSide` e `changedFiles`.
 */
export function listIntervals(store: UndoStore, repoKey: string, limit = 50): Interval[] {
  const out: Interval[] = []
  if (limit <= 0) return out
  // A maioria dos pares tem turno ativo: busca mais marcos até juntar `limit`.
  for (let want = Math.max(2 * limit + 1, 64); ; want *= 2) {
    const marks = store.latestMarks(repoKey, want)
    out.length = 0
    for (let i = 1; i < marks.length && out.length < limit; i++) {
      const to = marks[i - 1]
      const from = marks[i]
      if (to.n !== from.n + 1 || from.active.length) continue
      out.push({ from, to, kind: from.kind === 'undo_pre' ? 'undo' : 'between' })
    }
    if (out.length >= limit || marks.length < want) return out
  }
}
