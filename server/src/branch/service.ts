import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from '../restart/terminal-state.js'
import type { RestartService } from '../restart/boot.js'
import type { SessionInfo } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { createProjectsService, type Project } from '../projects.js'
import { getEngine } from '../engine/index.js'
import { UserError } from '../user-error.js'
import { createSideService, type SideMain, type SideService } from './side.js'
import { forkTerminal, rewindInProgress, rewindPending } from './fork.js'
import { forkCopyDone, parseForkSource, type ForkSource } from './fork-source.js'
import { collectHandoff } from './handoff.js'
import { switchEngine } from './switch-engine.js'
import { createBranchDelivery } from './deliver.js'
import type { NextSendProvider } from '../queue/next-send.js'

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

/** O que os testes injetam na lateral para não abrir CLIs nem ler o storage real dos motores. */
export type SideTestDeps = Pick<Parameters<typeof createSideService>[0], 'makeSession' | 'cutFor' | 'collect' | 'cleanup'>

/**
 * Ramificar a conversa: a lateral (`/side`, `/btw`), o ramo (`/fork`) e a troca
 * de motor (⇄). Nasce no app, depois do goal; os ganchos do
 * manager (fim de turno, morte e fim da sessão) chegam pela referência que
 * index.ts guarda.
 */
export interface BranchService {
  side: SideService
  /** `/fork`: o terminal irmão com a cópia da conversa (ver fork.ts). */
  fork(req: { projectId: number; engine: string; name?: string; user?: AuthUser }): Promise<{ project: Project; session: SessionInfo }>
  /** ⇄: abre uma conversa nova em `to` com o pacote da conversa de `from` (ver switch-engine.ts). */
  switchEngine(req: { projectId: number; from: string; to: string }): Promise<SessionInfo>
  /** Mensagem do operador aceita pela sessão: a do ramo ainda sem cópia fica guardada até o fim do turno. */
  onOperatorMessage(projectId: number, engine: string, info: { localId?: string; text?: string }): void
  onTurnResult(projectId: number, engine: string): void
  onSessionDied(projectId: number, engine: string): void
  /**
   * A sessão saiu (fechada, apagada, morta; o relaunch da volta da conversa não
   * chega aqui). Com `localId`, o que esperava para ser entregue a ela sai na
   * hora (à fila do operador e ao chat), em vez de esperar o limite.
   */
  onSessionEnded(projectId: number, engine: string, localId?: string): void
  /**
   * O lugar 2 do árbitro do próximo envio: o pacote (e as mensagens da cópia
   * recusada) que esperou o desfazer soltar o terminal sai aqui (ver deliver.ts).
   */
  nextSendProvider: NextSendProvider
  bootCleanup(): Promise<void>
  dispose(): Promise<void>
}

