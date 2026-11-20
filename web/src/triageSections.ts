import type { Project, SessionInfo, TriageItem } from './types'
import type { Entry } from './sidebarEntries'
import { displayStatusKey, isTerminalProcessing } from './engineSession'

/**
 * Triagem da lista: em que seção da lateral cada terminal mora. Tudo aqui é puro
 * e recebe `now` de fora — quem desenha decide quando reler o relógio (o
 * `nextExpiry` diz quando o próximo adiamento vence).
 */
export type TriageState = 'pinned' | 'settled' | 'snoozed' | 'none'

/**
 * O estado visível do projeto. O adiamento vencido deixa de valer aqui mesmo (o
 * servidor só zera na próxima leitura): volta ao pin, se havia, ou ao normal.
 * Assentado e adiado se excluem no servidor; o adiado vigente vem primeiro porque
 * adiar mantém o pin, e o cartão sai dos Fixados até voltar.
 */
export function triageStateOf(item: TriageItem | undefined, now: number): TriageState {
  if (!item) return 'none'
  if (item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now) return 'snoozed'
  if (item.settled) return 'settled'
  if (item.pinned) return 'pinned'
  return 'none'
}

export interface Sections {
  /**
   * Na ordem do usuário (`pinOrder`, que ele arrasta). Os sem posição (pins de
   * antes da ordem) vêm antes, na ordem visual da lateral (setor → grupo →
   * terminal, pelo `sortOrder`); fixar de novo vai para o fim.
   */
  pinned: Project[]
  /** A árvore sem fixados, assentados e adiados. */
  tree: Entry[]
  /** Volta mais cedo primeiro. */
  snoozed: Project[]
  /** Na ordem visual da lateral. */
  settled: Project[]
}

type Child = Extract<Entry, { kind: 'group' | 'project' }>

/**
 * Divide a árvore nas quatro seções numa passagem só (a lateral roda isto a cada
 * mudança, com dezenas de terminais). Assentados saem na ordem em que a árvore os
 * visita, que é a ordem global da lateral; Fixados, na ordem do usuário, com a
 * global desempatando os sem posição.
 *
 * Contêiner que ESVAZIOU porque seus terminais foram para outra seção some (o
 * setor também, se só tinha o que esvaziou). Contêiner que já chegou vazio fica:
 * é o alvo de arraste de um grupo ou setor recém-criado. Entrada sem mudança
 * volta a mesma (mesmo objeto).
 *
 * Quem trabalha não acorda aqui: só o servidor tira um assentado ou adiado.
 */
export function splitSections(entries: Entry[], triage: Record<number, TriageItem>, now: number): Sections {
  const pinned: Project[] = []
  const settled: Project[] = []
  const snoozed: Array<{ p: Project; at: number }> = []

  /** Fica na árvore? Se não, já entra na seção dele. */
  const stays = (p: Project): boolean => {
    const item = triage[p.id]
    if (!item) return true
    switch (triageStateOf(item, now)) {
      case 'pinned': pinned.push(p); return false
      case 'settled': settled.push(p); return false
      case 'snoozed': snoozed.push({ p, at: Date.parse(item.snoozedUntil as string) }); return false
      default: return true
    }
  }

  const walk = (e: Entry): Entry | null => {
    if (e.kind === 'project') return stays(e.p) ? e : null
    if (e.kind === 'group') {
      const items = e.items.filter(stays)
      if (items.length === e.items.length) return e
      return items.length > 0 ? { ...e, items } : null
    }
    let changed = false
    const children: Child[] = []
    for (const c of e.children) {
      const kept = walk(c) as Child | null
      if (kept !== c) changed = true
      if (kept) children.push(kept)
    }
    if (!changed) return e
    return children.length > 0 ? { ...e, children } : null
  }

  const tree: Entry[] = []
  for (const e of entries) {
    const kept = walk(e)
    if (kept) tree.push(kept)
  }
  snoozed.sort((a, b) => a.at - b.at)
  // `sort` é estável: os sem posição (-1) ficam na ordem em que a árvore os visitou.
  const rank = (p: Project) => triage[p.id]?.pinOrder ?? -1
  pinned.sort((a, b) => rank(a) - rank(b))
  return { pinned, tree, snoozed: snoozed.map((s) => s.p), settled }
}

