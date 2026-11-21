import type { TFunction } from 'i18next'
import { scheduleRunText } from '../../shared/schedule-run'

/**
 * O motivo gravado de uma execução de agendamento (`run.error`) na língua da
 * interface: os motivos fixos do agendador são reconhecidos e traduzidos; o
 * resto (erro do motor, de rede) aparece como veio.
 */
export function runErrorLabel(t: TFunction, error: string): string {
  const known = scheduleRunText(error)
  if (!known) return error
  return t(`schedules.runText.${known.key}`, { time: known.time })
}
