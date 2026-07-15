import type { Db } from './db.js'

/** Key-value simples persistido no SQLite (settings global do app). */
export function createSettingsService(db: Db) {
  return {
    get(key: string): string | undefined {
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
      return row?.value
    },
    set(key: string, value: string): void {
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
    },
    /** Última lista de slash commands vista num evento init (para o autocomplete do chat). */
    getSlashCommands(): string[] {
      const raw = this.get('slash_commands')
      if (!raw) return []
      try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
    },
    setSlashCommands(cmds: string[]): void {
      this.set('slash_commands', JSON.stringify(cmds))
    },
  }
}

export type SettingsService = ReturnType<typeof createSettingsService>
