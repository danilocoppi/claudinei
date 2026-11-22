import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { encodeFrame, decodeFrame } from '../src/browser/frame.js'
import { createScreencast, type CdpLike } from '../src/browser/screencast.js'
import { createViewers, viewersFor, type Viewers, type ViewerSink } from '../src/browser/viewers.js'
import { createTerminalTab, type TerminalTab } from '../src/browser/terminal-tab.js'
import { FRAME_HEADER_BYTES, type BrowserStateMsg, type FrameHeader } from '../../shared/browser.js'
import { FakeCDPSession, FakeContext, type FakePage } from './browser-fakes.js'

const KEY = { projectId: 1, engine: 'claude' }
const settle = () => vi.advanceTimersByTimeAsync(0)

type Sent = { kind: 'state'; msg: BrowserStateMsg } | { kind: 'frame'; header: FrameHeader; image: Buffer }

/** O socket de um espectador: guarda o que saiu, já decodificado. */
function fakeSink(): ViewerSink & { sent: Sent[]; frames(): Array<{ header: FrameHeader; image: Buffer }>; states(): BrowserStateMsg[] } {
  const sent: Sent[] = []
  return {
    bufferedAmount: 0,
    sent,
    sendBinary(b: Buffer) { sent.push({ kind: 'frame', ...decodeFrame(b) }) },
    sendText(s: string) { sent.push({ kind: 'state', msg: JSON.parse(s) as BrowserStateMsg }) },
    frames() { return sent.flatMap((s) => (s.kind === 'frame' ? [{ header: s.header, image: s.image }] : [])) },
    states() { return sent.flatMap((s) => (s.kind === 'state' ? [s.msg] : [])) },
  }
}

/** Um screencast de mentira: só lembra se deveria estar rodando. */
function fakeScreencast() {
  let on = false
  const sc = {
    starts: 0, stops: 0, restarts: 0,
    start: vi.fn(async () => { if (!on) sc.starts++; on = true }),
    stop: vi.fn(async () => { if (on) sc.stops++; on = false }),
    restart: vi.fn(async () => { sc.restarts++ }),
    running: () => on,
  }
  return sc
}

async function makeTab(): Promise<{ context: FakeContext; page: FakePage; tab: TerminalTab }> {
  const context = new FakeContext({})
  const page = await context.newPage()
  const tab = createTerminalTab({
    key: KEY,
    context: context as unknown as BrowserContext,
    page: page as unknown as Page,
    now: () => Date.now(),
    viewport: { width: 1280, height: 800 },
  })
  return { context, page, tab }
}

const viewer = (o: { userId?: number | null; name?: string; sink?: ViewerSink; visible?: boolean; size?: { width: number; height: number } | null } = {}) => ({
  userId: o.userId ?? 1,
  name: o.name ?? 'ana',
  sink: o.sink ?? fakeSink(),
  visible: o.visible ?? true,
  frozen: false,
  size: o.size ?? null,
})

const jpeg = (s: string) => Buffer.from(s)
const V1280 = { width: 1280, height: 800 }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('frame', () => {
  it('encodeFrame/decodeFrame: 4 bytes BE + JSON + imagem', () => {
    const h: FrameHeader = { kind: 'frame', seq: 7, width: 900, height: 700 }
    const img = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])
    const buf = encodeFrame(h, img)
    const json = Buffer.from(JSON.stringify(h))
    expect(FRAME_HEADER_BYTES).toBe(4)
    expect(buf.readUInt32BE(0)).toBe(json.length)
    expect(buf.subarray(4, 4 + json.length).toString()).toBe(JSON.stringify(h))
    expect(buf.subarray(4 + json.length).equals(img)).toBe(true)
    const back = decodeFrame(buf)
    expect(back.header).toEqual(h)
    expect(back.image.equals(img)).toBe(true)
  })
})

