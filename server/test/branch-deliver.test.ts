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
/** Os cutucões no árbitro (o limite com a sessão livre não manda direto). */
let poked: Array<{ projectId: number; engine: string }>
/**
 * O árbitro oferece o lugar 2 ao ser cutucado (sem aviso, encerramento nem
 * compactação pendente segurando). Desligado, o cutucão não entrega nada.
 */
let arbiterOffers: boolean
let pokeFails: boolean
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
  poke: (projectId, engine) => {
    poked.push({ projectId, engine })
    if (pokeFails) throw new Error('árbitro quebrou')
    if (arbiterOffers) d.provider.offer({ projectId, engine, localId: 'L1' })
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
  poked = []
  arbiterOffers = false
  pokeFails = false
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

  it('a trava que não solta até o limite: desiste; o pacote e a mensagem do operador voltam, na ordem, à fila gravada, com um aviso no chat', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote grande', as: 'claudinei' }, { text: 'minha pergunta', as: 'operator' }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS - 1)
    expect(errosNoChat()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([])
    const erros = errosNoChat()
    expect(erros).toHaveLength(1)
    expect(erros[0].localId).toBe('L1')
    expect(erros[0].event.raw.message).toContain('2 mensagens não foram entregues')
    expect(erros[0].event.raw.i18nKey).toBe('branch.notice.requeued')
    expect(erros[0].event.raw.i18nParams).toEqual({ reasonCode: 'undo_held', reason: 'o desfazer segurou o terminal por tempo demais', count: 2 })
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pacote grande', 'minha pergunta'] }])
    // Desistiu: o cutucão seguinte não manda nada (nem repete).
    held = false
    expect(d.provider.offer(ctx)).toBe(false)
    expect(sent).toEqual([])
  })

  it('a trava que solta sem cutucão: no limite, não manda direto; cutuca o árbitro, que oferece o lugar 2', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }])
    held = false
    arbiterOffers = true
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(poked).toEqual([{ projectId: 7, engine: 'kimi' }])
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    expect(errosNoChat()).toEqual([])
    // Entregue: nenhum relógio sobra nem cutuca de novo.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    expect(poked).toHaveLength(1)
  })

  it('no limite, sessão livre e sem trava, mas o árbitro segura (aviso de limite de uso, compactação pendente, encerramento): não manda, cutuca e continua esperando', () => {
    held = true
    d.deliver('L1', 7, 'opencode', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    held = false
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(sent).toEqual([])
    expect(poked).toEqual([{ projectId: 7, engine: 'opencode' }])
    // Um cutucão por limite, com um único relógio armado (sem laço quente nem vazamento).
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    expect(poked).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(1)
    // Sem trava, não desiste: nada vai ao chat nem volta à fila.
    expect(sent).toEqual([])
    expect(errosNoChat()).toEqual([])
    expect(requeued).toEqual([])
    // O aviso saiu e o árbitro oferece o lugar 2: o texto sai (um por turno no OpenCode).
    expect(fimDoTurno({ ...ctx, engine: 'opencode' })).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    expect(fimDoTurno({ ...ctx, engine: 'opencode' })).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no limite, o cutucão que entrega só o primeiro (motor de um por turno): o resto volta à espera com um único relógio', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    held = false
    arbiterOffers = true
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
    expect(vi.getTimerCount()).toBe(1)
    expect(fimDoTurno()).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote', 'pergunta'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no limite, o cutucão que quebra não perde o texto: continua esperando', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }])
    held = false
    pokeFails = true
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(poked).toHaveLength(1)
    expect(sent).toEqual([])
    expect(errosNoChat()).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    expect(fimDoTurno()).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['pacote'])
  })

  it('no limite, o desligamento e o fim do terminal ainda limpam a espera que só cutucou', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }])
    held = false
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(poked).toHaveLength(1)
    d.ended('L1')
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pacote'] }])
    expect(errosNoChat().map((e) => e.event.raw.i18nParams?.reasonCode)).toEqual(['ended'])
    expect(vi.getTimerCount()).toBe(0)
    // Nova espera que também só cutucou: o desligamento a limpa.
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'mais um', as: 'claudinei' }])
    held = false
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS)
    expect(poked).toHaveLength(2)
    d.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(requeued.map((r) => r.texts)).toEqual([['pacote'], ['mais um']])
    expect(errosNoChat().map((e) => e.event.raw.i18nParams?.reasonCode)).toEqual(['ended', 'shutdown'])
  })

  it('envio que falha por outro motivo: tudo volta na hora à fila (não só ao log), com o erro do motor no aviso', () => {
    failWith = new UserError('engine_error', 'o motor recusou')
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    const erros = errosNoChat()
    expect(erros).toHaveLength(1)
    expect(erros[0].event.raw.message).toContain('o motor recusou')
    expect(erros[0].event.raw.i18nParams).toEqual({ reason: 'o motor recusou', count: 2 })
    expect(requeued).toEqual([{ projectId: 7, engine: 'claude', texts: ['pacote', 'pergunta'] }])
  })

  it('a fila não aceita de volta (terminal apagado): cada texto vai ao chat, para copiar', () => {
    requeueFails = true
    failWith = new UserError('engine_error', 'o motor recusou')
    d.deliver('L1', 7, 'claude', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(errosNoChat().map((e) => e.event.raw.message)).toEqual([
      expect.stringContaining('pacote'),
      expect.stringContaining('pergunta'),
    ])
    expect(errosNoChat().map((e) => e.event.raw.i18nKey)).toEqual(['branch.notice.undelivered', 'branch.notice.undelivered'])
    expect(errosNoChat()[0].event.raw.i18nParams).toEqual({ reason: 'o motor recusou', text: 'pacote' })
  })

  it('sessão fora do ar na entrega (o revive falhou): não espera; tudo volta à fila', () => {
    status.set('L1', 'dead')
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    expect(errosNoChat().map((e) => e.event.raw.i18nParams?.reasonCode)).toEqual(['not_active'])
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pacote', 'pergunta'] }])
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
    // Ocupada: nem cutuca (o fim do turno já chama o árbitro).
    expect(poked).toEqual([])
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
    expect(errosNoChat()).toHaveLength(1)
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pacote', 'pergunta'] }])
    vi.advanceTimersByTime(DELIVERY_LIMIT_MS * 3)
    held = false
    expect(fimDoTurno()).toBe(false)
    expect(errosNoChat()).toHaveLength(1)
    // Outra sessão sem espera: nada acontece.
    expect(() => d.ended('L9')).not.toThrow()
  })

  it('desligamento com espera: tudo volta à fila gravada antes de limpar (sobrevive ao reinício)', () => {
    held = true
    d.deliver('L1', 7, 'kimi', [{ text: 'pacote', as: 'claudinei' }, { text: 'pergunta', as: 'operator' }])
    d.dispose()
    expect(errosNoChat().map((e) => e.event.raw.i18nParams?.reasonCode)).toEqual(['shutdown'])
    expect(requeued).toEqual([{ projectId: 7, engine: 'kimi', texts: ['pacote', 'pergunta'] }])
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
