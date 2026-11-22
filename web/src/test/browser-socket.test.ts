import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectBrowser } from '../browser/browserSocket'
import type { BrowserStateMsg } from '../../../shared/browser'

/**
 * O socket da tela: a URL, o `visible`/`resize` reenviados a cada conexão, os
 * quadros binários, e a reconexão em 1 s, 2 s, 5 s e 10 s, sem reconectar em
 * 1008 nem em 1000 depois de um `state` com `closed`.
 */

class FakeWs {
  static all: FakeWs[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWs.all.push(this) }
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3 }
  abrir() { this.readyState = 1; this.onopen?.() }
  fechar(code: number) { this.readyState = 3; this.onclose?.({ code }) }
}

const state = (o: Partial<BrowserStateMsg> = {}): BrowserStateMsg => ({
  type: 'state', url: 'about:blank', title: '', loading: false, crashed: false, baton: { kind: 'free' },
  viewport: { width: 1280, height: 800 }, dialog: null, notices: [], lastAction: null, sandbox: true, ...o,
})
const handlers = () => ({ onState: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() })
const ultimo = () => FakeWs.all[FakeWs.all.length - 1]

beforeEach(() => {
  FakeWs.all = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWs)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('connectBrowser', () => {
  it('URL, visible e resize guardados e mandados ao abrir; estado e quadro', async () => {
    const h = handlers()
    const c = connectBrowser(7, 'codex', h)
    expect(ultimo().url).toBe(`ws://${location.host}/ws/browser/7/codex`)
    expect(ultimo().binaryType).toBe('arraybuffer')
    c.send({ type: 'visible', visible: true })
    c.send({ type: 'resize', width: 600, height: 400 })
    c.send({ type: 'navigate', url: 'x' }) // sem conexão: descartado
    ultimo().abrir()
    expect(ultimo().sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'visible', visible: true }, { type: 'resize', width: 600, height: 400 },
    ])
    ultimo().onmessage?.({ data: JSON.stringify(state({ title: 'oi' })) })
    expect(h.onState).toHaveBeenCalledWith(expect.objectContaining({ title: 'oi' }))
    const json = new TextEncoder().encode(JSON.stringify({ kind: 'frame', seq: 1, width: 2, height: 2 }))
    const buf = new Uint8Array(4 + json.length + 1)
    new DataView(buf.buffer).setUint32(0, json.length)
    buf.set(json, 4)
    ultimo().onmessage?.({ data: buf.buffer })
    expect(h.onFrame).toHaveBeenCalledTimes(1)
    expect(h.onFrame.mock.calls[0][0].header.seq).toBe(1)
    c.close()
  })

  it('reconecta em 1 s, 2 s, 5 s e 10 s; reenviando o visible', () => {
    const h = handlers()
    const c = connectBrowser(1, 'claude', h)
    c.send({ type: 'visible', visible: true })
    const esperas = [1000, 2000, 5000, 10000, 10000]
    for (const ms of esperas) {
      const n = FakeWs.all.length
      ultimo().fechar(1006)
      expect(h.onClose).toHaveBeenLastCalledWith(1006, true)
      vi.advanceTimersByTime(ms - 1)
      expect(FakeWs.all.length).toBe(n)
      vi.advanceTimersByTime(1)
      expect(FakeWs.all.length).toBe(n + 1)
    }
    // Conexão aberta zera a espera.
    ultimo().abrir()
    expect(ultimo().sent.map((s) => JSON.parse(s))).toEqual([{ type: 'visible', visible: true }])
    const n = FakeWs.all.length
    ultimo().fechar(1006)
    vi.advanceTimersByTime(1000)
    expect(FakeWs.all.length).toBe(n + 1)
    c.close()
  })

  it('não reconecta em 1008 nem em 1000 com state.closed; 1000 sem closed reconecta', () => {
    const h = handlers()
    connectBrowser(1, 'claude', h)
    ultimo().abrir()
    ultimo().fechar(1008)
    expect(h.onClose).toHaveBeenLastCalledWith(1008, false)
    vi.advanceTimersByTime(60000)
    expect(FakeWs.all).toHaveLength(1)

    const h2 = handlers()
    connectBrowser(1, 'claude', h2)
    ultimo().abrir()
    ultimo().onmessage?.({ data: JSON.stringify(state({ closed: 'idle' })) })
    ultimo().fechar(1000)
    expect(h2.onClose).toHaveBeenLastCalledWith(1000, false)
    vi.advanceTimersByTime(60000)
    expect(FakeWs.all).toHaveLength(2)

    const h3 = handlers()
    connectBrowser(1, 'claude', h3)
    ultimo().abrir()
    ultimo().fechar(1000)
    expect(h3.onClose).toHaveBeenLastCalledWith(1000, true)
    vi.advanceTimersByTime(1000)
    expect(FakeWs.all).toHaveLength(4)
  })

  it('close() para de vez: sem reconexão e sem avisos', () => {
    const h = handlers()
    const c = connectBrowser(1, 'claude', h)
    const ws = ultimo()
    ws.abrir()
    c.close()
    ws.fechar(1006)
    vi.advanceTimersByTime(60000)
    expect(FakeWs.all).toHaveLength(1)
    expect(h.onClose).not.toHaveBeenCalled()
  })
})
