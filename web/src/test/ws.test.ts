import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectWs } from '../ws'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onmessage?: (e: { data: string }) => void
  closed = false
  constructor(public url: string) { FakeWS.instances.push(this) }
  send = vi.fn()
  close = vi.fn(() => { this.closed = true; this.onclose?.() })
}

beforeEach(() => {
  FakeWS.instances = []
  vi.stubGlobal('WebSocket', FakeWS as any)
  vi.stubGlobal('location', { host: 'x' } as any)
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('connectWs', () => {
  it('close() fecha o socket e impede reconexão', () => {
    const conn = connectWs(() => {})
    expect(FakeWS.instances).toHaveLength(1)
    conn.close()
    expect(FakeWS.instances[0].closed).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1) // nenhuma reconexão após close
  })

  it('reconecta quando o socket cai sem close()', () => {
    connectWs(() => {})
    FakeWS.instances[0].onclose?.()
    vi.advanceTimersByTime(2000)
    expect(FakeWS.instances).toHaveLength(2) // reconectou
  })

  // Garante a propriedade em que o App confia: enviar antes do socket abrir
  // enfileira e entrega no open — assim o WS criado no efeito (não no
  // inicializador do useState) sempre envia pelo socket vivo. Regressão do bug
  // em que o chat recebia mas não enviava (socket de envio fechado no StrictMode).
  it('enfileira envios feitos antes do open e entrega quando o socket abre', () => {
    const conn = connectWs(() => {})
    conn.send({ type: 'send_message', text: 'oi' })
    const sock = FakeWS.instances[0]
    expect(sock.send).not.toHaveBeenCalled() // readyState ainda CONNECTING → fila
    sock.readyState = FakeWS.OPEN
    sock.onopen?.()
    expect(sock.send).toHaveBeenCalledWith(JSON.stringify({ type: 'send_message', text: 'oi' }))
  })
})
