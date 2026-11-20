import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { continueTaskResults, dismissTaskResults } from '../api'
import { isLive, sessionForEngine } from '../engineSession'
import { progressKey, useStore } from '../store'

/**
 * Aviso "A tarefa terminou", logo acima do campo do chat, para o terminal da aba
 * (projeto + motor): tarefas que este terminal delegou terminaram e o resultado
 * ainda não foi entregue ao agente.
 *
 * Só aparece com a sessão sem processo de pé: com ela viva, o Claudinei entrega
 * sozinho quando o turno acaba. **Continuar** revive o terminal e entrega; o ×
 * dispensa (o agente ainda lê o resultado em list_tasks). O aviso some quando o
 * servidor manda o estado sem pendentes (`terminal_state`) — o Continuar não o
 * tira sozinho, porque outro aviso (reinício) pode segurar a entrega.
 *
 * No limite de uso, quem fala é o aviso do limite ("N resultados esperando"): o
 * resultado espera o terminal voltar a trabalhar, e um segundo Continuar aqui
 * só competiria com as opções de lá.
 *
 * Estático de propósito: a interface precisa andar sem GPU (AGENTS.md).
 */
export function TaskResultNotice({ projectId, engine }: { projectId: number; engine: string }) {
  const { t } = useTranslation()
  const key = progressKey(projectId, engine)
  // Seletores estreitos: o array só muda de referência quando chega um estado novo
  // deste terminal; os booleanos não redesenham o aviso a cada evento do store.
  const results = useStore((s) => s.terminalStates[key]?.taskResults)
  const limited = useStore((s) => s.terminalStates[key]?.usageLimit != null)
  const live = useStore((s) => isLive(sessionForEngine(projectId, engine, s.sessions)))
  const [busy, setBusy] = useState(false)
  // O erro é das pendentes em que aconteceu: uma leva nova começa sem ele.
  const [error, setError] = useState<{ ids: string; message: string } | null>(null)

  if (!results || results.length === 0 || live || limited) return null
  const ids = results.map((r) => r.id).join(',')

  // O × e o "nada a continuar" (409) tiram o aviso na hora, sem esperar o WebSocket.
  // Parte do estado ATUAL do store: um interruptor mudado enquanto a chamada ia não volta atrás.
  const clear = () => {
    const atual = useStore.getState().terminalStates[key]
    if (atual) useStore.getState().setTerminalState({ ...atual, taskResults: [] })
  }

  const run = async (action: 'continue' | 'dismiss') => {
    setBusy(true); setError(null)
    try {
      if (action === 'continue') await continueTaskResults(projectId, engine)
      else { await dismissTaskResults(projectId, engine); clear() }
    } catch (err) {
      const e = err as Error & { code?: string }
      if (e.code === 'nothing_to_continue') clear()
      // O revive que falha não chega pelo WebSocket: o erro que a chamada devolveu é o único sinal.
      else setError({ ids, message: e.message })
    } finally { setBusy(false) }
  }

  const first = results[0]
  const message = results.length > 1
    ? t('taskResult.many', { count: results.length, ids: results.map((r) => `#${r.id}`).join(', ') })
    : t(first.status === 'failed' ? 'taskResult.failed' : 'taskResult.done', { id: first.id, project: first.toProjectName })

  return (
    <div className="restart-notice task-result-notice" role="status">
      <div className="restart-notice__head">
        <span aria-hidden="true">↩</span>
        <span className="restart-notice__text">{message}</span>
        <button type="button" disabled={busy} title={t('taskResult.continueHint')}
                onClick={() => void run('continue')}>{t('taskResult.continue')}</button>
        <button type="button" className="ghost restart-notice__close" disabled={busy}
                aria-label={t('taskResult.dismiss')} title={t('taskResult.dismiss')} onClick={() => void run('dismiss')}>×</button>
      </div>
      {error?.ids === ids && <div className="restart-notice__error">{error.message}</div>}
    </div>
  )
}
