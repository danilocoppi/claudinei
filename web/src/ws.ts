export function connectWs(onMessage: (msg: any) => void): { send(msg: object): void; close(): void } {
  let ws: WebSocket
  let queue: object[] = []
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch (err) {
        console.error('[ws] falha ao processar mensagem', err)
      }
    }
    ws.onopen = () => {
      for (const m of queue) ws.send(JSON.stringify(m))
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
      else queue.push(msg)
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.close()
    },
  }
}
