/**
 * Motivos fixos que o agendador grava em `schedule_runs.error` (pulada, erro sem
 * contar falha). O servidor grava em português (é o que já está no banco); a web
 * reconhece cada um aqui e mostra na língua da interface. Texto desconhecido
 * (erro do motor, de rede…) aparece como veio.
 */
export const SCHEDULE_RUN_TEXTS = {
  previousRunning: 'execução anterior ainda rodando',
  sessionBusy: 'a sessão está ocupada',
  noticeHeld: 'aviso aberto esperando o operador',
  undoHeld: 'escrita do desfazer em andamento',
  restart: 'interrompida pelo reinício do Claudinei',
  projectGone: 'projeto do agendamento não existe mais',
} as const

/** Começo de toda falha por limite de uso; com hora, segue " — a janela reabre às HH:MM". */
export const USAGE_LIMIT_FAIL_PREFIX = 'limite de uso do Claude'
const USAGE_LIMIT_AT = /^limite de uso do Claude — a janela reabre às (\d{2}:\d{2})$/

export type ScheduleRunTextKey = keyof typeof SCHEDULE_RUN_TEXTS | 'usageLimit' | 'usageLimitAt'

/** O motivo conhecido por trás do texto gravado, ou `null`. */
export function scheduleRunText(error: string): { key: ScheduleRunTextKey; time?: string } | null {
  for (const [key, text] of Object.entries(SCHEDULE_RUN_TEXTS)) if (error === text) return { key: key as ScheduleRunTextKey }
  if (error === USAGE_LIMIT_FAIL_PREFIX) return { key: 'usageLimit' }
  const at = USAGE_LIMIT_AT.exec(error)
  return at ? { key: 'usageLimitAt', time: at[1] } : null
}
