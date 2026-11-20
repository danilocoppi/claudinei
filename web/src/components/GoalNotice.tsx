import { useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { progressKey, useStore } from '../store'
import { WsContext } from '../wsContext'
import type { SessionStatus } from '../types'

/**
 * Status em que o servidor aceita a mensagem do chat (`manager.send`): sessão de
 * pé no Claudinei. Parada ou morta, o envio volta `session_not_active`; aberta
 * no terminal interativo, é o TUI que comanda e o campo do chat nem aparece.
 */
const ACCEPTS_SEND = new Set<SessionStatus>(['starting', 'idle', 'working', 'needs_attention'])

/**
 * Aviso do goal (`/goal`) parado, logo acima do campo do chat, para o terminal
 * da aba (projeto + motor): pausado, com o motivo, ou no teto de turnos.
 *
 * **Retomar** e **Encerrar** mandam `/goal resume` e `/goal stop` pelo mesmo
 * caminho do campo do chat (`send_message` no WebSocket); o servidor os
 * intercepta antes do agente, e nada vai à conversa. Por isso também não entram
 * como mensagem otimista no chat: sumiriam ao recarregar o histórico. O aviso
 * some quando o servidor publica o goal ativo (resume) ou sem goal (stop).
 *
 * Com a sessão parada, morta ou no terminal interativo, o envio seria recusado:
 * o aviso fica, com o motivo, e diz para iniciar o terminal — sem botões.
 *
 * Estático de propósito: a interface precisa andar sem GPU (AGENTS.md).
 */
export function GoalNotice({ projectId, engine, localId, sessionStatus }: {
  projectId: number
  engine: string
  localId: string
  sessionStatus?: SessionStatus
}) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const key = progressKey(projectId, engine)
  // Seletores de valores simples: o aviso não se redesenha com o resto do estado
  // do terminal (critério, evidência, resultados de tarefa, interruptores).
  const status = useStore((s) => s.terminalStates[key]?.goal?.status ?? null)
  const pause = useStore((s) => s.terminalStates[key]?.goal?.pause ?? null)
  const turns = useStore((s) => s.terminalStates[key]?.goal?.turns ?? 0)
  const max = useStore((s) => s.terminalStates[key]?.goal?.max ?? 0)
  // O clique vale para o estado em que foi dado: até o servidor mudar o goal, os
  // botões ficam desligados (sem `/goal resume` repetido a cada clique).
  const [sentFor, setSentFor] = useState<string | null>(null)

  if (status !== 'paused' && status !== 'cap') return null
  const stateKey = `${status}:${pause ?? ''}:${turns}`
  const canSend = sessionStatus != null && ACCEPTS_SEND.has(sessionStatus)
  const busy = sentFor === stateKey

  const send = (text: '/goal resume' | '/goal stop') => {
    ws?.send({ type: 'send_message', localId, text })
    setSentFor(stateKey)
  }

  const message = status === 'cap'
    ? t('goal.noticeCap', { max })
    : pause ? t('goal.noticePaused', { reason: t(`goal.pause.${pause}`) }) : t('goal.noticePausedPlain')

  return (
    <div className="restart-notice goal-notice" role="status">
      <div className="restart-notice__head">
        <span aria-hidden="true">🎯</span>
        <span className="restart-notice__text">{message}</span>
        {canSend && (
          <>
            <button type="button" disabled={busy} title={t('goal.resumeHint')}
                    onClick={() => send('/goal resume')}>{t('goal.resume')}</button>
            <button type="button" className="ghost" disabled={busy} title={t('goal.stopHint')}
                    onClick={() => send('/goal stop')}>{t('goal.stop')}</button>
          </>
        )}
      </div>
      {!canSend && <div className="limit-notice__waiting">{t('goal.needsSession')}</div>}
    </div>
  )
}
