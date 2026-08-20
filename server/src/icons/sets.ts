import type { Db } from '../db.js'
import { PREFERRED_SETS, type IconifyDeps } from './iconify.js'

/**
 * Quais dos 200+ acervos da Iconify entram na busca.
 *
 * Sem esta peneira, "banco" trazia quinze bancos argentinos e "loja" trazia a
 * marca de roupa Maloja antes de qualquer desenho útil — são pacotes com o ícone
 * de CADA aplicativo Android (o arcticons sozinho tem 15 mil), e para nomear um
 * terminal eles são ruído puro.
 *
 * A regra é uma frase, não uma lista: iconografia de uso geral, sem emoji (já há
 * emoji de verdade ao lado), sem arquivo morto, e dos acervos de logo só os de
 * tecnologia. Uma lista de 149 prefixos cravada aqui ninguém revisaria — e
 * apodreceria calada a cada acervo novo que eles publicassem.
 *
 * Custa ~8 mil ícones dos 250 mil. Sobram ~242 mil, e todos são desenho.
 */
const ALLOWED_CATEGORIES = new Set([
  'UI 24px', 'UI Other / Mixed Grid', 'UI 16px / 32px', 'UI Multicolor',
  'Material', 'Programming', 'Thematic', 'Flags / Maps',
])

/** Da categoria "Logos", só estes — o resto é pacote de ícone de aplicativo. */
const ALLOWED_LOGO_SETS = new Set(['simple-icons', 'logos', 'devicon', 'skill-icons', 'vscode-icons'])

/** Acervo pequeno demais não cobre nada e só espalha o ranking. */
const MIN_ICONS = 150

/**
 * Sem catálogo, busca-se nos acervos de sempre em vez de não buscar em nada — os
 * mesmos que já encabeçam o ranking, para não haver duas listas divergindo.
 */
export const FALLBACK_SETS = PREFERRED_SETS

const SETTING_KEY = 'icons.prefixes'
/** O catálogo deles cresce devagar; uma semana é frequência de sobra. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * O termo é um pedaço INTEIRO do nome, ou só aparece por acaso no meio dele?
 *
 * "fila" achava `lightbulb-filament`, "master" achava `mastercard`, "backend"
 * achava `backendless`. Quem digita uma palavra quer o desenho DAQUILO, e um nome
 * onde o termo é um segmento vale mais que um onde ele é um caco.
 */
export function isWholeWord(name: string, term: string): boolean {
  if (name === term) return true
  return name.startsWith(`${term}-`) || name.endsWith(`-${term}`) || name.includes(`-${term}-`)
}

interface Collection { category?: unknown; total?: unknown }

function pick(catalog: Record<string, Collection>): string[] {
  const out: string[] = []
  for (const [prefix, info] of Object.entries(catalog)) {
    const category = typeof info?.category === 'string' ? info.category : ''
    const total = typeof info?.total === 'number' ? info.total : 0
    if (ALLOWED_LOGO_SETS.has(prefix)) { out.push(prefix); continue }
    if (total >= MIN_ICONS && ALLOWED_CATEGORIES.has(category)) out.push(prefix)
  }
  return out
}

/**
 * Os prefixos que a busca aceita, do catálogo publicado pela própria Iconify.
 * Uma consulta por semana por instalação — o resultado fica no banco.
 */
export async function allowedPrefixes(db: Db, deps: IconifyDeps = {}): Promise<string[]> {
  const row = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)
  if (row) {
    try {
      const saved = JSON.parse(row.value) as { at?: number; prefixes?: unknown }
      if (Array.isArray(saved.prefixes) && saved.prefixes.length > 0
        && typeof saved.at === 'number' && Date.now() - saved.at < MAX_AGE_MS) {
        return saved.prefixes as string[]
      }
    } catch { /* linha estragada é linha ausente */ }
  }

  const base = deps.base ?? 'https://api.iconify.design'
  const doFetch = deps.fetch ?? globalThis.fetch
  try {
    const r = await doFetch(`${base}/collections`)
    if (!r.ok) throw new Error(`collections ${r.status}`)
    const catalog = await r.json() as Record<string, Collection>
    const prefixes = pick(catalog ?? {})
    if (prefixes.length === 0) throw new Error('catálogo sem acervo utilizável')
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(SETTING_KEY, JSON.stringify({ at: Date.now(), prefixes }))
    return prefixes
  } catch {
    // Não fica gravado: o reserva é para AGORA, e a próxima busca tenta de novo.
    return FALLBACK_SETS
  }
}
