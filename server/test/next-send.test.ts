import { describe, it, expect } from 'vitest'
import { createNextSend, holdsForNotice, type NextSendProvider } from '../src/queue/next-send.js'
import type { SlotContext } from '../src/queue/operator-queue.js'
import type { TerminalStateRow } from '../src/restart/terminal-state.js'

/**
 * O árbitro do "próximo envio" com providers falsos: uma sessão livre por vez,
 * o menor lugar que aceitar fica com ela, e o aviso aberto segura todos.
 */

const ctx: SlotContext = { projectId: 1, engine: 'claude', localId: 'L1' }

function setup(opts: { hold?: boolean } = {}) {
  const calls: string[] = []
  const busy = new Set<string>()
  let hold = !!opts.hold
  /** Provider falso: aceita (e ocupa a sessão) se `accept` for verdadeiro. */
  const provider = (name: string, slot: number, accept: () => boolean): NextSendProvider => ({
    name, slot,
    offer: (c) => {
      calls.push(name)
      if (!accept()) return false
      busy.add(c.localId)
      return true
    },
  })
  const deps = {
    holds: () => hold,
    isFree: (localId: string) => !busy.has(localId),
    liveLocalId: (projectId: number, engine: string) => (projectId === 1 && engine === 'claude' ? 'L1' : null),
  }
  return { calls, busy, provider, deps, setHold: (h: boolean) => { hold = h } }
}

describe('árbitro do próximo envio', () => {
  it('entrega pelo menor slot que aceitar', () => {
    const s = setup()
    // Fora de ordem de propósito: o árbitro ordena pelos lugares.
    const nextSend = createNextSend({
      ...s.deps,
      providers: [s.provider('tarefas', 5, () => true), s.provider('fila', 3, () => false), s.provider('compacta', 1, () => false)],
    })
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['compacta', 'fila', 'tarefas'])
    expect(s.busy.has('L1')).toBe(true)

    // Quem aceita encerra: o lugar seguinte não é oferecido.
    s.calls.length = 0
    s.busy.clear()
    const first = createNextSend({
      ...s.deps,
      providers: [s.provider('fila', 3, () => true), s.provider('tarefas', 5, () => true)],
    })
    first.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['fila'])
  })

  it('com aviso aberto não chama nenhum provider', () => {
    const s = setup({ hold: true })
    const nextSend = createNextSend({
      ...s.deps,
      providers: [s.provider('fila', 3, () => true), s.provider('tarefas', 5, () => true)],
    })
    nextSend.onSessionAvailable(ctx)
    nextSend.poke(1, 'claude')
    expect(s.calls).toEqual([])
    expect(s.busy.size).toBe(0)
  })

  it('duas sessões livres no mesmo tique entregam uma vez', () => {
    const s = setup()
    const nextSend = createNextSend({
      ...s.deps,
      providers: [s.provider('fila', 3, () => true), s.provider('tarefas', 5, () => true)],
    })
    // idle logo seguido de needs_attention: o segundo "livre" acha a sessão ocupada.
    nextSend.onSessionAvailable(ctx)
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['fila'])
  })

  it('cada offer reconfere se a sessão segue livre', () => {
    const s = setup()
    // Um provider que ocupa a sessão mas devolve false (ex.: o envio saiu e falhou depois)
    // não deixa o lugar seguinte mandar outra coisa na mesma sessão.
    const ocupaSemAceitar: NextSendProvider = { name: 'fila', slot: 3, offer: (c) => { s.calls.push('fila'); s.busy.add(c.localId); return false } }
    const nextSend = createNextSend({ ...s.deps, providers: [ocupaSemAceitar, s.provider('tarefas', 5, () => true)] })
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['fila'])
  })

  it('provider que lança não impede os seguintes', () => {
    const s = setup()
    const logs: string[] = []
    const quebrado: NextSendProvider = { name: 'fila', slot: 3, offer: () => { throw new Error('boom') } }
    const nextSend = createNextSend({ ...s.deps, log: (m) => logs.push(m), providers: [quebrado, s.provider('tarefas', 5, () => true)] })
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['tarefas'])
    expect(logs.join('\n')).toMatch(/fila.*boom/)
  })

  it('poke depois que o aviso sai entrega', () => {
    const s = setup({ hold: true })
    const nextSend = createNextSend({ ...s.deps, providers: [s.provider('fila', 3, () => true)] })
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual([])
    s.setHold(false)
    nextSend.poke(1, 'claude')
    expect(s.calls).toEqual(['fila'])
    // Sem sessão viva do terminal, ou com ela ocupada, o poke não faz nada.
    s.calls.length = 0
    nextSend.poke(1, 'codex')
    nextSend.poke(1, 'claude')
    expect(s.calls).toEqual([])
  })

  it('register acrescenta um slot entre os existentes', () => {
    const s = setup()
    const nextSend = createNextSend({
      ...s.deps,
      providers: [s.provider('fila', 3, () => false), s.provider('tarefas', 5, () => false)],
    })
    nextSend.register(s.provider('aviso-delegada', 4, () => false))
    nextSend.register(s.provider('objetivo', 6, () => true))
    nextSend.onSessionAvailable(ctx)
    expect(s.calls).toEqual(['fila', 'aviso-delegada', 'tarefas', 'objetivo'])
  })
})

describe('holdsForNotice', () => {
  const base = (over: Partial<TerminalStateRow> = {}): TerminalStateRow => ({
    projectId: 1, engine: 'claude', autostart: false, autoResume: false,
    interruptedAt: null, interruptedLocalId: null, lostQuestion: null, holdReason: null, resumeCount: 0,
    autoResumeLimit: false, limitHitAt: null, limitResetsAt: null, limitOrigin: null, limitAction: 'none', limitTries: 0,
    ...over,
  } as TerminalStateRow)

  it('segura com o aviso do reinício ou com o aviso do limite na tela', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    const hit = '2026-11-20 11:00:00'
    expect(holdsForNotice(base(), now)).toBe(false)
    expect(holdsForNotice(base({ interruptedAt: hit }), now)).toBe(true)
    // Limite com reabertura no futuro segura, em qualquer ação.
    for (const limitAction of ['none', 'armed', 'snoozed'] as const) {
      expect(holdsForNotice(base({ limitHitAt: hit, limitResetsAt: now / 1000 + 60, limitAction }), now)).toBe(true)
    }
    // Já reaberto: o aviso em none segue na tela (só sai pelo operador), então segura;
    // adiado não mostra aviso, então não segura.
    expect(holdsForNotice(base({ limitHitAt: hit, limitResetsAt: now / 1000 - 60, limitAction: 'none' }), now)).toBe(true)
    expect(holdsForNotice(base({ limitHitAt: hit, limitResetsAt: now / 1000 - 60, limitAction: 'snoozed' }), now)).toBe(false)
    // Sem reabertura conhecida e passado o teto de 5 h: o aviso em none segue na tela.
    expect(holdsForNotice(base({ limitHitAt: '2026-11-20 01:00:00', limitResetsAt: null, limitAction: 'none' }), now)).toBe(true)
  })
})
