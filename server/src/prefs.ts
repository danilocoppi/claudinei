import type { Db } from './db.js'

/**
 * Aparência de um usuário. Os campos guardam CHAVES ("light-fun", "compact"), não
 * valores de CSS: quem traduz chave em CSS é o cliente, que é quem tem a folha de
 * estilo. Isso mantém o servidor livre de conhecimento visual — um pacote de tema
 * novo não exige mexer no backend — e fecha a porta de injeção, já que nada do que
 * está aqui entra numa regra de CSS sem passar por uma tabela conhecida no front.
 */
export interface Appearance {
  theme: string
  chatWidth: string
  fontUi: string
  fontCode: string
  density: string
  accent: string
  radius: string
  /** 'theme' | 'on' | 'off' — antes era booleano (ver o saneamento). */
  glass: string
  reducedMotion: boolean
}

/** O padrão é exatamente a aparência de hoje: quem nunca abriu o painel não vê diferença. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark-fun',
  chatWidth: 'full',
  // "do tema" em tudo que o pacote pode decidir: fonte, densidade, cantos e vidro
  // nascem do tema, e a escolha do painel só existe para discordar dele.
  fontUi: 'theme',
  fontCode: 'theme',
  density: 'theme',
  accent: 'theme',
  radius: 'theme',
  glass: 'theme',
  reducedMotion: false,
}

/** Chave aceitável: curta e sem nada que possa escapar de um atributo/variável. */
const validKey = (v: unknown): string | null =>
  typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v) ? v : null

/**
 * Saneia campo a campo, caindo no padrão em vez de recusar. Um valor que o servidor
 * não reconhece — porque veio de uma versão mais nova do cliente, ou de um pacote
 * de tema removido — não pode deixar o usuário preso numa tela que não carrega.
 */
export function sanitizeAppearance(input: unknown): Appearance {
  const raw = (input ?? {}) as Record<string, unknown>
  const out = { ...DEFAULT_APPEARANCE }
  for (const key of ['theme', 'chatWidth', 'fontUi', 'fontCode', 'density', 'accent', 'radius'] as const) {
    out[key] = validKey(raw[key]) ?? DEFAULT_APPEARANCE[key]
  }
  // Compatibilidade: o vidro já foi booleano. `false` era um desligamento
  // explícito e precisa continuar valendo; `true` vira "o que o pacote quiser".
  out.glass = typeof raw.glass === 'boolean'
    ? (raw.glass ? 'theme' : 'off')
    : validKey(raw.glass) ?? DEFAULT_APPEARANCE.glass
  out.reducedMotion = typeof raw.reducedMotion === 'boolean' ? raw.reducedMotion : DEFAULT_APPEARANCE.reducedMotion
  return out
}

/**
 * Atalhos de teclado de um usuário: id da ação → combinação, ou `null` para "sem
 * atalho". Guarda só as DIFERENÇAS do padrão — quem nunca mexeu tem `{}` e acompanha
 * os padrões de versões futuras. Os ids e os padrões moram no cliente; o servidor
 * confere só a forma, e um id novo não exige mexer aqui.
 */
export type Keybindings = Record<string, string | null>

export const KEYBINDING_ID = /^[a-z][a-z0-9.-]{0,40}$/
/** Mesma gramática do cliente. Modificadores sempre na ordem Mod, Ctrl, Alt, Shift. */
export const KEYBINDING_COMBO = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|Enter|Space|F[1-9]|F1[0-2])$/
export const MAX_KEYBINDINGS = 64

/**
 * No molde do `sanitizeAppearance`: descarta a entrada que não passa em vez de
 * recusar o resto, e guarda no máximo as 64 primeiras válidas. Não objeto vale `{}`.
 */
export function sanitizeKeybindings(input: unknown): Keybindings {
  const out: Keybindings = {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  let n = 0
  for (const [id, combo] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_KEYBINDINGS) break
    if (!KEYBINDING_ID.test(id)) continue
    if (combo !== null && !(typeof combo === 'string' && KEYBINDING_COMBO.test(combo))) continue
    out[id] = combo
    n++
  }
  return out
}

/**
 * Preferências por usuário (aparência e atalhos). `userId = 0` é a instalação SEM auth
 * (`authUser === undefined`: pré-setup em loopback e o app de teste) — sem essa
 * linha o recurso não existiria nessas instalações.
 */
export function createPrefsService(db: Db) {
  const service = {
    get(userId: number): Appearance {
      const row = db.prepare(`SELECT appearance FROM user_prefs WHERE user_id=?`).get(userId) as any
      if (!row) return { ...DEFAULT_APPEARANCE }
      try {
        return sanitizeAppearance(JSON.parse(row.appearance))
      } catch {
        // JSON corrompido no banco não pode derrubar a tela: cai no padrão, e o
        // próximo save reescreve a linha.
        return { ...DEFAULT_APPEARANCE }
      }
    },

    getKeybindings(userId: number): Keybindings {
      const row = db.prepare(`SELECT keybindings FROM user_prefs WHERE user_id=?`).get(userId) as any
      if (!row?.keybindings) return {}
      try {
        return sanitizeKeybindings(JSON.parse(row.keybindings))
      } catch {
        // Mesmo motivo da aparência: JSON corrompido vale "nunca mexeu".
        return {}
      }
    },

    /** O UPSERT da aparência não toca em `keybindings`, e este não toca na aparência. */
    set(userId: number, input: unknown): Appearance {
      const appearance = sanitizeAppearance(input)
      db.prepare(`
        INSERT INTO user_prefs (user_id, appearance, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET appearance=excluded.appearance, updated_at=excluded.updated_at
      `).run(userId, JSON.stringify(appearance))
      return appearance
    },

    setKeybindings(userId: number, input: unknown): Keybindings {
      const keybindings = sanitizeKeybindings(input)
      // Usuário sem linha: `appearance` é NOT NULL, então a linha nasce com o padrão.
      db.prepare(`
        INSERT INTO user_prefs (user_id, appearance, keybindings, updated_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET keybindings=excluded.keybindings, updated_at=excluded.updated_at
      `).run(userId, JSON.stringify(DEFAULT_APPEARANCE), JSON.stringify(keybindings))
      return keybindings
    },

    /** Grava o que veio (campo `undefined` não muda) numa transação só. */
    update(userId: number, patch: { appearance?: unknown; keybindings?: unknown }): void {
      db.transaction(() => {
        if (patch.appearance !== undefined) service.set(userId, patch.appearance)
        if (patch.keybindings !== undefined) service.setKeybindings(userId, patch.keybindings)
      })()
    },

    remove(userId: number): void {
      db.prepare(`DELETE FROM user_prefs WHERE user_id=?`).run(userId)
    },
  }
  return service
}

export type PrefsService = ReturnType<typeof createPrefsService>
