/**
 * Built-ins úteis no chat, com descrição (chave i18n). Ordem de destaque.
 * Cobre tanto os comandos do protocolo do Claude quanto os curados de outras
 * engines (ex.: Codex: approvals/init/review/diff/undo) — a fonte de VERDADE de
 * quais comandos aparecem por sessão é `useSessionSlashCommands` (store.ts); este
 * mapa só fornece a descrição quando existe (degrada bem sem ela).
 */
export const SLASH_DESCRIPTIONS: Record<string, string> = {
  compact: 'slash.compact',
  cost: 'slash.cost',
  context: 'slash.context',
  usage: 'slash.usage',
  clear: 'slash.clear',
  model: 'slash.model',
  mcp: 'slash.mcp',
  agents: 'slash.agents',
  approvals: 'slash.approvals',
  init: 'slash.init',
  review: 'slash.review',
  diff: 'slash.diff',
  undo: 'slash.undo',
  new: 'slash.new',
  sessions: 'slash.sessions',
  models: 'slash.models',
  share: 'slash.share',
  redo: 'slash.redo',
}

/**
 * Usado antes do 1º init do Claude chegar (os comandos reais do protocolo
 * substituem depois — ver `slashCommands` no store). Lista fixa e SEM os
 * comandos curados de outras engines (approvals/init/review/diff/undo são
 * Codex-only; nunca fizeram parte do protocolo do Claude).
 */
export const BUILTIN_FALLBACK: string[] = ['compact', 'cost', 'context', 'usage', 'clear', 'model', 'mcp', 'agents']

/** Comandos só-TUI que não fazem nada útil no chat headless. */
export const HIDDEN = new Set(['exit', 'help'])

/**
 * Filtra por substring (case-insensitive) no nome, exclui os HIDDEN e ordena:
 * built-ins com descrição primeiro (na ordem do mapa), depois alfabético.
 */
export function filterCommands(all: string[], query: string): string[] {
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const matches = all.filter((c) => {
    if (HIDDEN.has(c) || seen.has(c)) return false
    seen.add(c)
    return c.toLowerCase().includes(q)
  })
  const order = Object.keys(SLASH_DESCRIPTIONS)
  return matches.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    }
    return a.localeCompare(b)
  })
}
