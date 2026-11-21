import type { Db } from '../db.js'
import type { RepoInfo } from '../checkpoint/repo.js'
import type { createSerialQueue } from '../checkpoint/serial.js'
import { deleteRefs } from '../checkpoint/snapshot.js'
import type { UndoStore } from './store.js'

/**
 * Retenção do desfazer: na subida e a cada 24 h.
 *
 * 1. Saem os turnos terminados há mais de 30 dias e os que passam dos 200 mais
 *    novos de cada terminal (projeto + motor).
 * 2. Saem os desfazeres sem nenhum turno restante.
 * 3. Um marco fica se é início ou fim de turno restante, se cai na janela de um
 *    (mesmo repositório, `n` entre o início e o fim; turno aberto segura tudo do
 *    início em diante), se é o "antes"/"depois" de um desfazer restante, ou se é
 *    o mais novo do repositório (o próximo `n` é MAX(n) + 1: apagar o último
 *    deixaria o número se repetir). O resto sai do banco e a ref sai do git.
 * 4. Saem as listagens que nenhum marco usa.
 *
 * A parte do banco é uma transação síncrona: nada do rastreador entra no meio.
 * As refs saem depois, na fila do repositório (nunca junto de um marco sendo
 * tirado), só em `refs/claudinei/`. Nunca roda `gc`: os objetos ficam para o
 * gc do próprio operador.
 */

export interface RetentionDeps {
  store: UndoStore
  db: Db
  resolver: { get(path: string): Promise<RepoInfo | null> }
  /** A fila por repositório do rastreador; sem ela, as refs saem direto. */
  queue?: ReturnType<typeof createSerialQueue>
  now?: () => number
  maxAgeDays?: number
  perTerminal?: number
  log?(m: string): void
}

const DAY_MS = 24 * 60 * 60 * 1000

/** O formato do `datetime('now')` do SQLite (UTC), para comparar como texto. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

interface DoomedMark { id: number; repo_key: string; repo_top: string; ref: string }

export async function runRetention(deps: RetentionDeps): Promise<{ turns: number; marks: number }> {
  const { db } = deps
  const log = deps.log ?? ((m: string) => console.error(`[undo] ${m}`))
  const now = deps.now?.() ?? Date.now()
  const cutoff = sqliteTime(now - (deps.maxAgeDays ?? 30) * DAY_MS)
  const perTerminal = deps.perTerminal ?? 200

  const prune = db.transaction((): { turns: number; marks: DoomedMark[] } => {
    const turns = db.prepare(`DELETE FROM undo_turns WHERE id IN (
        SELECT id FROM undo_turns WHERE ended_at IS NOT NULL AND ended_at < @cutoff
        UNION
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id, engine ORDER BY id DESC) AS rn FROM undo_turns
        ) WHERE rn > @perTerminal)`).run({ cutoff, perTerminal }).changes

    db.prepare(`DELETE FROM undo_runs WHERE NOT EXISTS (
        SELECT 1 FROM json_each(undo_runs.turn_ids) j JOIN undo_turns t ON t.id = j.value)`).run()

    const doomed = db.prepare(`SELECT m.id, m.repo_key, m.repo_top, m.ref FROM undo_marks m
      WHERE m.n < (SELECT MAX(n) FROM undo_marks x WHERE x.repo_key = m.repo_key)
        AND m.id NOT IN (SELECT start_mark FROM undo_turns WHERE start_mark IS NOT NULL)
        AND m.id NOT IN (SELECT end_mark FROM undo_turns WHERE end_mark IS NOT NULL)
        AND m.id NOT IN (SELECT pre_mark FROM undo_runs WHERE pre_mark IS NOT NULL)
        AND m.id NOT IN (SELECT post_mark FROM undo_runs WHERE post_mark IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM undo_turns t
            JOIN undo_marks s ON s.id = t.start_mark
            LEFT JOIN undo_marks e ON e.id = t.end_mark
          WHERE s.repo_key = m.repo_key AND m.n >= s.n
            AND (e.n IS NOT NULL AND m.n <= e.n OR t.end_mark IS NULL AND t.ended_at IS NULL))`).all() as DoomedMark[]
    const del = db.prepare(`DELETE FROM undo_marks WHERE id = ?`)
    for (const m of doomed) del.run(m.id)

    db.prepare(`DELETE FROM undo_listings WHERE hash NOT IN (
        SELECT listing_hash FROM undo_marks WHERE listing_hash IS NOT NULL)`).run()
    return { turns, marks: doomed }
  })

  const { turns, marks } = prune()

  // As refs, por repositório. Repositório que sumiu ou mudou de lugar: as refs
  // ficam (não há onde apagar), o banco já está limpo.
  const byRepo = new Map<string, { key: string; top: string; refs: string[] }>()
  for (const m of marks) {
    const k = `${m.repo_key}\0${m.repo_top}`
    const group = byRepo.get(k) ?? { key: m.repo_key, top: m.repo_top, refs: [] }
    // Só as refs deste repositório; o deleteRefs ainda recusa qualquer uma fora de refs/claudinei/.
    if (m.ref.startsWith(`refs/claudinei/${m.repo_key}/`)) group.refs.push(m.ref)
    byRepo.set(k, group)
  }
  for (const { key, top, refs } of byRepo.values()) {
    if (!refs.length) continue
    try {
      const repo = await deps.resolver.get(top).catch(() => null)
      if (!repo || repo.key !== key) continue
      const job = (): Promise<void> => deleteRefs(repo, refs)
      await (deps.queue ? deps.queue.run(key, job) : job())
    } catch (e) {
      log(`retenção: apagar ${refs.length} ref(s) em ${top} falhou: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { turns, marks: marks.length }
}