export function createBranchService(deps: {
  db: Db
  manager: SessionManager
  broadcast: (m: object) => void
  store: TerminalStateStore
  restart: Pick<RestartService, 'publish' | 'dismiss'>
  /**
   * O desfazer está voltando a conversa do terminal ("Editar a partir daqui"
   * em curso): `/side`, `/fork` e ⇄ recusam com `rewind_in_progress`.
   */
  rewinding?: (projectId: number, engine: string) => boolean
  /** Antes de cada mensagem à lateral: lança a recusa do desfazer que segura a pasta ou a conversa. */
  holdSide?: (projectId: number, engine: string) => void
  /** A lateral entrou em working (ou saiu): o rastreador do desfazer a conta na pasta. */
  onSideWorking?: (projectId: number, engine: string, working: boolean) => void
  /**
   * O desfazer segura o terminal (o `holds` dele: escrita na pasta ou volta da
   * conversa): a ⇄ recusa o destino segurado, e o que o ramificar manda sozinho
   * espera a soltura (ver deliver.ts).
   */
  holds?: (projectId: number, engine: string) => boolean
  /**
   * Devolve à fila gravada do operador (na frente, pausada) as mensagens dele
   * que o ramificar não conseguiu entregar (ver deliver.ts). Lança se o
   * terminal não existe mais: aí elas vão ao chat.
   */
  requeue?: (projectId: number, engine: string, texts: string[]) => void
  side?: SideTestDeps
}): BranchService {
  const projects = createProjectsService(deps.db)
  const delivery = createBranchDelivery({
    manager: deps.manager, broadcast: deps.broadcast,
    holds: (projectId, engine) => deps.holds?.(projectId, engine) ?? false,
    requeue: deps.requeue,
  })
  const deliver = delivery.deliver

  /**
   * A sessão principal viva do terminal, com o início do turno em curso; null
   * sem sessão de pé. Com a volta da conversa em curso, lança
   * `rewind_in_progress` (antes de procurar a sessão: no relançamento ela pode
   * não estar de pé); pendente, `rewind_pending`: o id que ela mostra ainda é o
   * de antes da volta.
   */
  const main = (projectId: number, engine: string): SideMain | null => {
    if (deps.rewinding?.(projectId, engine)) throw rewindInProgress()
    const s = deps.manager.list().find((x) => x.projectId === projectId && x.engine === engine && ACTIVE.has(x.status))
    if (!s) return null
    if (deps.manager.rewindPending(s.localId)) throw rewindPending()
    return {
      localId: s.localId, status: s.status, engineSessionId: s.engineSessionId,
      model: s.model, effort: s.effort, turnStartedAt: deps.manager.turnStartedAt(s.localId),
    }
  }

  const side = createSideService({
    db: deps.db,
    broadcast: deps.broadcast,
    main,
    projectPath: (projectId) => projects.get(projectId)?.path ?? null,
    holdInput: deps.holdSide,
    onWorking: deps.onSideWorking,
    ...deps.side,
  })

  const collect = deps.side?.collect ?? collectHandoff

  /**
   * Mensagens do operador mandadas a um ramo cuja cópia ainda não existe, por
   * sessão, até o fim do turno. Se a cópia for recusada (a sessão morre antes
   * do init), elas saem de novo depois do pacote, sem o operador redigitar.
   */
  const pending = new Map<string, string[]>()

  /**
   * Trocas em curso por terminal+motor de destino. A reserva é síncrona: um
   * segundo pedido (outro navegador, clique duplo) chega enquanto o primeiro
   * ainda monta o pacote e encontraria o destino "livre".
   */
  const switching = new Set<string>()

  /**
   * Tira de `pending` as mensagens de um turno já encerrado (`sent`), mantendo
   * as que o operador mandou depois dele (o `onOperatorMessage` só acrescenta
   * no fim; se o começo já não é o do turno, alguém consumiu a lista antes).
   */
  const dropSent = (localId: string, sent: string[]): void => {
    const now = pending.get(localId)
    if (!now) return
    const rest = sent.every((t, i) => now[i] === t) ? now.slice(sent.length) : now
    if (rest.length > 0) pending.set(localId, rest)
    else pending.delete(localId)
  }

  type ForkRow = { local_id: string; claude_session_id: string | null; fork_source: string }

  /**
   * Cópia recusada: revive em conversa nova, manda o pacote do original até o
   * corte e, se a recusa levou mensagens do operador, reenvia-as depois dele.
   * O `fork_source` já saiu do banco: roda uma vez por sessão. Com o desfazer
   * segurando o terminal, os dois esperam a soltura; o que não sai vai ao chat
   * do ramo (ver deliver.ts).
   *
   * As mensagens do operador vieram do `onOperatorMessage`: a sessão já as
   * tinha aceitado (digitadas, ou tiradas da fila dele, que já as apagou), e
   * só existem aqui, na memória. Se o revive falha, a entrega segue assim
   * mesmo: com o ramo de pé (o operador o reviveu nesse meio-tempo) elas saem;
   * fora do ar, voltam à fila gravada do operador (pausada, à vista,
   * sobrevivem ao reinício), e o pacote vai ao chat do ramo. O pacote que não
   * pôde ser montado também avisa no chat, com o motivo.
   * `engine` é o motor do terminal do ramo (a trava e a capacidade de mensagem
   * no meio do turno são dele); o `src.engine` só lê a conversa de origem.
   */
  const recover = async (localId: string, projectId: number, engine: string, projectPath: string, src: ForkSource, texts: string[]): Promise<void> => {
    // Chamado de dentro do handler de status da sessão morta, que ainda vai
    // tirá-la do `live` (e avisar o fim dela). Um revive síncrono aqui poria a
    // sessão nova no `live` antes desse `delete`, que a apagaria: o ramo ficaria
    // rodando fora do manager. Só segue no passo seguinte do laço, com o
    // handler já encerrado (o OpenCode com `seed` não tem outro `await` antes).
    await new Promise<void>((resolve) => setImmediate(resolve))
    // O pacote guardado no `/fork` (OpenCode) é a cópia à risca até o comando;
    // refazê-lo agora, sem corte, traria o turno em curso e o que veio depois.
    let packError: string | null = null
    const pack = src.seed ? { text: src.seed } : await collect(getEngine(src.engine), projectPath, src.sourceId, {
      working: false, ...(src.previewBefore !== null ? { before: src.previewBefore } : {}),
    }).catch((err) => {
      console.error('[ramo] pacote da cópia recusada falhou', err)
      packError = err instanceof Error ? err.message : String(err)
      return null
    })
    try {
      deps.manager.revive(localId)
    } catch (err) {
      // O operador já reviveu (ou parou) o ramo nesse meio-tempo: não insiste
      // no revive, mas não descarta nada (a entrega decide pelo estado da sessão).
      console.error('[ramo] não reviveu a cópia recusada', err)
    }
    if (packError !== null) {
      delivery.notice(localId, `A cópia da conversa original não foi feita e o contexto dela não pôde ser montado (${packError}). O ramo seguiu numa conversa nova, sem esse contexto.`)
    }
    deliver(localId, projectId, engine, [
      ...(pack ? [{ text: pack.text, as: 'claudinei' as const }] : []),
      ...texts.map((text) => ({ text, as: 'operator' as const })),
    ])
  }

  return {
    side,
    fork: (req) => forkTerminal({ db: deps.db, manager: deps.manager, rewinding: deps.rewinding, deliver, cutFor: deps.side?.cutFor, collect: deps.side?.collect }, req),

    async switchEngine(req) {
      const key = `${req.projectId}:${req.to}`
      if (switching.has(key)) throw new UserError('handoff_target_busy', 'O motor de destino já está recebendo outra conversa')
      switching.add(key)
      try {
        return await switchEngine({
          db: deps.db, manager: deps.manager, store: deps.store, restart: deps.restart,
          rewinding: deps.rewinding, holds: deps.holds, deliver, collect: deps.side?.collect,
        }, req)
      } finally {
        switching.delete(key)
      }
    },

    onOperatorMessage(_projectId, _engine, info) {
      if (!info.localId || typeof info.text !== 'string') return
      const row = deps.db.prepare('SELECT fork_source FROM sessions WHERE local_id=?').get(info.localId) as { fork_source?: string | null } | undefined
      if (!row?.fork_source) return
      pending.set(info.localId, [...(pending.get(info.localId) ?? []), info.text])
    },

    onTurnResult(projectId, engine) {
      const rows = deps.db.prepare(
        'SELECT local_id, claude_session_id, fork_source FROM sessions WHERE project_id=? AND engine=? AND fork_source IS NOT NULL',
      ).all(projectId, engine) as ForkRow[]
      if (rows.length === 0) return
      const path = projects.get(projectId)?.path
      for (const r of rows) {
        // A cópia gravada encerra o `fork_source`: o revive daqui em diante
        // retoma o ramo, em vez de copiar de novo por cima do que ele andou.
        if (path && forkCopyDone(getEngine(engine), path, r.claude_session_id)) {
          deps.db.prepare('UPDATE sessions SET fork_source=NULL WHERE local_id=?').run(r.local_id)
          pending.delete(r.local_id)
          continue
        }
        // Sem a cópia, o turno acabou mas as mensagens dele só saem no passo
        // seguinte do laço: a cópia recusada do Codex e do OpenCode emite o
        // result de erro e, no mesmo passo síncrono, morre. O `onSessionDied`
        // que vem logo depois ainda as encontra; numa sessão que sobrevive ao
        // erro (o pacote grande do OpenCode), elas não voltam numa morte futura.
        const ended = pending.get(r.local_id)
        if (ended) setImmediate(() => dropSent(r.local_id, ended))
      }
    },

    onSessionDied(projectId, engine) {
      // Chamado de dentro do handler de status, com a linha já `dead`.
      const r = deps.db.prepare(
        `SELECT local_id, claude_session_id, fork_source FROM sessions
          WHERE project_id=? AND engine=? AND status='dead' AND fork_source IS NOT NULL
          ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      ).get(projectId, engine) as ForkRow | undefined
      if (!r) return
      // Os textos saem aqui, no passo do handler: o `recover` só roda depois, e
      // o `dropSent` agendado pelo `onTurnResult` já não os encontra.
      const texts = pending.get(r.local_id) ?? []
      pending.delete(r.local_id)
      const path = projects.get(projectId)?.path
      const src = parseForkSource(r.fork_source)
      if (!path || !src || forkCopyDone(getEngine(engine), path, r.claude_session_id)) {
        // Morte comum (a cópia já existe) ou fonte ilegível: nada a refazer.
        deps.db.prepare('UPDATE sessions SET fork_source=NULL WHERE local_id=?').run(r.local_id)
        return
      }
      // O id escolhido nunca virou conversa: sai junto, e o revive abre uma nova.
      deps.db.prepare('UPDATE sessions SET fork_source=NULL, claude_session_id=NULL WHERE local_id=?').run(r.local_id)
      // Sai também da posse do terminal: na pasta compartilhada o revive procura
      // "a conversa própria" ali, e o Codex não confere existência; o id do
      // `thread/fork` sem rollout viraria `resume` de um thread fantasma.
      if (r.claude_session_id) {
        deps.db.prepare('DELETE FROM project_threads WHERE project_id=? AND engine=? AND thread_id=?').run(projectId, engine, r.claude_session_id)
      }
      // Assíncrono de propósito: o handler de status ainda vai tirar a sessão
      // morta do `live`, e o revive tem de vir depois disso (o `recover` adia
      // para o passo seguinte do laço antes de tudo).
      void recover(r.local_id, projectId, engine, path, src, texts).catch((err) => console.error('[ramo] cópia recusada', err))
    },

    onSessionEnded(projectId, engine, localId) {
      side.onSessionEnded(projectId, engine)
      if (localId) delivery.ended(localId)
    },
    nextSendProvider: delivery.provider,
    bootCleanup: () => side.bootCleanup(),
    dispose: () => { delivery.dispose(); return side.dispose() },
  }
}
