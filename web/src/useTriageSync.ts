import { useEffect } from 'react'
import { fetchTriage } from './api'
import { useStore } from './store'
import type { TriageItem } from './types'

/**
 * Lê do servidor a triagem do usuário (fixados, assentados e adiados) ao entrar e
 * a cada reconexão (`progressEpoch`): o que chegou pelo WebSocket durante a queda
 * se perdeu — inclusive um despertar. Montado no App, junto do
 * `useTerminalStatesSync`, de quem copia o padrão.
 *
 * A lista substitui o mapa (projeto que sumiu dela voltou ao normal), menos as
 * entradas que o WebSocket mudou enquanto a leitura estava a caminho: essas são
 * mais novas que a resposta.
 */
export function useTriageSync(): void {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  useEffect(() => {
    if (!ready) return
    let alive = true
    const antes = useStore.getState().triage
    fetchTriage()
      .then((list) => {
        if (!alive) return
        const atual = useStore.getState().triage
        const next: Record<number, TriageItem> = {}
        for (const item of list) next[item.projectId] = item
        for (const [id, item] of Object.entries(atual)) {
          if (item !== antes[Number(id)]) next[Number(id)] = item
        }
        useStore.setState({ triage: next })
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
    return () => { alive = false }
  }, [ready, epoch])
}
