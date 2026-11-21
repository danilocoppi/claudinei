// O bastão de uma aba: quem pode mexer na página agora. Livre, agente agindo
// (só durante uma ferramenta que muda a página) ou operador no comando (com o
// nome). A ação do operador toma o bastão na hora; a ferramenta do agente que
// encontra o operador no comando é recusada. Vive na memória, como a aba.
import { TEXTS } from './types.js'

export type BatonState = { kind: 'free' } | { kind: 'agent' } | { kind: 'operator'; userId: number | null; name: string }

/** A ferramenta que muda a página encontrou o operador no comando. */
export class OperatorInControlError extends Error {
  readonly code = 'operator_in_control' as const
  constructor() {
    super(TEXTS.OPERATOR_IN_CONTROL)
    this.name = 'OperatorInControlError'
  }
}

export interface Baton {
  state(): BatonState
  /** Avança a cada ação do operador: referência de snapshot anterior fica velha. */
  epoch(): number
  /**
   * Operador no comando → OperatorInControlError. Chame `endAgent` (no `finally`)
   * só depois de `beginAgent` ter voltado sem lançar.
   */
  beginAgent(): void
  /** Fim da ação do agente: volta a livre se o agente ainda tinha o bastão. */
  endAgent(): void
  /** Toma o bastão na hora (ou troca o dono) e avança o epoch. */
  operatorAct(user: { userId: number | null; name: string }): void
  /** Operador → livre; anota 'control returned to the agent' para o agente. Sem operador: no-op. */
  release(): void
  /** O dono sem coluna visível por `graceMs` devolve o bastão; presença de outro usuário não conta. */
  presence(userId: number | null, hasVisibleColumn: boolean): void
  onChange(fn: () => void): () => void
  /** A aba fechou: para o relógio e desliga os ouvintes. */
  dispose(): void
}

const GRACE_MS = 30_000
const RETURNED = 'control returned to the agent'

export function createBaton(o: { onNotice: (agentText: string) => void; graceMs?: number }): Baton {
  const graceMs = o.graceMs ?? GRACE_MS
  const listeners = new Set<() => void>()
  let operator: { userId: number | null; name: string } | null = null
  /**
   * Ações do agente em curso. Um contador, não um sinal: ferramentas em paralelo
   * do mesmo terminal não devolvem o bastão quando a primeira termina.
   */
  let agentActive = 0
  let epoch = 0
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function emit(): void {
    for (const fn of [...listeners]) {
      try { fn() } catch { /* um ouvinte não impede os outros */ }
    }
  }

  function stopGrace(): void {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = undefined }
  }

  function release(): void {
    if (!operator) return
    stopGrace()
    operator = null
    o.onNotice(RETURNED)
    emit()
  }

  return {
    state: (): BatonState => (operator
      ? { kind: 'operator', userId: operator.userId, name: operator.name }
      : agentActive > 0 ? { kind: 'agent' } : { kind: 'free' }),

    epoch: () => epoch,

    beginAgent() {
      if (operator) throw new OperatorInControlError()
      agentActive++
      if (agentActive === 1) emit()
    },

    endAgent() {
      if (agentActive === 0) return
      agentActive--
      // Com o operador no comando, a ação que já estava em curso termina sem mexer no bastão.
      if (!operator && agentActive === 0) emit()
    },

    operatorAct(user) {
      epoch++
      const changed = !operator || operator.userId !== user.userId || operator.name !== user.name
      // Quem age tem a coluna à vista: o relógio do dono (antigo ou atual) para.
      stopGrace()
      operator = { userId: user.userId, name: user.name }
      if (changed) emit()
    },

    release,

    presence(userId, hasVisibleColumn) {
      if (disposed || !operator || userId !== operator.userId) return
      if (hasVisibleColumn) { stopGrace(); return }
      // Já contando: repetir o "sem coluna" não reinicia o relógio.
      if (graceTimer) return
      graceTimer = setTimeout(() => { graceTimer = undefined; release() }, graceMs)
      graceTimer.unref?.()
    },

    onChange(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    dispose() {
      disposed = true
      stopGrace()
      listeners.clear()
    },
  }
}
