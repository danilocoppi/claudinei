/**
 * Textos fixos do "bateu o limite": o que vai ao agente na retomada, o que fecha
 * quem esperava o turno limitado e o padrão que reconhece o limite no stream.
 */

/** Selo da mensagem de retomada: o agente (e quem lê o chat) sabe que foi o Claudinei. */
export const LIMIT_RESUME_PREFIX = '[Claudinei: resume after usage limit]'

/** Texto ao agente quando a janela reabre. Fixo, em inglês, como o do reinício. */
export const LIMIT_RESUME_TEXT = `${LIMIT_RESUME_PREFIX}: The usage limit window reopened. Continue where you left off; check the current state of the files before redoing anything.`

/** Começo de toda falha por limite: é por ele que o agendador reconhece o caso. */
export const USAGE_LIMIT_FAIL_PREFIX = 'limite de uso do Claude'

/**
 * Falha de quem esperava um turno que bateu no limite (tarefa encaminhada,
 * ask_agent, agendamento). `resetsAt` em epoch SEGUNDOS; a hora sai no fuso
 * local do servidor, em 24 h. Sem horário conhecido, só o prefixo.
 */
export function usageLimitFailText(resetsAt: number | null): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return USAGE_LIMIT_FAIL_PREFIX
  const d = new Date(resetsAt * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${USAGE_LIMIT_FAIL_PREFIX} — a janela reabre às ${hh}:${mm}`
}

/**
 * O texto que a CLI grava quando o limite bate (conferido nos transcripts):
 * "You've hit your session limit · resets 3:40pm (…)", "You've hit your weekly
 * limit · …", "Usage limit reached". O horário do "resets" não é interpretado:
 * ele vem do rate_limit_event.
 */
export const LIMIT_TEXT_RE = /You've hit your [a-z ]*limit|usage limit reached/i
