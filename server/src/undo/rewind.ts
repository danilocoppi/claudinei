import type { TurnRow } from './store.js'

/**
 * Onde cortar a conversa do Codex. `beforeTurnId` sai junto com os seguintes
 * (`thread/revert`); `previousTurnId` é o último que fica, para o `thread/fork`
 * quando o revert é recusado: `null` = era o primeiro turno, ausente = não se
 * sabe ainda (o corte veio do `anchor` gravado; o `apply` procura na lista).
 * `midTurn`: a mensagem entrou com `turn/steer`, e o Codex só corta turnos
 * inteiros — as duas voltas ficam desligadas.
 */
export type CodexCut = { kind: 'codex'; beforeTurnId: string; previousTurnId?: string | null; midTurn: boolean }

/** Onde cortar a conversa do Claude: a entrada anterior à mensagem (`null` = era a primeira). A Task 12 reexporta de rewind-claude.ts. */
export type ClaudeCut = { kind: 'claude'; parentUuid: string | null }

export type ConversationCut = CodexCut | ClaudeCut

export interface RewindCtx { localId: string; projectPath: string; engineSessionId: string | null }

/** Como cada motor acha o ponto da conversa e volta até ele. */
export interface RewindAdapter {
  locate(ctx: RewindCtx & { turn?: TurnRow }, key: string, occurrence: number): Promise<ConversationCut | null>
  apply(ctx: RewindCtx, cut: ConversationCut): Promise<{ newConversationId?: string }>
}
