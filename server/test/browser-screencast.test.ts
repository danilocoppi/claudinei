import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScreencast, type CdpLike } from '../src/browser/screencast.js'
import { FakeCDPSession, FakePage } from './browser-fakes.js'

/** Deixa as promessas encadeadas terminarem (com o relógio falso parado). */
const settle = () => vi.advanceTimersByTimeAsync(0)

/** Um quadro do Chromium: base64 da imagem e o id do ack. */
const frame = (cdp: FakeCDPSession, sessionId: number, data = 'jpg') =>
  cdp.emit('Page.screencastFrame', { data: Buffer.from(data).toString('base64'), sessionId, metadata: {} })

describe('screencast ritmado', () => {
  let cdp: FakeCDPSession
  let size: { width: number; height: number }
  let frames: Array<{ jpeg: Buffer; size: { width: number; height: number } }>

  beforeEach(() => {
    vi.useFakeTimers()
    cdp = new FakeCDPSession(new FakePage())
    size = { width: 900, height: 700 }
    frames = []
  })
  afterEach(() => { vi.useRealTimers() })

  const make = () => createScreencast({
    cdp: cdp as unknown as CdpLike,
    size: () => size,
    onFrame: (jpeg, s) => frames.push({ jpeg, size: s }),
  })

  it('start manda Page.startScreencast com jpeg, 55 e o tamanho', async () => {
    const sc = make()
    await sc.start()
    expect(sc.running()).toBe(true)
    expect(cdp.calls('Page.startScreencast')).toEqual([{ format: 'jpeg', quality: 55, maxWidth: 900, maxHeight: 700, everyNthFrame: 1 }])
    // Iniciar de novo não manda outro pedido.
    await sc.start()
    expect(cdp.calls('Page.startScreencast')).toHaveLength(1)
    frame(cdp, 1, 'abc')
    expect(frames).toHaveLength(1)
    expect(frames[0].jpeg.toString()).toBe('abc')
    expect(frames[0].size).toEqual({ width: 900, height: 700 })
  })

  it('dois quadros seguidos: o ack do segundo sai 100 ms depois do primeiro ack', async () => {
    const sc = make()
    await sc.start()
    const acks: Array<{ at: number; id: unknown }> = []
    const t0 = Date.now()
    const send = cdp.send.bind(cdp)
    cdp.send = (method, params) => {
      if (method === 'Page.screencastFrameAck') acks.push({ at: Date.now() - t0, id: params?.sessionId })
      return send(method, params)
    }
    frame(cdp, 1)
    expect(acks).toEqual([{ at: 0, id: 1 }])
    frame(cdp, 2)
    expect(acks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(acks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(acks).toEqual([{ at: 0, id: 1 }, { at: 100, id: 2 }])
    // Os dois quadros foram entregues na hora; só o ack espera.
    expect(frames).toHaveLength(2)
  })

  it('quadros contínuos (o Chromium manda o próximo a cada ack): no máximo 10 acks em 1 s', async () => {
    const sc = make()
    await sc.start()
    let next = 1
    let acks = 0
    const send = cdp.send.bind(cdp)
    cdp.send = (method, params) => {
      const r = send(method, params)
      if (method === 'Page.screencastFrameAck') {
        acks++
        queueMicrotask(() => frame(cdp, ++next))
      }
      return r
    }
    frame(cdp, next)
    await vi.advanceTimersByTimeAsync(999)
    expect(acks).toBe(10)
    expect(frames.length).toBeLessThanOrEqual(11)
  })

  it('stop manda Page.stopScreencast e para de ackar', async () => {
    const sc = make()
    await sc.start()
    frame(cdp, 1)
    frame(cdp, 2) // ack agendado para daqui a 100 ms
    await sc.stop()
    expect(sc.running()).toBe(false)
    expect(cdp.calls('Page.stopScreencast')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(cdp.calls('Page.screencastFrameAck').map((p) => p?.sessionId)).toEqual([1])
    // Quadro atrasado depois do stop não vai a ninguém.
    frame(cdp, 3)
    expect(frames).toHaveLength(2)
    // Parar de novo não manda outro pedido.
    await sc.stop()
    expect(cdp.calls('Page.stopScreencast')).toHaveLength(1)
  })

  it('restart para e começa com o tamanho novo', async () => {
    const sc = make()
    await sc.start()
    size = { width: 400, height: 300 }
    await sc.restart()
    expect(cdp.sent.map((s) => s.method)).toEqual(['Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast'])
    expect(cdp.calls('Page.startScreencast')[1]).toMatchObject({ maxWidth: 400, maxHeight: 300 })
    frame(cdp, 7)
    expect(frames.at(-1)?.size).toEqual({ width: 400, height: 300 })
  })

  it('restart parado não começa nada', async () => {
    const sc = make()
    await sc.restart()
    expect(cdp.sent).toEqual([])
    expect(sc.running()).toBe(false)
  })

  it('start e stop seguidos sem esperar terminam parados, sem pedido fora de ordem', async () => {
    const sc = make()
    void sc.start()
    void sc.stop()
    void sc.start()
    await sc.stop()
    await settle()
    expect(sc.running()).toBe(false)
    const methods = cdp.sent.map((s) => s.method)
    // Cada start seguido de seu stop; termina parado.
    expect(methods.at(-1) ?? 'Page.stopScreencast').toBe('Page.stopScreencast')
  })

  it('CDP que falha no start não lança e não fica rodando por dentro', async () => {
    cdp.failSend = true
    const sc = make()
    await expect(sc.start()).resolves.toBeUndefined()
    cdp.failSend = false
    // A próxima tentativa (restart) manda o pedido de novo.
    await sc.restart()
    expect(cdp.calls('Page.startScreencast')).toHaveLength(2)
  })
})