describe('espectadores', () => {
  let tab: TerminalTab
  let sc: ReturnType<typeof fakeScreencast>
  let vs: Viewers

  beforeEach(async () => {
    tab = (await makeTab()).tab
    sc = fakeScreencast()
    vs = createViewers({ tab, screencast: sc })
  })

  it('sem espectador visível o screencast não começa; o primeiro visível começa; visible:false do último para', async () => {
    const a = vs.add(viewer({ visible: false }))
    await settle()
    expect(sc.starts).toBe(0)
    expect(vs.anyVisible()).toBe(false)
    expect(tab.isVisible()).toBe(false)
    vs.update(a.id, { visible: true })
    expect(sc.starts).toBe(1)
    expect(vs.anyVisible()).toBe(true)
    expect(tab.isVisible()).toBe(true)
    const b = vs.add(viewer({ userId: 2 }))
    vs.update(a.id, { visible: false })
    expect(sc.stops).toBe(0)
    vs.update(b.id, { visible: false })
    expect(sc.stops).toBe(1)
    expect(tab.isVisible()).toBe(false)
    // Quadro que chega depois (em trânsito) não vai a ninguém.
    vs.broadcastFrame(jpeg('x'), V1280)
    expect((a.sink as ReturnType<typeof fakeSink>).frames()).toEqual([])
    vs.update(b.id, { visible: true })
    vs.remove(b.id)
    expect(sc.stops).toBe(2)
  })

  it('bufferedAmount 600 KB: três quadros viram um só envio (o último) quando cai para 0', async () => {
    const sink = fakeSink()
    sink.bufferedAmount = 600 * 1024
    vs.add(viewer({ sink }))
    vs.broadcastFrame(jpeg('1'), V1280)
    vs.broadcastFrame(jpeg('2'), V1280)
    vs.broadcastFrame(jpeg('3'), V1280)
    await vi.advanceTimersByTimeAsync(200)
    expect(sink.frames()).toEqual([])
    sink.bufferedAmount = 0
    await vi.advanceTimersByTimeAsync(50)
    expect(sink.frames().map((f) => f.image.toString())).toEqual(['3'])
    await vi.advanceTimersByTimeAsync(500)
    expect(sink.frames()).toHaveLength(1)
    // O seq cresce por aba, contando os quadros guardados que não saíram.
    expect(sink.frames()[0].header).toEqual({ kind: 'frame', seq: 3, width: 1280, height: 800 })
  })

  it('espectador congelado não recebe quadros; se for o único, o screencast para', async () => {
    const sink = fakeSink()
    const a = vs.add(viewer({ sink }))
    expect(sc.starts).toBe(1)
    vs.update(a.id, { frozen: true })
    expect(sc.stops).toBe(1)
    expect(vs.anyVisible()).toBe(false)
    // A coluna congelada continua aberta: a aba conta como visível (ociosidade e despejo).
    expect(tab.isVisible()).toBe(true)
    vs.broadcastFrame(jpeg('x'), V1280)
    expect(sink.frames()).toEqual([])
    vs.update(a.id, { frozen: false })
    expect(sc.starts).toBe(2)
    vs.broadcastFrame(jpeg('y'), V1280)
    expect(sink.frames().map((f) => f.image.toString())).toEqual(['y'])
  })

  it('o mesmo quadro vai a dois espectadores', () => {
    const s1 = fakeSink()
    const s2 = fakeSink()
    vs.add(viewer({ sink: s1 }))
    vs.add(viewer({ sink: s2, userId: 2 }))
    vs.broadcastFrame(jpeg('q'), V1280)
    expect(s1.frames()).toEqual(s2.frames())
    expect(s1.frames()).toHaveLength(1)
    expect(s1.frames()[0].header.seq).toBe(1)
  })

  it('viewport segue o dono do bastão; sem bastão, a última coluna que abriu; sem nenhuma, 1280×800', async () => {
    expect(vs.desiredViewport()).toEqual(V1280)
    const a = vs.add(viewer({ userId: 1, size: { width: 800, height: 600 } }))
    await vi.advanceTimersByTimeAsync(1)
    const b = vs.add(viewer({ userId: 2, size: { width: 1000, height: 700 } }))
    expect(vs.desiredViewport()).toEqual({ width: 1000, height: 700 })
    tab.baton.operatorAct({ userId: 1, name: 'ana' })
    expect(vs.desiredViewport()).toEqual({ width: 800, height: 600 })
    await settle()
    expect(tab.state().viewport).toEqual({ width: 800, height: 600 })
    tab.baton.release()
    expect(vs.desiredViewport()).toEqual({ width: 1000, height: 700 })
    // Fora da faixa: grampeado.
    vs.update(b.id, { size: { width: 5000, height: 100 } })
    expect(vs.desiredViewport()).toEqual({ width: 1920, height: 240 })
    vs.remove(b.id)
    expect(vs.desiredViewport()).toEqual({ width: 800, height: 600 })
    vs.remove(a.id)
    expect(vs.desiredViewport()).toEqual(V1280)
    await settle()
    expect(tab.state().viewport).toEqual(V1280)
  })

  it('espectador que ainda não mandou o tamanho não volta o viewport a 1280×800', async () => {
    // A aba nasceu com o viewport da última coluna (o host decide).
    await tab.setViewport({ width: 800, height: 600 })
    const a = vs.add(viewer({ size: null }))
    await settle()
    // A coluna sem tamanho ainda não leva o viewport a 1280×800 e de volta.
    expect(tab.state().viewport).toEqual({ width: 800, height: 600 })
    vs.update(a.id, { size: { width: 900, height: 700 } })
    await settle()
    expect(tab.state().viewport).toEqual({ width: 900, height: 700 })
  })

  it('resize que a página não responde não prende as trocas seguintes além de 5 s', async () => {
    const real = tab.setViewport.bind(tab)
    const spy = vi.spyOn(tab, 'setViewport').mockImplementationOnce(() => new Promise(() => {}))
    const a = vs.add(viewer({ size: { width: 800, height: 600 } }))
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockImplementation(real)
    vs.update(a.id, { size: { width: 900, height: 700 } })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(tab.state().viewport).toEqual({ width: 900, height: 700 })
  })

  it('dono sem espectador visível: presence(false); 30 s depois o bastão volta', async () => {
    const a = vs.add(viewer({ userId: 1 }))
    vs.add(viewer({ userId: 2 }))
    tab.baton.operatorAct({ userId: 1, name: 'ana' })
    const presence = vi.spyOn(tab.baton, 'presence')
    vs.update(a.id, { visible: false })
    expect(presence).toHaveBeenCalledWith(1, false)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(tab.baton.state().kind).toBe('operator')
    await vi.advanceTimersByTimeAsync(1)
    expect(tab.baton.state()).toEqual({ kind: 'free' })
  })

  it('o dono que volta a olhar antes dos 30 s fica com o bastão', async () => {
    const a = vs.add(viewer({ userId: 1 }))
    tab.baton.operatorAct({ userId: 1, name: 'ana' })
    vs.remove(a.id)
    await vi.advanceTimersByTimeAsync(20_000)
    vs.add(viewer({ userId: 1 }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(tab.baton.state().kind).toBe('operator')
  })

  it('state.baton.you só para o espectador do dono', async () => {
    const s1 = fakeSink()
    const s2 = fakeSink()
    vs.add(viewer({ userId: 1, name: 'ana', sink: s1 }))
    vs.add(viewer({ userId: 2, name: 'bia', sink: s2 }))
    tab.baton.operatorAct({ userId: 1, name: 'ana' })
    await vi.advanceTimersByTimeAsync(100)
    expect(s1.states().at(-1)?.baton).toEqual({ kind: 'operator', name: 'ana', you: true })
    expect(s2.states().at(-1)?.baton).toEqual({ kind: 'operator', name: 'ana', you: false })
    const st = s2.states().at(-1)!
    expect(st).toMatchObject({ type: 'state', url: 'about:blank', loading: false, crashed: false, viewport: V1280, dialog: null, sandbox: true })
  })

  it('state sai a cada mudança de espectador e é agrupado: dez avisos seguidos viram um envio', async () => {
    const s1 = fakeSink()
    vs.add(viewer({ sink: s1 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(s1.states()).toHaveLength(1)
    for (let i = 0; i < 10; i++) tab.pushNotice(`alert accepted: "${i}"`, true)
    await vi.advanceTimersByTimeAsync(100)
    expect(s1.states()).toHaveLength(2)
    expect(s1.states()[1].notices.at(-1)).toBe('alert accepted: "9"')
    // Avisos em rajada contínua (um por milissegundo): no máximo 20 envios por segundo.
    for (let i = 0; i < 1000; i++) {
      tab.pushNotice(`alert accepted: "${i}"`, true)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(s1.states().length - 2).toBeLessThanOrEqual(21)
  })

  it('state pendente sai antes do próximo quadro', () => {
    const s1 = fakeSink()
    vs.add(viewer({ sink: s1 }))
    tab.setLastAction("clicked 'Enviar'", { x: 10, y: 20 })
    vs.broadcastFrame(jpeg('f'), V1280)
    expect(s1.sent.map((s) => s.kind)).toEqual(['state', 'frame'])
    expect(s1.states()[0].lastAction).toMatchObject({ text: "clicked 'Enviar'", point: { x: 10, y: 20 } })
  })

  it('sendStill manda o PNG só a quem pediu, com o seq da aba', () => {
    const s1 = fakeSink()
    const s2 = fakeSink()
    const a = vs.add(viewer({ sink: s1 }))
    vs.add(viewer({ sink: s2, userId: 2 }))
    vs.broadcastFrame(jpeg('f'), V1280)
    vs.update(a.id, { frozen: true })
    vs.sendStill(a.id, Buffer.from('png'), V1280)
    expect(s1.frames().map((f) => f.header)).toEqual([
      { kind: 'frame', seq: 1, width: 1280, height: 800 },
      { kind: 'still', seq: 2, width: 1280, height: 800 },
    ])
    expect(s2.frames()).toHaveLength(1)
  })

  it('a aba fecha: o último state leva closed, o screencast para e nada mais sai', async () => {
    const s1 = fakeSink()
    vs.add(viewer({ sink: s1 }))
    await settle()
    await tab.close('idle')
    expect(s1.states().at(-1)?.closed).toBe('idle')
    expect(sc.running()).toBe(false)
    const n = s1.sent.length
    vs.broadcastFrame(jpeg('late'), V1280)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s1.sent).toHaveLength(n)
  })

  it('a coluna que deixa de ser visível conta como uso: lastVisibleAt', async () => {
    const before = tab.lastVisibleAt
    const a = vs.add(viewer())
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    vs.update(a.id, { visible: false })
    expect(tab.lastVisibleAt).toBe(Date.now())
    expect(tab.lastVisibleAt).toBeGreaterThan(before)
  })
})

describe('Review Focus 4: dois espectadores com tamanhos diferentes e o bastão trocando de dono', () => {
  it('troca de viewport chama setViewport e restart, e o state com o viewport novo sai antes do próximo quadro', async () => {
    const { tab } = await makeTab()
    const cdp = new FakeCDPSession({} as FakePage)
    let vs!: Viewers
    const sc = createScreencast({
      cdp: cdp as unknown as CdpLike,
      size: () => tab.state().viewport,
      onFrame: (j, s) => vs.broadcastFrame(j, s),
    })
    vs = createViewers({ tab, screencast: sc })
    const setViewport = vi.spyOn(tab, 'setViewport')
    const restart = vi.spyOn(sc, 'restart')
    const s1 = fakeSink()
    const s2 = fakeSink()
    const frame = (id: number) => cdp.emit('Page.screencastFrame', { data: Buffer.from(`f${id}`).toString('base64'), sessionId: id, metadata: {} })

    vs.add(viewer({ userId: 1, name: 'ana', sink: s1, size: { width: 800, height: 600 } }))
    await vi.advanceTimersByTimeAsync(5)
    vs.add(viewer({ userId: 2, name: 'bia', sink: s2, size: { width: 1000, height: 700 } }))
    await vi.advanceTimersByTimeAsync(5)
    // Sem bastão: a última coluna que abriu (bia).
    expect(tab.state().viewport).toEqual({ width: 1000, height: 700 })
    expect(cdp.calls('Page.startScreencast').at(-1)).toMatchObject({ maxWidth: 1000, maxHeight: 700 })
    frame(1)
    await vi.advanceTimersByTimeAsync(100)

    setViewport.mockClear()
    restart.mockClear()
    const mark = new Map([[s1, s1.sent.length], [s2, s2.sent.length]])
    tab.baton.operatorAct({ userId: 1, name: 'ana' })
    // Quadros do tamanho antigo ainda em trânsito (antes e durante o restart).
    frame(2)
    await Promise.resolve()
    frame(3)
    await vi.advanceTimersByTimeAsync(200)
    expect(setViewport).toHaveBeenCalledWith({ width: 800, height: 600 })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(cdp.calls('Page.startScreencast').at(-1)).toMatchObject({ maxWidth: 800, maxHeight: 600 })
    frame(4)
    frame(5)
    await vi.advanceTimersByTimeAsync(200)

    for (const s of [s1, s2]) {
      const from = mark.get(s)!
      const iState = s.sent.findIndex((m, i) => i >= from && m.kind === 'state' && m.msg.viewport.width === 800)
      expect(iState).toBeGreaterThan(-1)
      const after = s.sent.slice(iState + 1).filter((m) => m.kind === 'frame')
      expect(after.length).toBeGreaterThan(0)
      for (const m of after) if (m.kind === 'frame') expect(m.header).toMatchObject({ width: 800, height: 600 })
      // Nenhum quadro de 800 antes do state com o viewport novo.
      for (const m of s.sent.slice(from, iState)) if (m.kind === 'frame') expect(m.header.width).toBe(1000)
      // Os quadros do tamanho antigo em trânsito (2 e 3) não saíram.
      expect(s.frames().map((f) => f.image.toString())).not.toContain('f3')
    }

    // O bastão passa para bia: volta a 1000×700 do mesmo jeito.
    const mark2 = s1.sent.length
    tab.baton.operatorAct({ userId: 2, name: 'bia' })
    frame(6)
    await vi.advanceTimersByTimeAsync(200)
    frame(7)
    await vi.advanceTimersByTimeAsync(200)
    const last = s1.sent.findIndex((m, i) => i >= mark2 && m.kind === 'state' && m.msg.viewport.width === 1000 && m.msg.baton.kind === 'operator' && m.msg.baton.name === 'bia')
    expect(last).toBeGreaterThan(-1)
    for (const m of s1.sent.slice(last + 1)) if (m.kind === 'frame') expect(m.header.width).toBe(1000)
    expect(s1.frames().at(-1)?.image.toString()).toBe('f7')
  })
})

describe('viewersFor', () => {
  it('um conjunto por aba; a sessão CDP nasce no primeiro espectador visível e se religa na página recriada', async () => {
    const { context, page, tab } = await makeTab()
    const vs = viewersFor(tab)
    expect(viewersFor(tab)).toBe(vs)
    expect(context.cdpSessions).toHaveLength(0)
    const sink = fakeSink()
    vs.add(viewer({ sink, size: { width: 640, height: 480 } }))
    await vi.advanceTimersByTimeAsync(10)
    expect(context.cdpSessions).toHaveLength(1)
    const first = context.cdpSessions[0]
    expect(first.page).toBe(page)
    expect(first.calls('Page.startScreencast').at(-1)).toMatchObject({ maxWidth: 640, maxHeight: 480 })
    first.emit('Page.screencastFrame', { data: Buffer.from('a').toString('base64'), sessionId: 1, metadata: {} })
    expect(sink.frames().map((f) => f.image.toString())).toEqual(['a'])

    // A página trava e a recuperação cria outra: o screencast passa para a nova.
    page.crash()
    await tab.history('reload')
    await vi.advanceTimersByTimeAsync(10)
    expect(context.cdpSessions).toHaveLength(2)
    const second = context.cdpSessions[1]
    expect(second.page).not.toBe(page)
    expect(first.detached).toBe(true)
    expect(second.calls('Page.startScreencast').at(-1)).toMatchObject({ maxWidth: 640, maxHeight: 480 })
    second.emit('Page.screencastFrame', { data: Buffer.from('b').toString('base64'), sessionId: 1, metadata: {} })
    expect(sink.frames().map((f) => f.image.toString())).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(100)
    expect(second.calls('Page.screencastFrameAck')).toHaveLength(1)

    await tab.close('closed_by_user')
    expect(second.detached).toBe(true)
  })
})
