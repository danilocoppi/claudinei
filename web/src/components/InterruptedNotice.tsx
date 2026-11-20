import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { continueTerminal, dismissInterruption } from '../api'
import { progressKey, useStore } from '../store'

/**
 * Aviso de trabalho interrompido pelo reinício do Claudinei, logo acima do campo
 * do chat, para o terminal da aba (projeto + motor).
 *
 * Na fila para retomar sozinho (`queued`), só informa. Nos demais motivos o turno
 * ficou esperando o operador: **Continuar** revive a sessão, se preciso, e manda a
 * mensagem de retomada; o × tira o aviso sem retomar. O aviso some quando o
 * servidor manda o estado sem interrupção (`terminal_state`).
 *
 * Estático de propósito: a interface precisa andar sem GPU (AGENTS.md), e um aviso
 * que pulsa enquanto espera custaria quadros o tempo todo.
 */
export function InterruptedNotice({ projectId, engine }: { projectId: number; engine: string }) {
  const { t } = useTranslation()
  const key = progressKey(projectId, engine)
  const state = useStore((s) => s.terminalStates[key])
  const [busy, setBusy] = useState(false)
  // O erro é da interrupção em que aconteceu: uma interrupção nova começa sem ele.
  const [error, setError] = useState<{ at: string; message: string } | null>(null)

  const interruption = state?.interruption
  if (!state || !interruption) return null

  // O × e o "nada a continuar" (409) tiram o aviso na hora, sem esperar o WebSocket.
  // Parte do estado ATUAL do store: um interruptor mudado enquanto a chamada ia não volta atrás.
  const clear = () => {
    const atual = useStore.getState().terminalStates[key]
    if (atual) useStore.getState().setTerminalState({ ...atual, interruption: null })
  }

  const run = async (action: 'continue' | 'dismiss') => {
    setBusy(true); setError(null)
    try {
      if (action === 'continue') await continueTerminal(projectId, engine)
      else { await dismissInterruption(projectId, engine); clear() }
    } catch (err) {
      const e = err as Error & { code?: string }
      if (e.code === 'nothing_to_continue') clear()
      // O revive que falha não chega pelo WebSocket: o erro que a chamada devolveu é o único sinal.
      else setError({ at: interruption.at, message: e.message })
    } finally { setBusy(false) }
  }

  if (interruption.reason === 'queued') {
    return (
      <div className="restart-notice restart-notice--queued" role="status">
        <div className="restart-notice__head">
          <span aria-hidden="true">↻</span>
          <span className="restart-notice__text">{t('restart.queued')}</span>
        </div>
      </div>
    )
  }

  const message = interruption.reason === 'limit' ? t('restart.limit')
    : interruption.reason === 'failed' ? t('restart.failed')
    : t('restart.interrupted')
  const lost = interruption.reason === 'question' ? interruption.question ?? [] : []

  return (
    <div className="restart-notice" role="status">
      <div className="restart-notice__head">
        <span aria-hidden="true">↻</span>
        <span className="restart-notice__text">{message}</span>
        <button type="button" disabled={busy} onClick={() => void run('continue')}>{t('restart.continue')}</button>
        <button type="button" className="ghost restart-notice__close" disabled={busy}
                aria-label={t('restart.dismiss')} title={t('restart.dismiss')} onClick={() => void run('dismiss')}>×</button>
      </div>
      {interruption.reason === 'question' && (
        <div className="restart-notice__lost">
          <div>{t('restart.questionLost', { count: Math.max(lost.length, 1) })}</div>
          {lost.length > 0 && (
            <ul>{lost.map((q, i) => <li key={i}>{q.question}</li>)}</ul>
          )}
        </div>
      )}
      {error?.at === interruption.at && <div className="restart-notice__error">{error.message}</div>}
    </div>
  )
}
