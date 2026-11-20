import { useEffect } from 'react'
import { fetchQueue } from './api'
import { progressKey, queueSeqOf, useStore } from './store'

/**
 * Lê do servidor a fila do operador do terminal (projeto + motor) ao montar e a
 * cada reconexão (`progressEpoch`): o que chegou pelo WebSocket durante a queda
 * se perdeu. Copia o padrão do `useTerminalStatesSync`: se o WebSocket (ou uma
 * resposta da API) mudou a fila enquanto a leitura estava a caminho, a mudança
 * é mais nova que a resposta e fica.
 */
export function useQueueSync(projectId: number, engine: string): void {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  useEffect(() => {
    if (!ready) return
    let alive = true
    const key = progressKey(projectId, engine)
    const antes = useStore.getState().queues[key]
    const seq = queueSeqOf(projectId, engine)
    fetchQueue(projectId, engine)
      .then((queue) => {
        // Uma resposta da API aplicada no meio também é mais nova que a leitura.
        if (!alive || useStore.getState().queues[key] !== antes) return
        useStore.getState().applyQueueReply({ ...queue, projectId, engine }, seq)
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
    return () => { alive = false }
  }, [ready, epoch, projectId, engine])
}
