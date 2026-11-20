import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { continueTaskResults, dismissTaskResults } from '../api'
import { LIVE_STATUSES, sessionForEngine } from '../engineSession'
import { progressKey, useStore } from '../store'

/**
 * Aviso "A tarefa terminou", logo acima do campo do chat, para o terminal da aba
 * (projeto + motor): tarefas que este terminal delegou terminaram e o resultado
 * ainda não foi entregue ao agente.
 *
 * Aparece quando o resultado não sai sozinho: a sessão está parada, ou a marca do
 * limite de uso o segura (`taskResultsHeld`: o limite está ativo, ou saiu e o
 * terminal ainda não voltou a trabalhar). Com a sessão viva e livre, o Claudinei
 * entrega sozinho no fim do turno. **Continuar** revive o terminal, se preciso, e
 * entrega; o × dispensa (o agente ainda lê o resultado em list_tasks). O aviso
 * some quando o servidor manda o estado sem pendentes (`terminal_state`) — o
 * Continuar não o tira sozinho, porque outro aviso pode segurar a entrega.
 *
 * Fica de fora:
 * - com o aviso de interrompido aberto: um Continuar só na tela, o dele;
 * - com o aviso do limite na tela (`none`/`armed`): ele mostra a contagem;
 * - com o limite ainda ativo (adiado), aparece sem Continuar: o limite segura a
 *   entrega de todo jeito, e o botão prometeria o que não acontece.
 *
 * Estático de propósito: a interface precisa andar sem GPU (AGENTS.md).
 */
export function TaskResultNotice({ projectId, engine }: { projectId: number; engine: string }) {
  const { t } = useTranslation()
  const key = progressKey(projectId, engine)
  // Seletores estreitos: o array só muda de referência quando chega um estado novo
  // deste terminal; os demais são valores simples e não redesenham o aviso à toa.
  const results = useStore((s) => s.terminalStates[key]?.taskResults)
  const held = useStore((s) => s.terminalStates[key]?.taskResultsHeld === true)
  const interrupted = useStore((s) => s.terminalStates[key]?.interruption != null)
  const limitAction = useStore((s) => s.terminalStates[key]?.usageLimit?.action ?? null)
  const status = useStore((s) => sessionForEngine(projectId, engine, s.sessions)?.status)
  const [busy, setBusy] = useState(false)
  // O erro é das pendentes em que aconteceu: uma leva nova começa sem ele.
  const [error, setError] = useState<{ ids: string; message: string } | null>(null)

  if (!results || results.length === 0 || interrupted) return null
  if (limitAction === 'none' || limitAction === 'armed') return null
  // Aberta no terminal: o Continuar subiria (bringUp) um terminal que o TUI é que comanda.
  if (status === 'working' || status === 'in_terminal') return null
  const stopped = status == null || !LIVE_STATUSES.has(status)
  if (!stopped && !held) return null
  // Limite ainda ativo (adiado): só informa e oferece o ×.
  const canContinue = limitAction == null
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
        {canContinue && (
          <button type="button" disabled={busy} title={t('taskResult.continueHint')}
                  onClick={() => void run('continue')}>{t('taskResult.continue')}</button>
        )}
        <button type="button" className="ghost restart-notice__close" disabled={busy}
                aria-label={t('taskResult.dismiss')} title={t('taskResult.dismiss')} onClick={() => void run('dismiss')}>×</button>
      </div>
      {!canContinue && <div className="limit-notice__waiting">{t('taskResult.heldByLimit')}</div>}
      {error?.ids === ids && <div className="restart-notice__error">{error.message}</div>}
    </div>
  )
}
