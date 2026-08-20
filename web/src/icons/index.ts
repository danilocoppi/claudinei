import { useSyncExternalStore } from 'react'

/**
 * O ícone de um terminal, grupo ou setor é uma STRING, e ela pode ser duas coisas:
 *
 *   📁            um emoji (o formato de sempre — nada foi migrado)
 *   mdi:server    um token do Iconify: `acervo:nome`
 *
 * Os desenhos NÃO viajam dentro do binário. Eram 4,7 MB de `brands.json` e
 * `lucide-static` embutidos para 5.229 ícones — que ainda assim devolviam zero
 * resultados para "admin", "deploy" ou "financeiro". Agora o servidor consulta o
 * Iconify (~250 mil desenhos) e guarda o que baixa: o binário encolheu, o acervo
 * multiplicou por cinquenta.
 *
 * `si:` e `lu:` eram os prefixos dos dois acervos embutidos. No Iconify os mesmos
 * desenhos atendem por `simple-icons:` e `lucide:`, com os mesmos nomes — então o
 * que está gravado no banco continua valendo, traduzido na leitura.
 */
export type ParsedIcon =
  | { kind: 'iconify'; token: string }
  | { kind: 'emoji'; char: string }

export interface IconBody { token: string; body: string; width: number; height: number }

const LEGACY: Record<string, string> = { si: 'simple-icons', lu: 'lucide' }
const TOKEN_RE = /^([a-z0-9-]+):([a-z0-9-]+)$/

export function parseIcon(value: string | undefined | null): ParsedIcon {
  const raw = (value ?? '').trim()
  const m = TOKEN_RE.exec(raw)
  if (!m) return { kind: 'emoji', char: raw }
  const prefix = LEGACY[m[1]] ?? m[1]
  return { kind: 'iconify', token: `${prefix}:${m[2]}` }
}

/* ------------------------------------------------------------------------- *
 * O acervo em memória
 * ------------------------------------------------------------------------- */

/** Um token que o servidor não achou. Fica gravado para não virar laço de pedidos. */
const MISSING: IconBody = { token: '', body: '', width: 0, height: 0 }

const LS_KEY = 'claudinei.icons.v1'
/** Quantos desenhos ficam guardados no navegador. Uma instalação inteira cabe. */
const LS_MAX = 500

const cache = new Map<string, IconBody>()
const wanted = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let flushing: ReturnType<typeof setTimeout> | null = null

const notify = () => { version++; listeners.forEach((fn) => fn()) }

function readDisk(): void {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    for (const [token, icon] of Object.entries(JSON.parse(raw) as Record<string, IconBody>)) {
      if (icon?.body) cache.set(token, icon)
    }
  } catch { /* cache corrompido é cache vazio, não é erro */ }
}

function writeDisk(): void {
  try {
    // Só o que TEM desenho: guardar as ausências no disco congelaria um ícone que
    // volta a existir no acervo.
    const real = [...cache.entries()].filter(([, i]) => i.body).slice(-LS_MAX)
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(real)))
  } catch { /* cota cheia: o cache do servidor ainda responde rápido */ }
}

readDisk()

/**
 * Junta num pedido só tudo que a tela pediu no mesmo tique.
 *
 * A sidebar tem um ícone por terminal: sem o lote, abrir o app dispararia uma
 * requisição por cartão.
 */
async function flush(): Promise<void> {
  flushing = null
  const batch = [...wanted]
  wanted.clear()
  if (batch.length === 0) return
  try {
    // Sem escapar: `want` só deixa passar token `acervo:nome`, e os dois pontos são
    // legais numa query. O que se ganha é uma URL legível na aba de rede.
    const r = await fetch(`/api/icons/bodies?tokens=${batch.join(',')}`)
    const { icons } = await r.json() as { icons: IconBody[] }
    for (const icon of icons) if (icon?.token) cache.set(icon.token, icon)
  } catch { /* sem resposta, os que faltarem viram ausência abaixo */ }
  // O que não voltou fica marcado: pedir de novo a cada render seria um laço.
  for (const token of batch) if (!cache.has(token)) cache.set(token, MISSING)
  writeDisk()
  notify()
}

function want(token: string): void {
  // O token compõe a URL do pedido: o que não tem a cara certa não vai.
  if (!TOKEN_RE.test(token) || cache.has(token) || wanted.has(token)) return
  wanted.add(token)
  flushing ??= setTimeout(() => { void flush() }, 0)
}

/** O desenho deste token, ou `undefined` enquanto não chega. */
export function useIconBody(token: string | null): IconBody | undefined {
  useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => version,
    () => version,
  )
  if (!token) return undefined
  want(token)
  const icon = cache.get(token)
  return icon?.body ? icon : undefined
}

/** Guarda os desenhos que já vieram prontos (a busca traz o desenho junto). */
export function rememberIcons(icons: IconBody[]): void {
  let novo = false
  for (const icon of icons) {
    if (icon?.token && icon.body && !cache.has(icon.token)) { cache.set(icon.token, icon); novo = true }
  }
  if (novo) { writeDisk(); notify() }
}

/** Só para o teste: zerar entre casos, e reler o disco como faria um reload. */
export const iconCacheForTest = {
  clear() { cache.clear(); wanted.clear(); version++ },
  reloadFromDisk() { cache.clear(); readDisk(); version++ },
}
