/**
 * As regras puras da coluna da direita do chat: um lugar só, com três vistas
 * (Acompanhamento, conversa Lateral e Navegador), uma de cada vez. Quem toma a
 * coluna, para onde ela volta e as larguras. Sem React e sem armazenamento: o
 * `columnStore.ts` guarda o estado e chama estas funções.
 * Ver "Desenho — web" em docs/superpowers/specs/2026-11-21-navegador-embutido-design.md.
 */

export type View = 'progress' | 'side' | 'browser'

export interface ColumnState {
  open: boolean
  view: View
  /** A vista de antes da lateral nascer (`'closed'`: a coluna estava fechada); `null` sem lateral. */
  previous: View | 'closed' | null
  fullscreen: boolean
  /** Vistas com a marca estática na aba (o agente abriu o navegador com a Lateral à vista). */
  marked: View[]
}

/** O que existe no terminal agora, além do Acompanhamento (sempre). */
export interface Avail { side: boolean; browser: boolean }

const unmark = (marked: View[], v: View): View[] => (marked.includes(v) ? marked.filter((m) => m !== v) : marked)

/** Fechar a coluna também sai da tela cheia: reabrir é voltar à coluna ao lado do chat. */
export const close = (s: ColumnState): ColumnState => ({ ...s, open: false, fullscreen: false })

/** A lateral nasceu: toma a coluna e lembra o que havia (a vista, ou a coluna fechada). */
export function sideBorn(s: ColumnState): ColumnState {
  if (s.open && s.view === 'side') return s
  return { ...s, previous: s.open ? s.view : 'closed', open: true, view: 'side', marked: unmark(s.marked, 'side') }
}

/**
 * A lateral sumiu: com ela à vista, volta o que havia antes (fecha, se a coluna
 * estava fechada). Com o operador já noutra vista, ela fica.
 */
export function sideGone(s: ColumnState): ColumnState {
  if (s.view !== 'side') return s.previous === null ? s : { ...s, previous: null }
  if (s.previous === 'closed') return { ...close(s), view: 'progress', previous: null }
  const view: View = s.previous === null || s.previous === 'side' ? 'progress' : s.previous
  return { ...s, view, previous: null, marked: unmark(s.marked, view) }
}

/**
 * O agente abriu o navegador do terminal à vista: fechada ou no Acompanhamento,
 * a coluna vai ao Navegador; com a Lateral à vista, só a aba ganha a marca.
 */
export function agentOpened(s: ColumnState): ColumnState {
  if (s.open && s.view === 'browser') return s
  if (s.open && s.view === 'side') return s.marked.includes('browser') ? s : { ...s, marked: [...s.marked, 'browser'] }
  return selectView(s, 'browser')
}

/** Aberta na mesma vista, fecha; senão abre nela. */
export function toggleView(s: ColumnState, v: View): ColumnState {
  return s.open && s.view === v ? close(s) : selectView(s, v)
}

/** Abre na vista e tira a marca dela. */
export function selectView(s: ColumnState, v: View): ColumnState {
  return { ...s, open: true, view: v, marked: unmark(s.marked, v) }
}

/** A vista à mostra: a guardada, ou o Acompanhamento quando ela não existe no terminal; `null` com a coluna fechada. */
export function effectiveView(s: ColumnState, avail: Avail): View | null {
  if (!s.open) return null
  if (s.view === 'side' && !avail.side) return 'progress'
  if (s.view === 'browser' && !avail.browser) return 'progress'
  return s.view
}

/** As abas: Acompanhamento sempre; Lateral e Navegador enquanto existem. */
export function tabsFor(avail: Avail): View[] {
  const out: View[] = ['progress']
  if (avail.side) out.push('side')
  if (avail.browser) out.push('browser')
  return out
}

/** Folga mínima do chat ao lado da coluna. */
const CHAT_MIN = 320

/**
 * A largura da vista numa área (`.chat-layout`) de `area` px: Acompanhamento e
 * Lateral 340 por padrão, mínimo 280; Navegador metade da área, mínimo 360. O
 * máximo deixa 320 px ao chat; numa área estreita demais o mínimo vence (no
 * celular a coluna cobre o chat pelo CSS).
 */
export function columnWidth(view: View, stored: number | undefined, area: number): number {
  const browser = view === 'browser'
  const min = browser ? 360 : 280
  const want = stored ?? (browser ? area / 2 : 340)
  return Math.round(Math.max(min, Math.min(area - CHAT_MIN, want)))
}
