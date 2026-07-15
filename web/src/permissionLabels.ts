import type { PermissionMode } from './types'

/** Chave i18n do rótulo de cada modo de permissão (compartilhado entre o modal de
 * início de sessão e o popover de controles). */
export const MODE_KEY: Record<PermissionMode, string> = {
  bypassPermissions: 'perm.bypass', default: 'perm.manual', auto: 'perm.auto', acceptEdits: 'perm.acceptEdits', plan: 'perm.plan',
}

/** Cor de destaque de cada modo (pill de controles da sessão). */
export const MODE_COLOR: Record<PermissionMode, string> = {
  bypassPermissions: '#5cffb3', default: '#e8b33f', auto: '#58c4dc', acceptEdits: '#4fd6c9', plan: '#a98bff',
}
