import type { TriageStore, WakeReason } from './store.js'
import { triageMessage } from '../routes/triage.js'

/**
 * O despertador: o terminal precisa do operador (pergunta aberta, turno que
 * falhou, sessão morta, aviso retido do reinício, limite de uso), então sai de
 * Assentados e de Adiados para TODOS os usuários, mantendo o pin. Cada usuário
 * afetado recebe o próprio estado novo pelo WS; quem não tinha nada a acordar
 * não recebe nada.
 *
 * O motivo não muda o efeito hoje; fica na assinatura para quem chama dizer por
 * que acordou (e para o log, se um dia for preciso).
 */
export function createTriageWaker(deps: { store: TriageStore; broadcast: (msg: object) => void }) {
  return {
    wake(projectId: number, _reason: WakeReason): void {
      for (const userId of deps.store.wakeProject(projectId)) {
        deps.broadcast(triageMessage(userId, deps.store.get(userId, projectId)))
      }
    },
  }
}

export type TriageWaker = ReturnType<typeof createTriageWaker>
