import { useEffect } from 'react'
import { create } from 'zustand'
import { applyEvent, liveKey } from '../chat/applyEvent'
import { progressKey, useStore } from '../store'
import type { ChatItem, ClaudeEvent } from '../types'
import { getSide, type SideInfo } from './api'

/**
 * O estado da conversa lateral na web, num store próprio, fora do `store.ts`:
 * a lateral não é sessão (não tem `localId`, não entra em `sessions`, no chat
 * da principal nem nos não lidos). Uma por terminal+motor, pela mesma chave
 * do acompanhamento (`progressKey`).
 */

export interface SideView { info: SideInfo; items: ChatItem[] }

interface SideState {
  sides: Record<string, SideView>
  /** O `/side` recusado com `side_exists`: a coluna pergunta se fecha a atual e abre outra. */
  replaceAsk: { projectId: number; engine: string; text: string } | null
  /** Texto (e anexos `[token, caminho]`) a acrescentar ao campo da principal: o Trazer de volta. */
  appendRequest: { localId: string; text: string; attachments: Array<[string, string]>; seq: number } | null
}

export const useSideStore = create<SideState>(() => ({ sides: {}, replaceAsk: null, appendRequest: null }))

/** Grava o estado da lateral. Lateral nova (outro id, o `replace`) começa sem os itens da antiga. */
export function setSideInfo(info: SideInfo): void {
  const key = progressKey(info.projectId, info.engine)
  useSideStore.setState((s) => {
    const cur = s.sides[key]
    const items = cur && cur.info.id === info.id ? cur.items : []
    return { sides: { ...s.sides, [key]: { info, items } } }
  })
}

function removeSide(key: string): void {
  useSideStore.setState((s) => {
    if (!(key in s.sides)) return s
    const { [key]: _gone, ...rest } = s.sides
    return { sides: rest }
  })
}

/**
 * Um evento nos itens da lateral. Além do que o chat já monta (`applyEvent`),
 * o erro que o servidor publica na lateral (processo morto, envio recusado:
 * `result` com `subtype: 'error'`) vira item de erro; na principal esse aviso
 * chega por outro caminho, e na lateral não há outro.
 */
function applySideEvent(items: ChatItem[], evt: ClaudeEvent): ChatItem[] {
  if (evt.kind === 'result') {
    return evt.isError && evt.subtype === 'error' && evt.resultText
      ? [...items, { kind: 'command_output', text: evt.resultText, isError: true, key: liveKey() }]
      : items
  }
  return applyEvent(items, evt)
}

const isTarget = (msg: any): boolean => typeof msg.projectId === 'number' && typeof msg.engine === 'string'

/**
 * As mensagens da lateral no WebSocket (`side_state`, `side_event`). Devolve
 * true quando a mensagem era da lateral (consumida, mesmo que ignorada), para o
 * App não passá-la ao store principal.
 */
export function applySideMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object') return false
  if (msg.type === 'side_state') {
    if (!isTarget(msg)) return true
    if (msg.side && typeof msg.side === 'object' && typeof msg.side.id === 'string') setSideInfo(msg.side as SideInfo)
    else if (msg.side === null) removeSide(progressKey(msg.projectId, msg.engine))
    return true
  }
  if (msg.type === 'side_event') {
    if (!isTarget(msg) || !msg.event || typeof msg.event !== 'object') return true
    const key = progressKey(msg.projectId, msg.engine)
    useSideStore.setState((s) => {
      const view = s.sides[key]
      // Evento de uma lateral que já não é a deste terminal (fechada, substituída): fica de fora.
      if (!view || view.info.id !== msg.sideId) return s
      const items = applySideEvent(view.items, msg.event as ClaudeEvent)
      return items === view.items ? s : { sides: { ...s.sides, [key]: { ...view, items } } }
    })
    return true
  }
  return false
}

/**
 * A lateral do terminal (projeto + motor), lida do servidor ao montar e a cada
 * reconexão (`progressEpoch`): o que chegou pelo WebSocket durante a queda se
 * perdeu. O padrão do `useQueueSync`: se o WebSocket mudou a lateral enquanto a
 * leitura estava a caminho, a mudança é mais nova que a resposta e fica.
 */
export function useSideSync(projectId: number, engine: string): SideView | undefined {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  const key = progressKey(projectId, engine)
  useEffect(() => {
    if (!ready) return
    let alive = true
    const antes = useSideStore.getState().sides[key]
    getSide(projectId, engine)
      .then((snap) => {
        if (!alive || useSideStore.getState().sides[key] !== antes) return
        if (!snap?.side) { removeSide(key); return }
        const items = (snap.events ?? []).reduce(applySideEvent, [] as ChatItem[])
        useSideStore.setState((s) => ({ sides: { ...s.sides, [key]: { info: snap.side!, items } } }))
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
    return () => { alive = false }
  }, [ready, epoch, projectId, engine, key])
  return useSideStore((s) => s.sides[key])
}

/** Pede ao campo da principal (`localId`) que acrescente o texto; cada pedido ganha um `seq` novo. */
export function requestAppend(localId: string, text: string, attachments: Array<[string, string]> = []): void {
  useSideStore.setState((s) => ({ appendRequest: { localId, text, attachments, seq: (s.appendRequest?.seq ?? 0) + 1 } }))
}
