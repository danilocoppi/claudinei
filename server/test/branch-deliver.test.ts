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
/** O que voltou à fila gravada do operador (por terminal). */
let requeued: Array<{ projectId: number; engine: string; texts: string[] }>
let requeueFails: boolean
/** Status de cada sessão: o envio a põe em working (como o manager real). */
let status: Map<string, string>
let d: BranchDelivery

const manager = {
  send: (localId: string, text: string) => {
    if (failWith) throw failWith
    sent.push({ as: 'operator', localId, text })
    status.set(localId, 'working')
  },
  sendAsClaudinei: (localId: string, text: string) => {
    if (failWith) throw failWith
    sent.push({ as: 'claudinei', localId, text })
    status.set(localId, 'working')
  },
  get: (localId: string) => (status.has(localId) ? { status: status.get(localId) } : undefined) as any,
}

/** Claude e Codex aceitam mensagem no meio do turno; Kimi e OpenCode, não. */
const acceptsMidTurn = (engine: string) => engine === 'claude' || engine === 'codex'
const make = (m: typeof manager | Record<string, unknown> = manager) => createBranchDelivery({
  manager: m as typeof manager, holds: () => held, broadcast: (x) => broadcasts.push(x), log: () => {}, acceptsMidTurn,
  requeue: (projectId, engine, texts) => {
    if (requeueFails) throw new Error('terminal apagado')
    requeued.push({ projectId, engine, texts })
  },
})

const ctx = { projectId: 7, engine: 'kimi', localId: 'L1' }
const ctxClaude = { projectId: 7, engine: 'claude', localId: 'L1' }
/** Fim do turno da sessão: ela fica livre e o árbitro oferece o lugar 2. */
const fimDoTurno = (c = ctx) => { status.set(c.localId, 'idle'); return d.provider.offer(c) }
const errosNoChat = () => broadcasts.filter((b) => b.type === 'session_event' && b.event?.kind === 'system' && b.event?.subtype === 'message_error')

beforeEach(() => {
  vi.useFakeTimers()
  held = false
  sent = []
  failWith = null
  broadcasts = []
  requeued = []
  requeueFails = false
  status = new Map([['L1', 'idle']])
  d = make()
})

afterEach(() => {
  d.dispose()
  vi.useRealTimers()
})

