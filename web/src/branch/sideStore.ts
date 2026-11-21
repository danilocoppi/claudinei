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
 * Tira a lateral do terminal se ainda for a de `id` (o × fechou; o `side_state`
 * null pode não vir, se o WebSocket caiu). Outra lateral no lugar fica.
 */
export function dropSide(projectId: number, engine: string, id: string): void {
  const key = progressKey(projectId, engine)
  if (useSideStore.getState().sides[key]?.info.id === id) removeSide(key)
}

/**
 * O que chegou pelo WebSocket enquanto uma releitura (`useSideRead`) estava a
 * caminho: os `side_event` são incrementais, e a resposta do GET pode não ter os
 * mais novos. Uma anotação por leitura em curso, por terminal.
 */
interface ReadLog { events: Array<{ sideId: string; event: ClaudeEvent }>; states: Set<string> }
const reading = new Map<string, Set<ReadLog>>()

function logRead(key: string, f: (log: ReadLog) => void): void {
  const logs = reading.get(key)
  if (logs) for (const log of logs) f(log)
}

/** Igualdade de evento por conteúdo: o do WebSocket e o da releitura são o mesmo objeto do servidor, serializado duas vezes. */
const sameEvent = (a: ClaudeEvent, b: ClaudeEvent): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * A releitura com os eventos que chegaram durante ela por cima. O servidor pode
 * ter lido depois de alguns deles (já estão no fim do snapshot): o maior trecho
 * do começo dos chegados que coincide com o fim do snapshot não se repete.
 */
function mergeRead(snapshot: ClaudeEvent[], arrived: ClaudeEvent[]): ClaudeEvent[] {
  for (let k = Math.min(snapshot.length, arrived.length); k > 0; k--) {
    const base = snapshot.length - k
    let match = true
    for (let i = 0; i < k && match; i++) match = sameEvent(snapshot[base + i], arrived[i])
    if (match) return [...snapshot, ...arrived.slice(k)]
  }
  return [...snapshot, ...arrived]
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
    if (msg.side && typeof msg.side === 'object' && typeof msg.side.id === 'string') {
      logRead(progressKey(msg.projectId, msg.engine), (log) => log.states.add(msg.side.id))
      setSideInfo(msg.side as SideInfo)
    }
    else if (msg.side === null) removeSide(progressKey(msg.projectId, msg.engine))
    return true
  }
  if (msg.type === 'side_event') {
    if (!isTarget(msg) || !msg.event || typeof msg.event !== 'object') return true
    const key = progressKey(msg.projectId, msg.engine)
    // Anotado mesmo sem a lateral no store: ela pode ter aberto durante a queda,
    // e a releitura em curso é que a traz.
    if (typeof msg.sideId === 'string' && msg.event.kind !== 'stream') {
      logRead(key, (log) => log.events.push({ sideId: msg.sideId, event: msg.event as ClaudeEvent }))
    }
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
 * perdeu. Enquanto a leitura está a caminho, o WebSocket continua chegando:
 * - a lateral sumiu, ou virou outra (outro id), e a resposta é da antiga: a
 *   resposta é descartada, o WebSocket é mais novo;
 * - a mesma lateral: a resposta entra, com os eventos que chegaram durante a
 *   leitura por cima (os `side_event` são incrementais; descartá-la perderia o
 *   que a queda levou). O estado (`side_state`) que chegou durante a leitura
 *   vence o da resposta.
 * Sem motor (nenhuma sessão aberta) não lê. Só a leitura, sem assinar a
 * lateral: quem só precisa saber se ela existe (o ChatView) não redesenha a
 * cada evento dela.
 */
export function useSideRead(projectId: number, engine: string): void {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  const key = progressKey(projectId, engine)
  useEffect(() => {
    if (!ready || !engine) return
    let alive = true
    const antes = useSideStore.getState().sides[key]?.info.id
    const log: ReadLog = { events: [], states: new Set() }
    const logs = reading.get(key) ?? new Set<ReadLog>()
    logs.add(log)
    reading.set(key, logs)
    const done = () => {
      logs.delete(log)
      if (logs.size === 0 && reading.get(key) === logs) reading.delete(key)
    }
    getSide(projectId, engine)
      .then((snap) => {
        if (!alive) return
        const cur = useSideStore.getState().sides[key]
        const mudou = cur?.info.id !== antes
        const side = snap?.side ?? null
        if (!side) { if (!mudou) removeSide(key); return }
        // A lateral sumiu ou virou outra enquanto a leitura vinha: o WebSocket é mais novo.
        if (mudou && cur?.info.id !== side.id) return
        const arrived = log.events.filter((e) => e.sideId === side.id).map((e) => e.event)
        const items = mergeRead(snap.events ?? [], arrived).reduce(applySideEvent, [] as ChatItem[])
        const info = cur && cur.info.id === side.id && log.states.has(side.id) ? cur.info : side
        useSideStore.setState((s) => ({ sides: { ...s.sides, [key]: { info, items } } }))
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
      .finally(done)
    return () => { alive = false; done() }
  }, [ready, epoch, projectId, engine, key])
}

/** `useSideRead` e a lateral do terminal, assinada (redesenha a cada evento dela). */
export function useSideSync(projectId: number, engine: string): SideView | undefined {
  useSideRead(projectId, engine)
  return useSideStore((s) => s.sides[progressKey(projectId, engine)])
}

/** Pede ao campo da principal (`localId`) que acrescente o texto; cada pedido ganha um `seq` novo. */
export function requestAppend(localId: string, text: string, attachments: Array<[string, string]> = []): void {
  useSideStore.setState((s) => ({ appendRequest: { localId, text, attachments, seq: (s.appendRequest?.seq ?? 0) + 1 } }))
}
