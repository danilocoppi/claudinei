import type { SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from './terminal-state.js'

/**
 * Reinício normal (SIGINT/SIGTERM): registra quem estava no meio de um turno,
 * ANTES de parar as sessões. Chamar antes do `stopAll`.
 *
 * Liga o modo de encerramento primeiro: a partir daí a sessão que cai foi
 * derrubada pelo reinício, e a tarefa encaminhada a ela fica `in_progress` em vez
 * de fechar como falha. Conta como trabalhando também a sessão compactando. A
 * pergunta aberta (AskUserQuestion) vai junto, para o aviso mostrar o que se
 * perdeu. Devolve quantas marcou.
 */
export function captureShutdown(manager: SessionManager, store: TerminalStateStore): number {
  manager.beginShutdown()
  let marcadas = 0
  for (const s of manager.list()) {
    if (s.status !== 'working' && s.compactingSince === undefined) continue
    store.markInterrupted(s.projectId, s.engine, s.localId, s.pendingQuestion?.questions ?? null)
    marcadas++
  }
  return marcadas
}
