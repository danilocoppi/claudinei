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

// Rodapés REAIS extraídos dos binários instalados (strings) — a frase muda por
// CLI e por versão; o `esc to interrupt` de antes só existia no Claude antigo.
describe('working em todas as engines (rodapé real de cada TUI)', () => {
  const frames: Array<[string, string]> = [
    ['claude 2.1.220', '\x1b[2K✳ Deliberating… (Esc to stop)'],
    ['claude (cancel)', '\x1b[2K✳ Thinking… esc to cancel'],
    ['codex 0.146', '\x1b[2K⠋ Working… Ctrl-C to stop'],
    ['codex (now)', '▌ Press Ctrl+C now to cancel'],
    ['kimi 0.30', '\x1b[2K◆ Pensando… Esc / Ctrl-C to stop'],
    ['kimi (cancel)', '◆ Rodando ferramenta… Ctrl-C to cancel'],
    ['legado', '✳ Gerando… (esc to interrupt)'],
  ]
  for (const [nome, frame] of frames) {
    it(`${nome} → working`, () => {
      const seen: string[] = []
      const tracker = createActivityTracker((a) => seen.push(a))
      tracker.feed(frame)
      expect(seen).toEqual(['working'])
      tracker.dispose()
    })
  }

  it('prompt de aprovação do Codex/Kimi → waiting no silêncio', () => {
    const { changes, tracker } = track()
    tracker.feed('Allow command? (y/n)')
    vi.advanceTimersByTime(1500) // silêncio: a avaliação reclassifica o frame
    expect(changes.at(-1)).toBe('waiting')
    tracker.dispose()
  })

  it('"Esc to cancel" de diálogo parado vira working e se CORRIGE no silêncio', () => {
    const { changes, tracker } = track()
    tracker.feed('Do you want to proceed?\r\n❯ 1. Yes   (Esc to cancel)')
    expect(changes).toEqual(['working']) // falso positivo momentâneo, assumido
    vi.advanceTimersByTime(1500)
    expect(changes.at(-1)).toBe('waiting')
    tracker.dispose()
  })

  it('texto comum não vira working (sem falso positivo)', () => {
    const seen: string[] = []
    const tracker = createActivityTracker((a) => seen.push(a))
    tracker.feed('escreva o resumo e pare de cancelar as tarefas')
    expect(seen).toEqual([])
    tracker.dispose()
  })
})
