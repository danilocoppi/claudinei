import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserError } from '../src/user-error.js'
import { createBranchDelivery, DELIVERY_LIMIT_MS, type BranchDelivery } from '../src/branch/deliver.js'

/**
 * A entrega do que o ramificar manda sozinho (o pacote da ⇄, o do /fork no
 * Kimi, o pacote e as mensagens da cópia recusada): respeita as travas do
 * desfazer, espera a soltura (o cutucão do árbitro, lugar 2) e, se desiste,
 * deixa o texto no chat do terminal.
 */

let held: boolean
let sent: Array<{ as: 'claudinei' | 'operator'; localId: string; text: string }>
let failWith: Error | null
let broadcasts: any[]
let d: BranchDelivery

const manager = {
  send: (localId: string, text: string) => {
    if (failWith) throw failWith
    sent.push({ as: 'operator', localId, text })
  },
  sendAsClaudinei: (localId: string, text: string) => {
    if (failWith) throw failWith
    sent.push({ as: 'claudinei', localId, text })
  },
}

const ctx = { projectId: 7, engine: 'kimi', localId: 'L1' }
const errosNoChat = () => broadcasts.filter((b) => b.type === 'session_event' && b.event?.kind === 'system' && b.event?.subtype === 'message_error')

beforeEach(() => {
  vi.useFakeTimers()
  held = false
  sent = []
  failWith = null
  broadcasts = []
  d = createBranchDelivery({
    manager, holds: () => held, broadcast: (m) => broadcasts.push(m), log: () => {},
  })
})

afterEach(() => {
  d.dispose()
  vi.useRealTimers()
})

describe('entrega do ramificar', () => {
  it('sem trava: sai na hora, na ordem (o pacote como Claudinei, as mensagens como do operador)', () => {
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([
      { as: 'claudinei', localId: 'L1', text: 'pacote' },
      { as: 'operator', localId: 'L1', text: 'pergunta' },
    ])
    expect(d.provider.offer(ctx)).toBe(false)
  })

  it('com trava: nada sai; o cutucão depois da soltura (lugar 2 do árbitro) entrega tudo na ordem', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([])
    expect(d.provider.slot).toBeLessThan(3) // antes da fila do operador
    held = false
    expect(d.provider.offer(ctx)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
    // Entregue: o limite não dispara depois.
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 2)
    expect(errosNoChat()).toEqual([])
    expect(d.provider.offer(ctx)).toBe(false)
  })

  it('a trava que pega no meio (recusa do rastreador no envio): o resto espera, nada se perde', () => {
    let n = 0
    const m = {
      send: (localId: string, text: string) => { sent.push({ as: 'operator', localId, text }) },
      sendAsClaudinei: (localId: string, text: string) => {
        if (n++ === 0) throw new UserError('undo_writing', 'o Claudinei está desfazendo arquivos nesta pasta')
        sent.push({ as: 'claudinei', localId, text })
      },
    }
    d.dispose()
    d = createBranchDelivery({ manager: m, holds: () => false, broadcast: (x) => broadcasts.push(x), log: () => {} })
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([])
    expect(errosNoChat()).toEqual([])
    expect(d.provider.offer(ctx)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
  })

  it('a trava que não solta até o limite: desiste e deixa cada texto visível no chat do terminal', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote grande', as: 'claudinei' }, { text: 'minha pergunta', as: 'operator' }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS - 1)
    expect(errosNoChat()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([])
    const erros = errosNoChat()
    expect(erros).toHaveLength(2)
    expect(erros.every((e) => e.localId === 'L1')).toBe(true)
    expect(erros[0].event.raw.message).toContain('pacote grande')
    expect(erros[1].event.raw.message).toContain('minha pergunta')
    // Desistiu: o cutucão seguinte não manda nada (nem repete).
    held = false
    expect(d.provider.offer(ctx)).toBe(false)
    expect(sent).toEqual([])
  })

  it('a trava que solta sem cutucão: no limite, manda em vez de desistir', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }])
    held = false
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    expect(errosNoChat()).toEqual([])
  })

  it('envio que falha por outro motivo (sessão fora do ar): o texto vai na hora ao chat, não só ao log', () => {
    failWith = new UserError('session_not_active', 'sessão L1 não está ativa')
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    const erros = errosNoChat()
    expect(erros.map((e) => e.event.raw.message)).toEqual([
      expect.stringContaining('pacote'),
      expect.stringContaining('pergunta'),
    ])
    expect(erros[0].event.raw.message).toContain('sessão L1 não está ativa')
  })

  it('outra entrega para a mesma sessão enquanto a primeira espera: vai atrás dela', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'um', as: 'claudinei' }])
    held = false
    d.deliver('L1', 7, 'kimi', [{ text: 'dois', as: 'operator' }])
    expect(sent).toEqual([])
    expect(d.provider.offer(ctx)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['um', 'dois'])
  })
})
