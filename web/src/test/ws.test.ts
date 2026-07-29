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

  it('M13: usa wss:// quando a página é https (e ws:// quando http)', () => {
    vi.stubGlobal('location', { host: 'x', protocol: 'https:' } as any)
    connectWs(() => {})
    expect(FakeWS.instances[0].url).toBe('wss://x/ws')
    vi.stubGlobal('location', { host: 'x', protocol: 'http:' } as any)
    connectWs(() => {})
    expect(FakeWS.instances[1].url).toBe('ws://x/ws')
  })

  it('I8: chama onReconnect só na RE-conexão, nunca no primeiro open', () => {
    const onReconnect = vi.fn()
    connectWs(() => {}, onReconnect)
    const first = FakeWS.instances[0]
    first.readyState = FakeWS.OPEN
    first.onopen?.()
    expect(onReconnect).not.toHaveBeenCalled() // primeira conexão: nada a ressincronizar
    first.onclose?.() // queda
    vi.advanceTimersByTime(2000)
    const second = FakeWS.instances[1]
    second.readyState = FakeWS.OPEN
    second.onopen?.()
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('M14: no flush do open, mensagens enfileiradas há mais de 15s são descartadas', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    const conn = connectWs(() => {})
    conn.send({ type: 'interrupt', localId: 'x' }) // clicado durante a queda…
    now.mockReturnValue(1_000 + 16_000) // …16s atrás no momento do flush
    conn.send({ type: 'send_message', text: 'fresca' })
    const sock = FakeWS.instances[0]
    sock.readyState = FakeWS.OPEN
    sock.onopen?.()
    expect(sock.send).toHaveBeenCalledTimes(1) // o interrupt velho NÃO é entregue
    expect(sock.send).toHaveBeenCalledWith(JSON.stringify({ type: 'send_message', text: 'fresca' }))
    now.mockRestore()
  })
})
