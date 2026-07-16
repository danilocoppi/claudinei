import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createActivityTracker, stripAnsi } from '../src/terminal/activity.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const track = () => {
  const changes: string[] = []
  const tracker = createActivityTracker((a) => changes.push(a))
  return { changes, tracker }
}

describe('stripAnsi', () => {
  it('remove CSI, OSC (com BEL terminador) e ESC simples', () => {
    expect(stripAnsi('\x1b[2K\x1b[1mOi\x1b[0m \x1b]0;titulo\x07mundo\x1bMfim')).toBe('Oi mundofim')
  })
})

describe('createActivityTracker', () => {
  it('frame de spinner com "esc to interrupt" → working', () => {
    const { changes, tracker } = track()
    tracker.feed('\x1b[2K✳ Deliberating… (esc to interrupt)')
    expect(changes).toEqual(['working'])
  })

  it('marcador dividido entre chunks também vira working', () => {
    const { changes, tracker } = track()
    tracker.feed('✳ Pensando… (esc to inter')
    tracker.feed('rupt)')
    expect(changes).toEqual(['working'])
  })

  it('prompt de permissão + silêncio → waiting', () => {
    const { changes, tracker } = track()
    tracker.feed('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n')
    vi.advanceTimersByTime(1500)
    expect(changes.at(-1)).toBe('waiting')
  })

  it('BEL real (fora de OSC) → waiting imediato', () => {
    const { changes, tracker } = track()
    tracker.feed('\x07')
    expect(changes).toEqual(['waiting'])
  })

  it('BEL terminando OSC de título NÃO é sino', () => {
    const { changes, tracker } = track()
    tracker.feed('\x1b]0;claude — projeto\x07')
    expect(changes).toEqual([])
  })

  it('frame final sem marcadores + silêncio → idle (working → idle no fim do turno)', () => {
    const { changes, tracker } = track()
    tracker.feed('✳ Gerando… (esc to interrupt)')
    vi.advanceTimersByTime(400)
    tracker.feed('╭──────╮\r\n│ >    │\r\n╰──────╯')
    vi.advanceTimersByTime(1500)
    expect(changes).toEqual(['working', 'idle'])
  })

  it('waiting persiste no silêncio (sem output novo não rebaixa)', () => {
    const { changes, tracker } = track()
    tracker.feed('Would you like to proceed?\r\n❯ 1. Yes')
    vi.advanceTimersByTime(1500)
    expect(changes.at(-1)).toBe('waiting')
    vi.advanceTimersByTime(60_000)
    expect(changes.at(-1)).toBe('waiting')
  })

  it('depois de responder o prompt, o próximo frame quieto vira idle', () => {
    const { changes, tracker } = track()
    tracker.feed('Do you want to proceed?\r\n❯ 1. Yes')
    vi.advanceTimersByTime(1500) // waiting
    tracker.feed('╭──────╮\r\n│ >    │\r\n╰──────╯') // respondeu; frame novo sem prompt
    vi.advanceTimersByTime(1500)
    expect(changes).toEqual(['waiting', 'idle'])
  })

  it('eco de digitação (bytes esparsos) não vira working', () => {
    const { changes, tracker } = track()
    tracker.feed('o')
    tracker.feed('i')
    vi.advanceTimersByTime(1500)
    expect(changes).toEqual(['idle'])
  })

  it('não repete o mesmo estado (dedup)', () => {
    const { changes, tracker } = track()
    tracker.feed('x (esc to interrupt)')
    tracker.feed('y (esc to interrupt)')
    expect(changes).toEqual(['working'])
  })
})
