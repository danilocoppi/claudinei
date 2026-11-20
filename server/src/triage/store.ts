import type { Db } from '../db.js'

/**
 * Triagem da lista, por usuário e projeto: fixado, assentado e adiado.
 *
 * `userId = 0` é a instalação SEM auth (como em `user_prefs`). As datas ficam em
 * ISO UTC (`toISOString`), o que deixa a comparação de texto valer como
 * comparação de tempo.
 */
export interface TriageDto {
  projectId: number
  pinned: boolean
  settled: boolean
  /** Adiado até quando. Adiamento vencido é lido como `null`. */
  snoozedUntil: string | null
}

/** Por que um terminal assentado ou adiado volta (ver o despertador). */
export type WakeReason = 'question' | 'failed' | 'dead' | 'interrupted' | 'usage_limit'

export interface TriagePatch {
  pinned?: boolean
  settled?: boolean
  snoozedUntil?: string | null
}

interface Row {
  user_id: number
  project_id: number
  pinned_at: string | null
  settled_at: string | null
  snoozed_until: string | null
}

/** Chave em `settings` que marca a migração da ⭐ global para o pin por usuário. */
const MIGRATED_KEY = 'triage_favorites_migrated'

const now = () => new Date().toISOString()

const toDto = (projectId: number, row: Row | undefined): TriageDto => {
  const snooze = row?.snoozed_until ?? null
  return {
    projectId,
    pinned: !!row?.pinned_at,
    settled: !!row?.settled_at,
    snoozedUntil: snooze !== null && snooze > now() ? snooze : null,
  }
}

const applied = (t: TriageDto) => t.pinned || t.settled || t.snoozedUntil !== null

export function createTriageStore(db: Db) {
  const getRow = (userId: number, projectId: number) =>
    db.prepare(`SELECT * FROM user_triage WHERE user_id=? AND project_id=?`).get(userId, projectId) as Row | undefined

  // Função solta (não `this.get`): os métodos do store podem ser passados adiante.
  const get = (userId: number, projectId: number): TriageDto => toDto(projectId, getRow(userId, projectId))

  return {
    /** Só os projetos com algo aplicado; quem não tem linha está "normal". */
    list(userId: number): TriageDto[] {
      const rows = db.prepare(`SELECT * FROM user_triage WHERE user_id=? ORDER BY project_id`).all(userId) as Row[]
      return rows.map((r) => toDto(r.project_id, r)).filter(applied)
    },

    get,

    /**
     * Aplica os campos nesta ordem, e o último a falar vence:
     * - `settled: true` tira o pin e o adiamento (fixar e assentar se excluem);
     * - `snoozedUntil` não nulo tira o assentado (a ação nova substitui a anterior);
     * - `pinned: true` tira o assentado.
     * Adiar mantém o pin.
     */
    update(userId: number, projectId: number, p: TriagePatch): TriageDto {
      const cur = getRow(userId, projectId)
      let pinnedAt = cur?.pinned_at ?? null
      let settledAt = cur?.settled_at ?? null
      let snoozedUntil = cur?.snoozed_until ?? null
      const t = now()

      if (p.settled !== undefined) {
        settledAt = p.settled ? (settledAt ?? t) : null
        if (p.settled) { pinnedAt = null; snoozedUntil = null }
      }
      if (p.snoozedUntil !== undefined) {
        snoozedUntil = p.snoozedUntil === null ? null : new Date(p.snoozedUntil).toISOString()
        if (snoozedUntil !== null) settledAt = null
      }
      if (p.pinned !== undefined) {
        pinnedAt = p.pinned ? (pinnedAt ?? t) : null
        if (p.pinned) settledAt = null
      }

      if (pinnedAt === null && settledAt === null && snoozedUntil === null) {
        // Nada aplicado: a ausência de linha já diz isso.
        db.prepare(`DELETE FROM user_triage WHERE user_id=? AND project_id=?`).run(userId, projectId)
      } else {
        db.prepare(`
          INSERT INTO user_triage (user_id, project_id, pinned_at, settled_at, snoozed_until) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, project_id) DO UPDATE SET
            pinned_at=excluded.pinned_at, settled_at=excluded.settled_at, snoozed_until=excluded.snoozed_until
        `).run(userId, projectId, pinnedAt, settledAt, snoozedUntil)
      }
      return get(userId, projectId)
    },

    /**
     * O terminal precisa do operador: tira o assentado e o adiamento de TODOS os
     * usuários, mantendo o pin. Devolve quem teve algo visível mudado (adiamento
     * já vencido não conta), para o despertador avisar só esses.
     */
    wakeProject(projectId: number): number[] {
      return db.transaction(() => {
        const affected = (db.prepare(`
          SELECT user_id FROM user_triage
          WHERE project_id=? AND (settled_at IS NOT NULL OR (snoozed_until IS NOT NULL AND snoozed_until > ?))
          ORDER BY user_id
        `).all(projectId, now()) as { user_id: number }[]).map((r) => r.user_id)
        db.prepare(`UPDATE user_triage SET settled_at=NULL, snoozed_until=NULL WHERE project_id=?`).run(projectId)
        db.prepare(`DELETE FROM user_triage WHERE project_id=? AND pinned_at IS NULL`).run(projectId)
        return affected
      })()
    },
  }
}

export type TriageStore = ReturnType<typeof createTriageStore>

/**
 * Migração única da ⭐ global (`projects.favorite`) para o pin por usuário: cada
 * usuário, e o usuário 0, começa com fixados os favoritos a que tem acesso.
 * Admin e usuário 0 acessam tudo; os outros, o que está em `user_projects`.
 * Marcada em `settings` para não refixar o que o operador desafixou depois.
 */
export function migrateFavoritesToPins(db: Db): void {
  db.transaction(() => {
    if (db.prepare(`SELECT 1 FROM settings WHERE key=?`).get(MIGRATED_KEY)) return
    const t = now()
    const pin = db.prepare(`INSERT OR IGNORE INTO user_triage (user_id, project_id, pinned_at) VALUES (?, ?, ?)`)
    const favorites = (db.prepare(`SELECT id FROM projects WHERE favorite=1`).all() as { id: number }[]).map((r) => r.id)
    const users = db.prepare(`SELECT id, is_admin FROM users`).all() as { id: number; is_admin: number }[]
    const access = db.prepare(`SELECT 1 FROM user_projects WHERE user_id=? AND project_id=?`)
    for (const projectId of favorites) {
      pin.run(0, projectId, t)
      for (const u of users) {
        if (u.is_admin || access.get(u.id, projectId)) pin.run(u.id, projectId, t)
      }
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(MIGRATED_KEY, t)
  })()
}
