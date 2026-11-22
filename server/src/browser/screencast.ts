// O screencast da aba (CDP `Page.startScreencast`): JPEG qualidade 55, do tamanho
// do viewport. Cada quadro vai ao `onFrame` na hora; o ack ao Chromium, que libera
// o próximo quadro, sai no mínimo `minAckMs` (100 ms) depois do anterior: no
// máximo 10 quadros por segundo, e nenhum com a página parada.
//
// start/stop/restart podem chegar em rajada (espectadores entrando e saindo): os
// pedidos ao CDP vão um de cada vez, e cada um confere o estado desejado na hora
// de rodar (`running()` diz o desejado).

export interface CdpLike {
  send(method: string, params?: object): Promise<any>
  on(ev: string, fn: (p: any) => void): void
  off(ev: string, fn: (p: any) => void): void
}

export interface Screencast {
  start(): Promise<void>
  stop(): Promise<void>
  /** Para e começa de novo, com o tamanho atual (ou na sessão CDP nova). Parado: nada. */
  restart(): Promise<void>
  running(): boolean
}

const QUALITY = 55
const MIN_ACK_MS = 100
const FRAME_EVENT = 'Page.screencastFrame'

export function createScreencast(o: {
  cdp: CdpLike
  size: () => { width: number; height: number }
  onFrame: (jpeg: Buffer, size: { width: number; height: number }) => void
  minAckMs?: number /* 100 */
  now?: () => number
}): Screencast {
  const minAckMs = o.minAckMs ?? MIN_ACK_MS
  const now = o.now ?? Date.now
  /** O desejado (o que `running()` responde). */
  let want = false
  /** O screencast pedido ao Chromium e ainda não parado. */
  let active = false
  /** Muda a cada start/stop: quadro e ack de uma rodada velha não valem. */
  let gen = 0
  /** O tamanho com que a rodada atual começou (vai com cada quadro). */
  let started = { width: 0, height: 0 }
  let handler: ((p: any) => void) | null = null
  let lastAck = -Infinity
  const ackTimers = new Set<ReturnType<typeof setTimeout>>()
  let chain: Promise<void> = Promise.resolve()

  function onCdpFrame(g: number, p: any): void {
    if (g !== gen || !active) return
    const sessionId = p?.sessionId
    if (typeof p?.data === 'string') {
      try { o.onFrame(Buffer.from(p.data, 'base64'), { ...started }) } catch { /* o ack sai mesmo assim */ }
    }
    // O ack do próximo quadro respeita o intervalo desde o anterior (já agendado ou enviado).
    const t = now()
    const at = Math.max(t, lastAck + minAckMs)
    lastAck = at
    const send = () => {
      if (g !== gen || !active) return
      void o.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => { /* página fechada ou trocada */ })
    }
    if (at <= t) { send(); return }
    const timer = setTimeout(() => { ackTimers.delete(timer); send() }, at - t)
    ackTimers.add(timer)
  }

  async function doStart(): Promise<void> {
    if (active || !want) return
    const g = ++gen
    started = { ...o.size() }
    handler = (p) => onCdpFrame(g, p)
    o.cdp.on(FRAME_EVENT, handler)
    active = true
    try {
      await o.cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: QUALITY, maxWidth: started.width, maxHeight: started.height, everyNthFrame: 1,
      })
    } catch {
      // Sessão fechada ou página travada: fica parado por dentro; o próximo
      // start/restart (página recriada, viewport novo) tenta de novo.
      if (g === gen) unbind()
    }
  }

  /** Desliga a rodada atual sem falar com o Chromium. */
  function unbind(): void {
    active = false
    gen++
    if (handler) { o.cdp.off(FRAME_EVENT, handler); handler = null }
    for (const t of ackTimers) clearTimeout(t)
    ackTimers.clear()
  }

  async function doStop(): Promise<void> {
    if (!active) return
    unbind()
    await o.cdp.send('Page.stopScreencast').catch(() => { /* sessão já fechada */ })
  }

  /** Enfileira um pedido; a fila não para numa falha. */
  function enqueue(op: () => Promise<void>): Promise<void> {
    chain = chain.then(op).catch(() => {})
    return chain
  }

  return {
    start() {
      want = true
      return enqueue(doStart)
    },
    stop() {
      want = false
      return enqueue(doStop)
    },
    restart() {
      return enqueue(async () => {
        if (!want) return
        await doStop()
        await doStart()
      })
    },
    running: () => want,
  }
}
