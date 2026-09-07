import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectWs } from '../ws'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  onopen?: () => void
  onclose?: (event?: { code: number; reason: string }) => void
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
  const stream = (text: string, localId = 'a') => ({ type: 'session_event', localId, event: { kind: 'stream', text, raw: {} } })
  const receive = (msg: object) => FakeWS.instances[0].onmessage?.({ data: JSON.stringify(msg) })

  it('descarta mensagens e deltas pendentes ao bloquear por horário, sem reconectar ou reenviar', () => {
    const denied = vi.fn(), received = vi.fn()
    window.addEventListener('claudinei:access-restricted', denied)
    const conn = connectWs(received)
    conn.send({ type: 'send_message', text: 'pending' })
    receive(stream('private'))
    FakeWS.instances[0].onclose?.({ code: 1008, reason: 'access_hours' })
    conn.send({ type: 'send_message', text: 'outside' })
    vi.advanceTimersByTime(30_000)
    expect(denied).toHaveBeenCalledOnce()
    expect(received).not.toHaveBeenCalled()
    expect(FakeWS.instances).toHaveLength(1)
    expect(FakeWS.instances[0].send).not.toHaveBeenCalled()
    window.removeEventListener('claudinei:access-restricted', denied)
  })

  it('revalida acesso quando o administrador altera as permissões', () => {
    const check = vi.fn()
    window.addEventListener('claudinei:check-access', check)
    const conn = connectWs(() => {})
    FakeWS.instances[0].onclose?.({ code: 1008, reason: 'revoked' })
    expect(check).toHaveBeenCalledOnce()
    conn.close()
    window.removeEventListener('claudinei:check-access', check)
  })

  it('agrupa deltas por sessão sem perder texto nem misturar conversas', () => {
    const received = vi.fn(); connectWs(received)
    receive(stream('a')); receive(stream('b', 'other')); receive(stream('c'))
    expect(received).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(received.mock.calls.map(([msg]) => msg)).toEqual([stream('ac'), stream('b', 'other')])
  })

  it('resposta final recebe os deltas antes dela, sem preview reaparecer depois', () => {
    const received = vi.fn(); connectWs(received)
    const final = { type: 'session_event', localId: 'a', event: { kind: 'result' } }
    receive(stream('texto')); receive(final)
    vi.advanceTimersByTime(500)
    expect(received.mock.calls.map(([msg]) => msg)).toEqual([stream('texto'), final])
  })

  it('fechar cancela o lote de renderização pendente', () => {
    const received = vi.fn(); const connection = connectWs(received)
    receive(stream('texto')); connection.close(); vi.advanceTimersByTime(500)
    expect(received).not.toHaveBeenCalled()
  })

  it('envio expirado durante a desconexão gera erro visível para a sessão', () => {
    const received = vi.fn(); const connection = connectWs(received)
    connection.send({ type: 'send_message', localId: 'a', text: 'pedido' })
    vi.advanceTimersByTime(16000)
    FakeWS.instances[0].onopen?.()
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', localId: 'a' }))
    expect(FakeWS.instances[0].send).not.toHaveBeenCalled()
  })

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
