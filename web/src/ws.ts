/** Mensagens enfileiradas durante a queda expiram após este prazo: entregar um
 *  `interrupt`/`send_message` clicado minutos atrás faria a ação errada na hora errada. */
const QUEUE_TTL_MS = 15_000
// Dez atualizações por segundo mantêm o texto fluido sem pintar a tela por token.
const STREAM_BATCH_MS = 100

export function connectWs(
  onMessage: (msg: any) => void,
  /** Chamado quando uma RE-conexão abre (não a primeira): eventos podem ter se
   *  perdido na queda — o app deve ressincronizar (invalidar históricos etc.). */
  onReconnect?: () => void,
): { send(msg: object): void; close(): void } {
  let ws: WebSocket
  let queue: { msg: object; ts: number }[] = []
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let everOpened = false
  const streams = new Map<string, any>()
  let streamTimer: ReturnType<typeof setTimeout> | undefined
  const deliver = (msg: any) => {
    try { onMessage(msg) } catch (err) { console.error('[ws] falha ao processar mensagem', err) }
  }
  const flushStreams = () => {
    clearTimeout(streamTimer); streamTimer = undefined
    for (const msg of streams.values()) deliver(msg)
    streams.clear()
  }

  const open = () => {
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
    ws = new WebSocket(`${scheme}${location.host}/ws`)
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg?.type === 'session_event' && msg.event?.kind === 'stream' && typeof msg.event.text === 'string') {
          const previous = streams.get(msg.localId)
          streams.set(msg.localId, previous ? { ...msg, event: { ...msg.event, text: previous.event.text + msg.event.text } } : msg)
          streamTimer ??= setTimeout(flushStreams, typeof document !== 'undefined' && document.hidden ? 250 : STREAM_BATCH_MS)
          if (streams.get(msg.localId).event.text.length >= 32_768) flushStreams()
        } else {
          // Publica os deltas ANTES da resposta final/status que limpa o preview.
          flushStreams()
          deliver(msg)
        }
      } catch (err) {
        console.error('[ws] falha ao processar mensagem', err)
      }
    }
    ws.onopen = () => {
      if (everOpened) onReconnect?.()
      everOpened = true
      const now = Date.now()
      for (const q of queue) {
        if (now - q.ts <= QUEUE_TTL_MS) ws.send(JSON.stringify(q.msg))
        else deliver({ type: 'error', localId: (q.msg as any).localId, message: 'A conexão caiu e o envio expirou. Reenvie a mensagem ou ação.' })
      }
      queue = []
    }
    ws.onclose = () => {
      flushStreams()
      if (!closed) reconnectTimer = setTimeout(open, 2000)
    }
  }
  open()

  return {
    send(msg: object) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      else queue.push({ msg, ts: Date.now() })
    },
    close() {
      closed = true
      clearTimeout(streamTimer); streams.clear()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.close()
    },
  }
}
