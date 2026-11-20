/**
 * Prompts guardados para depois (Ctrl+S no campo de mensagem), por terminal.
 *
 * O terminal é projeto + motor, e não a sessão: um /clear, uma retomada ou um
 * restart trocam a sessão, e o que foi guardado tem de continuar ali. Cada
 * guardado leva o mapa token→caminho dos anexos — sem ele, o `[📎 nome]` que
 * volta para o campo seria só texto, e o anexo não iria no envio.
 *
 * Um mapa só no localStorage, como em drafts.ts: um lugar único para descartar
 * os de outros terminais quando a cota aperta.
 */
export const STASH_KEY = 'claudinei:stash'
export const STASH_MAX = 10

export interface StashEntry { text: string; attachments: Array<[token: string, path: string]>; savedAt: number }

/** Mais novo no fim da lista. */
type Stash = Record<string, StashEntry[]>

export const stashKey = (projectId: number, engine: string) => `${projectId}:${engine}`

const isPar = (v: unknown): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string'

/** Só o que tem a forma certa passa: o resto é lixo de outra versão ou de outra aba. */
const isEntry = (v: unknown): v is StashEntry => {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.text === 'string' && typeof e.savedAt === 'number'
    && Array.isArray(e.attachments) && e.attachments.every(isPar)
}

function readAll(): Stash {
  try {
    const raw = localStorage.getItem(STASH_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Stash = {}
    for (const [k, lista] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(lista)) continue
      const boas = lista.filter(isEntry)
      if (boas.length) out[k] = boas
    }
    return out
  } catch {
    return {}
  }
}

const write = (s: Stash): boolean => {
  try { localStorage.setItem(STASH_KEY, JSON.stringify(s)); return true } catch { return false }
}

/**
 * Grava; se a cota estourar, saem os guardados dos OUTROS terminais, do mais
 * antigo para o mais novo (ordem de inserção das chaves), até caber. Os deste
 * terminal nunca são os sacrificados. Devolve se gravou de fato.
 */
function save(s: Stash, key: string): boolean {
  if (write(s)) return true
  for (const k of Object.keys(s).filter((k) => k !== key)) {
    delete s[k]
    if (write(s)) return true
  }
  return false
}

/** Lista vazia não deixa a chave para trás. */
function setList(s: Stash, key: string, lista: StashEntry[]): void {
  if (lista.length) s[key] = lista
  else delete s[key]
}

export function readStash(key: string): StashEntry[] {
  return readAll()[key] ?? []
}

/**
 * `true` só quando o guardado foi gravado de fato. Com o armazenamento cheio ou
 * bloqueado devolve `false`, e quem chama NÃO pode apagar o campo: o texto só
 * existiria ali.
 */
export function pushStash(key: string, entry: StashEntry): boolean {
  const s = readAll()
  // passando do teto, o mais antigo (o do começo) sai
  setList(s, key, [...(s[key] ?? []), entry].slice(-STASH_MAX))
  return save(s, key)
}

/** Tira e devolve o mais novo. */
export function popStash(key: string): StashEntry | undefined {
  const lista = readStash(key)
  return lista.length ? takeStash(key, lista.length - 1) : undefined
}

/** Tira e devolve o do índice (na ordem guardada: 0 é o mais antigo). */
export function takeStash(key: string, index: number): StashEntry | undefined {
  const s = readAll()
  const lista = s[key] ?? []
  if (!Number.isInteger(index) || index < 0 || index >= lista.length) return undefined
  const [entry] = lista.splice(index, 1)
  setList(s, key, lista)
  save(s, key)
  return entry
}