describe('entrega do ramificar', () => {
  it('sem trava, motor que aceita mensagem no meio do turno: sai na hora, na ordem (o pacote como Claudinei, as mensagens como do operador)', () => {
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([
      { as: 'claudinei', localId: 'L1', text: 'pacote' },
      { as: 'operator', localId: 'L1', text: 'pergunta' },
    ])
    expect(fimDoTurno(ctxClaude)).toBe(false)
  })

  it('motor sem mensagem no meio do turno (Kimi, OpenCode): uma por turno; o resto espera o fim do turno sem prazo e sai antes da fila', () => {
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'um', as: 'operator' }, { text: 'dois', as: 'operator' }])
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    // Turno longo do pacote: sem trava, a espera não desiste por prazo.
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 5)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    expect(errosNoChat()).toEqual([])
    expect(requeued).toEqual([])
    expect(fimDoTurno()).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'um'])
    expect(fimDoTurno()).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'um', 'dois'])
    expect(fimDoTurno()).toBe(false)
  })

  it('motor sem mensagem no meio do turno com a sessão trabalhando: nada sai agora; espera o fim do turno', () => {
    status.set('L1', 'working')
    d.deliver('L1', 7, 'opencode', [{ text: 'pacote', as: 'claudinei' }])
    expect(sent).toEqual([])
    expect(fimDoTurno({ ...ctx, engine: 'opencode' })).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
  })

  it('com trava: nada sai; o cutucão depois da soltura (lugar 2 do árbitro) entrega tudo na ordem', () => {
    held = true
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([])
    expect(d.provider.slot).toBeLessThan(3) // antes da fila do operador
    held = false
    expect(d.provider.offer(ctxClaude)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
    // Entregue: o limite não dispara depois.
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 2)
    expect(errosNoChat()).toEqual([])
    expect(fimDoTurno(ctxClaude)).toBe(false)
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
    d = make({ ...m, get: manager.get })
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(sent).toEqual([])
    expect(errosNoChat()).toEqual([])
    expect(d.provider.offer(ctxClaude)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
  })

  it('a trava que não solta até o limite: desiste; o pacote fica visível no chat e a mensagem do operador volta à fila gravada', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote grande', as: 'claudinei' }, { text: 'minha pergunta', as: 'operator' }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS - 1)
    expect(errosNoChat()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([])
    const erros = errosNoChat()
    expect(erros).toHaveLength(1)
    expect(erros[0].localId).toBe('L1')
    expect(erros[0].event.raw.message).toContain('pacote grande')
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['minha pergunta'] }])
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

  it('envio que falha por outro motivo: o pacote vai na hora ao chat (não só ao log) e a mensagem do operador volta à fila', () => {
    failWith = new UserError('engine_error', 'o motor recusou')
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    const erros = errosNoChat()
    expect(erros.map((e) => e.event.raw.message)).toEqual([expect.stringContaining('pacote')])
    expect(erros[0].event.raw.message).toContain('o motor recusou')
    expect(requeued).toEqual([{ projectId: 7, engine: 'claude', texts: ['pergunta'] }])
  })

  it('a fila não aceita de volta (terminal apagado): a mensagem do operador também vai ao chat', () => {
    requeueFails = true
    failWith = new UserError('engine_error', 'o motor recusou')
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(errosNoChat().map((e) => e.event.raw.message)).toEqual([
      expect.stringContaining('pacote'),
      expect.stringContaining('pergunta'),
    ])
  })

  it('sessão fora do ar na entrega (o revive falhou): não espera; o pacote vai ao chat e a mensagem à fila', () => {
    status.set('L1', 'dead')
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(errosNoChat().map((e) => e.event.raw.message)).toEqual([expect.stringContaining('pacote')])
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pergunta'] }])
    held = false
    expect(fimDoTurno()).toBe(false)
  })

  it('no limite, a trava já soltou mas a sessão está ocupada: continua esperando o fim do turno, sem desistir', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }])
    held = false
    status.set('L1', 'working') // outro turno começou (o operador, por exemplo)
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    expect(sent).toEqual([])
    expect(errosNoChat()).toEqual([])
    expect(fimDoTurno()).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
  })

  it('esperando o fim do turno, a trava que aparece só desiste se ainda segura no limite seguinte', () => {
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    held = true
    status.set('L1', 'idle') // o turno do pacote acabou já com a trava (o árbitro não oferece)
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(requeued).toEqual([])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pergunta'] }])
  })

  it('o terminal termina (fechado, apagado ou morto) durante a espera: o texto sai na hora e a espera é esquecida', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    d.ended('L1')
    expect(errosNoChat().map((e) => e.event.raw.message)).toEqual([expect.stringContaining('pacote')])
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pergunta'] }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    held = false
    expect(fimDoTurno()).toBe(false)
    expect(errosNoChat()).toHaveLength(1)
    // Outra sessão sem espera: nada acontece.
    expect(() => d.ended('L9')).not.toThrow()
  })

  it('desligamento com espera: o pacote vai ao chat e a mensagem do operador volta à fila antes de limpar', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    d.dispose()
    expect(errosNoChat().map((e) => e.event.raw.message)).toEqual([expect.stringContaining('pacote')])
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pergunta'] }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    expect(errosNoChat()).toHaveLength(1)
  })

  it('outra entrega para a mesma sessão enquanto a primeira espera: vai atrás dela', () => {
    held = true
    d.deliver('L1', 7, 'claude', [{ text: 'um', as: 'claudinei' }])
    held = false
    d.deliver('L1', 7, 'claude', [{ text: 'dois', as: 'operator' }])
    expect(sent).toEqual([])
    expect(d.provider.offer(ctxClaude)).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['um', 'dois'])
  })
})