/**
 * Arrastar dentro dos Fixados: `dragId` solto sobre `targetId`. Como na árvore
 * (`moveEntry`), quem vem de cima entra depois do alvo e quem vem de baixo, antes
 * — assim qualquer posição, inclusive a última, é alcançável. Sem mudança (sobre
 * si mesmo, ou id fora da lista), devolve a mesma lista.
 */
export function movePinned(ids: number[], dragId: number, targetId: number): number[] {
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  if (from === -1 || to === -1 || from === to) return ids
  const rest = ids.filter((id) => id !== dragId)
  const at = rest.indexOf(targetId) + (from < to ? 1 : 0)
  return [...rest.slice(0, at), dragId, ...rest.slice(at)]
}

/**
 * O projeto entra na faixa Trabalhando? Sessão `working`, compactando, ou o
 * terminal interativo processando — este pela mesma fonte do rosto
 * (`isTerminalProcessing`, usado por `faceStateOf`).
 */
export function isWorking(projectId: number, sessions: Record<string, SessionInfo>): boolean {
  for (const s of Object.values(sessions)) {
    if (s.projectId === projectId && isSessionWorking(s)) return true
  }
  return false
}

/** A sessão está em atividade, pelo critério da faixa Trabalhando (ver `isWorking`). */
export function isSessionWorking(s: SessionInfo): boolean {
  return s.status === 'working' || !!s.compactingSince || isTerminalProcessing(s)
}

/** Uma linha da faixa Trabalhando: uma sessão em atividade. */
export interface WorkingRow {
  localId: string
  projectId: number
  engine: string
  /** Chave de `status.*` (a mesma do cartão: `displayStatusKey`). */
  statusKey: string
}

/**
 * As linhas da faixa numa passagem só pelas sessões (nunca um `isWorking` por
 * projeto, que seria projetos × sessões a cada evento). O assentado entra (não
 * acorda por trabalhar); o adiado vigente não entra, porque o operador pediu
 * silêncio. Ordenadas por projeto, motor e sessão: a mesma situação dá sempre a
 * mesma lista, e quem compara por valor não vê mudança onde não há.
 */
export function workingRows(sessions: Record<string, SessionInfo>, triage: Record<number, TriageItem>, now: number): WorkingRow[] {
  const rows: WorkingRow[] = []
  for (const s of Object.values(sessions)) {
    if (!isSessionWorking(s)) continue
    if (triageStateOf(triage[s.projectId], now) === 'snoozed') continue
    rows.push({ localId: s.localId, projectId: s.projectId, engine: s.engine, statusKey: displayStatusKey(s) })
  }
  return rows.sort((a, b) => a.projectId - b.projectId || a.engine.localeCompare(b.engine) || a.localId.localeCompare(b.localId))
}

/** Quando (epoch ms) vence o próximo adiamento ainda futuro; `null` = nenhum. */
export function nextExpiry(triage: Record<number, TriageItem>, now: number): number | null {
  let next: number | null = null
  for (const item of Object.values(triage)) {
    if (item.snoozedUntil === null) continue
    const at = Date.parse(item.snoozedUntil)
    if (at > now && (next === null || at < next)) next = at
  }
  return next
}

const HOUR_MS = 3_600_000
/** "Amanhã às 9:00" pedido antes desta hora é o mesmo dia: quem ainda não dormiu quer dizer "de manhã". */
const EARLY_HOURS_END = 5
const WAKE_HOUR = 9

/** 9:00 local, `days` dias depois do dia de `base` (o construtor local acerta o horário de verão). */
const nineAm = (base: Date, days: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, WAKE_HOUR, 0, 0, 0)

/**
 * O horário absoluto de cada opção de adiar, no fuso do navegador (o de `now`):
 * - `1h`: daqui a uma hora;
 * - `tomorrow`: amanhã às 9:00, ou hoje às 9:00 se pedido entre 0 h e 5 h;
 * - `monday`: a próxima segunda às 9:00 ainda por vir (numa segunda depois das
 *   9:00, a da semana seguinte).
 */
export function snoozeUntil(choice: '1h' | 'tomorrow' | 'monday', now: Date): Date {
  if (choice === '1h') return new Date(now.getTime() + HOUR_MS)
  if (choice === 'tomorrow') return nineAm(now, now.getHours() < EARLY_HOURS_END ? 0 : 1)
  const toMonday = (8 - now.getDay()) % 7
  const monday = nineAm(now, toMonday)
  return monday.getTime() > now.getTime() ? monday : nineAm(now, toMonday + 7)
}
