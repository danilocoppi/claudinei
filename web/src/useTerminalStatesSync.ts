import { useEffect } from 'react'
import { fetchTerminalStates } from './api'
import { progressKey, useStore } from './store'
import type { TerminalState } from './types'

/**
 * Lê do servidor o estado de reinício de todos os terminais (interruptores e
 * marca de interrompido) ao entrar e a cada reconexão (`progressEpoch`): o que
 * chegou pelo WebSocket durante a queda se perdeu. Montado no App, e não no chat,
 * porque o aviso de interrompido precisa estar certo em qualquer aba que se abra.
 *
 * A lista substitui o mapa (terminal que sumiu dela voltou ao padrão), menos as
 * entradas que o WebSocket mudou enquanto a leitura estava a caminho: essas são
 * mais novas que a resposta.
 */
export function useTerminalStatesSync(): void {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  useEffect(() => {
    if (!ready) return
    let alive = true
    const antes = useStore.getState().terminalStates
    fetchTerminalStates()
      .then((list) => {
        if (!alive) return
        const atual = useStore.getState().terminalStates
        const next: Record<string, TerminalState> = {}
        for (const st of list) next[progressKey(st.projectId, st.engine)] = st
        for (const [key, st] of Object.entries(atual)) {
          if (st !== antes[key]) next[key] = st
        }
        useStore.setState({ terminalStates: next })
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
    return () => { alive = false }
  }, [ready, epoch])
}
