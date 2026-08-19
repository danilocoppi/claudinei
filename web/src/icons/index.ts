import { useSyncExternalStore } from 'react'

/**
 * O ícone de um terminal, grupo ou setor é uma STRING, e ela pode ser três coisas:
 *
 *   📁            um emoji (o formato de sempre — nada foi migrado)
 *   si:react      um logo de marca (Simple Icons)
 *   lu:terminal   um ícone de linha (Lucide)
 *
 * O prefixo é o que permite os três conviverem no mesmo campo, sem migração de
 * dados e sem uma coluna nova: o que já está gravado continua sendo emoji.
 */
export type ParsedIcon =
  | { kind: 'brand'; id: string }
  | { kind: 'lucide'; id: string }
  | { kind: 'emoji'; char: string }

export type IconSet = 'brand' | 'lucide'

export function parseIcon(value: string | undefined | null): ParsedIcon {
  const raw = (value ?? '').trim()
  const m = /^(si|lu):([a-z0-9-]+)$/.exec(raw)
  if (m) return m[1] === 'si' ? { kind: 'brand', id: m[2] } : { kind: 'lucide', id: m[2] }
  return { kind: 'emoji', char: raw }
}

export const iconToken = (set: IconSet, id: string) => `${set === 'brand' ? 'si' : 'lu'}:${id}`

/** Um nó do Lucide: nome do elemento SVG + atributos. */
export type LucideNode = [string, Record<string, string>]

export interface BrandIcon { s: string; t: string; p: string }

interface Loaded {
  brands?: BrandIcon[]
  brandBySlug?: Map<string, BrandIcon>
  lucide?: Record<string, LucideNode[]>
}

const data: Loaded = {}
const pending = new Map<IconSet, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0

const notify = () => { version++; listeners.forEach((fn) => fn()) }

/**
 * Carrega o conjunto sob demanda. São ~4 MB de desenhos entre as duas coleções —
 * peso que só faz sentido pagar quando alguém abre o seletor, nunca no boot.
 */
export function loadIconSet(set: IconSet): Promise<void> {
  if ((set === 'brand' && data.brands) || (set === 'lucide' && data.lucide)) return Promise.resolve()
  const already = pending.get(set)
  if (already) return already

  const job = (set === 'brand'
    ? import('./brands.json').then((m) => {
      data.brands = m.default as BrandIcon[]
      data.brandBySlug = new Map(data.brands.map((b) => [b.s, b]))
    })
    : import('lucide-static/icon-nodes.json').then((m) => {
      data.lucide = m.default as unknown as Record<string, LucideNode[]>
    })
  ).then(notify).catch(() => { /* sem o conjunto, o ícone cai no reserva */ })

  pending.set(set, job)
  return job
}

/** Re-renderiza quem depende de um conjunto quando ele termina de chegar. */
export function useIconSet(set: IconSet | null): number {
  const v = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => version,
    () => version,
  )
  if (set) void loadIconSet(set)
  return v
}

export const brandPath = (slug: string): string | undefined => data.brandBySlug?.get(slug)?.p
export const lucideNodes = (name: string): LucideNode[] | undefined => data.lucide?.[name]
export const allBrands = (): BrandIcon[] => data.brands ?? []
export const allLucide = (): string[] => Object.keys(data.lucide ?? {})
