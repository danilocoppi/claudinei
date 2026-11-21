import { turnKey } from '../../../shared/undo.js'
import type { SessionManager } from '../claude/manager.js'
import type { CodexSession } from '../engine/codex/codex-session.js'
import { CodexRpcError } from '../engine/codex/codex-rpc.js'
import { forgetRollout, sessionsRoot } from '../engine/codex/rollout.js'
import type { CodexCut, RewindAdapter } from './rewind.js'

export type { CodexCut }

export interface CodexTurn { id: string; userTexts: string[] }

type Rewindable = Pick<CodexSession, 'sessionId' | 'status' | 'revertConversation' | 'forkConversation' | 'listTurns'>

function rewindable(s: unknown): s is Rewindable {
  return !!s && typeof (s as Rewindable).revertConversation === 'function'
    && typeof (s as Rewindable).forkConversation === 'function' && typeof (s as Rewindable).listTurns === 'function'
}

/**
 * O turno da mensagem com a chave `key`: a `occurrence`-ésima ocorrência
 * contando de trás para frente (0 = a última). `midTurn` quando a mensagem não
 * é o primeiro `userMessage` do turno (entrou com `turn/steer`).
 */
export function locateCodexCut(turns: CodexTurn[], key: string, occurrence: number): CodexCut | null {
  if (!Number.isInteger(occurrence) || occurrence < 0) return null
  let seen = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const texts = turns[i].userTexts
    for (let j = texts.length - 1; j >= 0; j--) {
      if (turnKey(texts[j]) !== key) continue
      if (seen++ < occurrence) continue
      return { kind: 'codex', beforeTurnId: turns[i].id, previousTurnId: turns[i - 1]?.id ?? null, midTurn: j > 0 }
    }
  }
  return null
}

export function createCodexRewind(deps: { manager: Pick<SessionManager, 'liveSession' | 'relaunch' | 'revive' | 'get'> }): RewindAdapter {
  const { manager } = deps

  /** A sessão do Codex do terminal; revive se não está viva. */
  function alive(localId: string): Rewindable {
    if (!manager.get(localId)) throw new Error(`terminal ${localId} não existe`)
    let session = manager.liveSession(localId)
    if (!session || session.status === 'dead' || session.status === 'stopped') {
      manager.revive(localId)
      session = manager.liveSession(localId)
    }
    if (!rewindable(session)) throw new Error('a sessão do terminal não é do Codex')
    return session
  }

  /**
   * O turno que fica quando o corte veio do `anchor` gravado. Sem achar o
   * `beforeTurnId` na conversa, devolve o erro do revert: abrir conversa nova
   * por engano jogaria fora a conversa inteira.
   */
  async function previousOf(session: Rewindable, beforeTurnId: string, refusal: Error): Promise<string | null> {
    let turns: CodexTurn[]
    try { turns = await session.listTurns() } catch { throw refusal }
    const at = turns.findIndex((t) => t.id === beforeTurnId)
    if (at < 0) throw refusal
    return turns[at - 1]?.id ?? null
  }

  return {
    async locate(ctx, key, occurrence) {
      const turn = ctx.turn
      // Mensagem do meio do turno: o Codex só corta turnos inteiros (o serviço desliga as voltas).
      if (turn?.midTurn) return { kind: 'codex', beforeTurnId: turn.anchor ?? '', midTurn: true }
      if (turn?.anchor) return { kind: 'codex', beforeTurnId: turn.anchor, midTurn: false }
      // Sem anchor (mensagem anterior ao recurso): pergunta à conversa viva. Não sobe processo só para olhar.
      const session = manager.liveSession(ctx.localId)
      if (!rewindable(session) || !session.sessionId || session.status === 'dead' || session.status === 'stopped') return null
      let turns: CodexTurn[]
      try {
        turns = await session.listTurns()
      } catch (err) {
        // Recusa do App Server (conversa sem paginação): não há onde achar. Sessão ocupada sobe.
        if (err instanceof CodexRpcError) return null
        throw err
      }
      return locateCodexCut(turns, key, occurrence)
    },

    async apply(ctx, cut) {
      if (cut.kind !== 'codex') throw new Error('corte de outro motor')
      if (cut.midTurn || !cut.beforeTurnId) throw new Error('codex: mensagem do meio do turno não volta a conversa')
      const session = alive(ctx.localId)
      const threadId = session.sessionId
      try {
        await session.revertConversation(cut.beforeTurnId)
        // O revert troca o rollout do thread; o histórico precisa achar o novo.
        if (threadId) forgetRollout(sessionsRoot(), threadId)
        return {}
      } catch (err) {
        if (!(err instanceof CodexRpcError)) throw err
        // Revert recusado (conversa do formato antigo): fork até o turno anterior.
        const previous = cut.previousTurnId !== undefined ? cut.previousTurnId : await previousOf(session, cut.beforeTurnId, err)
        if (previous) {
          const forkId = await session.forkConversation(previous)
          await manager.relaunch(ctx.localId, { resumeSessionId: forkId })
          return { newConversationId: forkId }
        }
        // Era o primeiro turno: nada fica, conversa nova. O thread dela só nasce
        // no primeiro turno; até o result dele o manager mostraria o id antigo,
        // do banco, e o ramificar copiaria a conversa de antes da volta. Com o
        // id segurado, `/side`, `/fork` e ⇄ recusam com `rewind_pending` (o
        // result do Codex solta a trava pelo mesmo caminho do Claude).
        await manager.relaunch(ctx.localId, { resumeSessionId: null, holdEngineId: true })
        return {}
      }
    },
  }
}
