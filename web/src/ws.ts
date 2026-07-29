/** Mensagens enfileiradas durante a queda expiram após este prazo: entregar um
 *  `interrupt`/`send_message` clicado minutos atrás faria a ação errada na hora errada. */
const QUEUE_TTL_MS = 15_000

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

  const open = () => {
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
    ws = new WebSocket(`${scheme}${location.host}/ws`)
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
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
      }
      queue = []
    }
    ws.onclose = () => {
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
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.close()
    },
  }
}
