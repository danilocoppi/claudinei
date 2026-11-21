import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBaton, OperatorInControlError } from '../src/browser/baton.js'
import { TEXTS } from '../src/browser/types.js'

const ANA = { userId: 1, name: 'Ana' }
const BETO = { userId: 2, name: 'Beto' }

function make(graceMs?: number) {
  const notices: string[] = []
  const baton = createBaton({ onNotice: (t) => notices.push(t), graceMs })
  return { baton, notices }
}

describe('bastão', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('começa livre; beginAgent → agent; endAgent → free', () => {
    const { baton } = make()
    expect(baton.state()).toEqual({ kind: 'free' })
    baton.beginAgent()
    expect(baton.state()).toEqual({ kind: 'agent' })
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'free' })
  })

  it('duas ações do agente ao mesmo tempo: só a última a terminar devolve a livre; endAgent a mais não quebra', () => {
    const { baton } = make()
    baton.beginAgent()
    baton.beginAgent()
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'agent' })
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'free' })
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'free' })
    baton.beginAgent()
    expect(baton.state()).toEqual({ kind: 'agent' })
  })

  it('operatorAct durante ação do agente: o estado vira operator; endAgent da ação em curso não devolve ao agente; o próximo beginAgent lança OperatorInControlError com a mensagem verbatim', () => {
    const { baton } = make()
    baton.beginAgent()
    baton.operatorAct(ANA)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
    let err: unknown
    try { baton.beginAgent() } catch (e) { err = e }
    expect(err).toBeInstanceOf(OperatorInControlError)
    expect((err as OperatorInControlError).code).toBe('operator_in_control')
    expect((err as Error).message).toBe(TEXTS.OPERATOR_IN_CONTROL)
    expect((err as Error).message).toBe("The operator is controlling the browser. Do not retry in a loop; read-only tools still work; ask the operator to click 'Return to agent' if you need it")
    // A recusa não conta como ação em curso: depois de devolver, o bastão fica livre.
    baton.release()
    expect(baton.state()).toEqual({ kind: 'free' })
  })

  it('operatorAct avança epoch a cada chamada', () => {
    const { baton } = make()
    expect(baton.epoch()).toBe(0)
    baton.operatorAct(ANA)
    expect(baton.epoch()).toBe(1)
    baton.operatorAct(ANA)
    baton.operatorAct(ANA)
    expect(baton.epoch()).toBe(3)
    // Ações do agente e a devolução não mexem no epoch.
    baton.release()
    baton.beginAgent()
    baton.endAgent()
    expect(baton.epoch()).toBe(3)
  })

  it('outro operador agindo troca o dono (nome no estado)', () => {
    const { baton } = make()
    baton.operatorAct(ANA)
    baton.operatorAct(BETO)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 2, name: 'Beto' })
  })

  it("release → free e onNotice('control returned to the agent')", () => {
    const { baton, notices } = make()
    baton.operatorAct(ANA)
    baton.release()
    expect(baton.state()).toEqual({ kind: 'free' })
    expect(notices).toEqual(['control returned to the agent'])
    // Sem operador no comando, release é no-op.
    baton.release()
    expect(notices).toEqual(['control returned to the agent'])
  })

  it('onChange avisa a cada troca de estado, não a cada ação do mesmo dono; o retorno desliga', () => {
    const { baton } = make()
    const fn = vi.fn()
    const off = baton.onChange(fn)
    baton.beginAgent()
    expect(fn).toHaveBeenCalledTimes(1)
    baton.endAgent()
    expect(fn).toHaveBeenCalledTimes(2)
    baton.operatorAct(ANA)
    baton.operatorAct(ANA)
    expect(fn).toHaveBeenCalledTimes(3)
    baton.operatorAct(BETO)
    expect(fn).toHaveBeenCalledTimes(4)
    baton.release()
    expect(fn).toHaveBeenCalledTimes(5)
    off()
    baton.operatorAct(ANA)
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('presence(dono, false) por 29 s mantém; aos 30 s devolve; presence(dono, true) no meio cancela', () => {
    const { baton, notices } = make()
    baton.operatorAct(ANA)
    baton.presence(1, false)
    vi.advanceTimersByTime(29_000)
    // Repetir o "sem coluna" não reinicia o relógio.
    baton.presence(1, false)
    expect(baton.state().kind).toBe('operator')
    vi.advanceTimersByTime(1_000)
    expect(baton.state()).toEqual({ kind: 'free' })
    expect(notices).toEqual(['control returned to the agent'])

    baton.operatorAct(ANA)
    baton.presence(1, false)
    vi.advanceTimersByTime(20_000)
    baton.presence(1, true)
    vi.advanceTimersByTime(60_000)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
  })

  it('presence de outro usuário não afeta o relógio do dono', () => {
    const { baton } = make()
    baton.operatorAct(ANA)
    baton.presence(1, false)
    vi.advanceTimersByTime(15_000)
    baton.presence(2, true)
    baton.presence(2, false)
    vi.advanceTimersByTime(15_000)
    expect(baton.state()).toEqual({ kind: 'free' })

    // E o relógio de outro usuário nunca começa.
    baton.presence(1, true)
    baton.operatorAct(ANA)
    baton.presence(2, false)
    vi.advanceTimersByTime(60_000)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
  })

  it('presence(1, false) com o bastão livre, depois operatorAct do usuário 1 → o bastão volta em 30 s', () => {
    const { baton, notices } = make()
    baton.presence(1, false)
    baton.operatorAct(ANA)
    vi.advanceTimersByTime(29_000)
    // Outra ação do mesmo dono, ainda sem coluna, não reinicia o relógio.
    baton.operatorAct(ANA)
    expect(baton.state().kind).toBe('operator')
    vi.advanceTimersByTime(1_000)
    expect(baton.state()).toEqual({ kind: 'free' })
    expect(notices).toEqual(['control returned to the agent'])

    // Com a coluna à vista de novo, a ação seguinte não liga relógio.
    baton.presence(1, true)
    baton.operatorAct(ANA)
    vi.advanceTimersByTime(60_000)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
  })

  it('outro operador toma o bastão sem coluna conhecida à vista: o relógio dele começa', () => {
    const { baton } = make()
    baton.operatorAct(ANA)
    baton.presence(2, false)
    vi.advanceTimersByTime(60_000)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 1, name: 'Ana' })
    baton.operatorAct(BETO)
    vi.advanceTimersByTime(30_000)
    expect(baton.state()).toEqual({ kind: 'free' })
  })

  it("release com uma ação do agente em curso: fica 'agent' e vira 'free' no endAgent", () => {
    const { baton, notices } = make()
    const fn = vi.fn()
    baton.onChange(fn)
    baton.beginAgent()
    baton.operatorAct(ANA)
    baton.release()
    expect(baton.state()).toEqual({ kind: 'agent' })
    expect(notices).toEqual(['control returned to the agent'])
    baton.endAgent()
    expect(baton.state()).toEqual({ kind: 'free' })
    expect(notices).toEqual(['control returned to the agent'])
    // begin, operador, release, endAgent: uma troca cada.
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('outro operador toma o bastão: o relógio do dono antigo para', () => {
    const { baton } = make()
    baton.operatorAct(ANA)
    baton.presence(1, false)
    vi.advanceTimersByTime(20_000)
    baton.operatorAct(BETO)
    vi.advanceTimersByTime(60_000)
    expect(baton.state()).toEqual({ kind: 'operator', userId: 2, name: 'Beto' })
  })

  it('graceMs configurável; dispose cancela o relógio e desliga os ouvintes', () => {
    const { baton, notices } = make(5_000)
    const fn = vi.fn()
    baton.onChange(fn)
    baton.operatorAct(ANA)
    baton.presence(1, false)
    vi.advanceTimersByTime(5_000)
    expect(baton.state()).toEqual({ kind: 'free' })
    expect(fn).toHaveBeenCalledTimes(2)

    baton.operatorAct(ANA)
    baton.presence(1, false)
    baton.dispose()
    vi.advanceTimersByTime(60_000)
    expect(notices).toEqual(['control returned to the agent'])
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
