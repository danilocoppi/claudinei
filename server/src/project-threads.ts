import type { Db } from './db.js'

/**
 * Posse de conversa: qual thread de agente pertence a qual terminal.
 *
 * Duas entradas da sidebar podem apontar para a MESMA pasta, e o storage de cada
 * engine é indexado por pasta (transcripts do Claude, rollouts do Codex, `session`
 * do OpenCode). Sem saber de quem é cada conversa, "a mais recente desta pasta" é
 * a do vizinho metade das vezes — e o `onExit` do terminal chegava a gravá-la.
 */

/** Marca `threadId` como conversa deste projeto+engine, promovendo-a a mais recente. */
export function recordThread(db: Db, projectId: number, engine: string, threadId: string): void {
  db.prepare(
    `INSERT INTO project_threads (project_id, engine, thread_id, seq)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM project_threads))
     ON CONFLICT(project_id, engine, thread_id) DO UPDATE SET
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM project_threads),
       seen_at = datetime('now')`,
  ).run(projectId, engine, threadId)
}

/** A última conversa DESTE terminal — o que substitui o `--continue` em pasta compartilhada. */
export function ownLatestThread(db: Db, projectId: number, engine: string): string | null {
  const row = db.prepare(
    `SELECT thread_id FROM project_threads WHERE project_id=? AND engine=? ORDER BY seq DESC LIMIT 1`,
  ).get(projectId, engine) as { thread_id?: string } | undefined
  return row?.thread_id ?? null
}

/**
 * As conversas dos OUTROS terminais da mesma pasta — o conjunto a descartar ao
 * perguntar à engine qual é a conversa mais recente da pasta.
 *
 * Filtra por engine porque o storage é por engine: um thread do Codex nunca
 * apareceria na busca do Claude, e carregá-lo aqui só encheria o `NOT IN`.
 */
export function foreignThreadIds(db: Db, projectId: number, engine: string): ReadonlySet<string> {
  const rows = db.prepare(
    `SELECT pt.thread_id AS id
       FROM project_threads pt
       JOIN projects p ON p.id = pt.project_id
      WHERE pt.engine = ?
        AND pt.project_id <> ?
        AND p.path = (SELECT path FROM projects WHERE id = ?)`,
  ).all(engine, projectId, projectId) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

/**
 * Mais de um terminal nesta pasta?
 *
 * É o interruptor de tudo: com um terminal só, nada muda em relação a hoje —
 * inclusive o `--continue`, que continua sendo a coisa certa a fazer.
 */
export function isSharedPath(db: Db, projectId: number): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE path = (SELECT path FROM projects WHERE id = ?)`,
  ).get(projectId) as { n: number }
  return row.n > 1
}
