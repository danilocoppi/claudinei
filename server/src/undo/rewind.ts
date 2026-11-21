import type { SessionInfo, SessionManager } from '../claude/manager.js'
import type { createRepoResolver } from '../checkpoint/repo.js'
import type { NextSend } from '../queue/next-send.js'
import { UserError } from '../user-error.js'
import { errText } from './scope.js'
import type { UndoService } from './service.js'
import type { TurnRow, UndoStore } from './store.js'
import type { UndoCtx } from './types.js'
import {
  CONVERSATION_REWOUND_NOTE, turnKey, withNote, type Availability, type RestoreAction, type RestoreResult, type RewindMode,
  type RewindOptionsDto, type RewindReason, type RewindResultDto, type RewindTarget, type UndoRunDto, type ViewerFull,
} from '../../../shared/undo.js'

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

// ── Editar a partir daqui: o serviço ──

/** Os turnos que contam como "da conversa atual" (R2) e o trecho que a volta leva. */
interface Plan {
  info: SessionInfo
  projectPath: string
  key: string
  adapter: RewindAdapter | undefined
  /** O turno gravado da mensagem; ausente numa mensagem anterior ao recurso. */
  turn: TurnRow | undefined
  /** O turno do alvo e todos os seguintes da conversa atual, por id. Sem turno gravado: todos. */
  range: TurnRow[]
  /** Os anteriores ao alvo na conversa atual: ficam na conversa. */
  kept: TurnRow[]
  cut: ConversationCut | null
  conversation: Availability
  files: Availability
  filesTouched: boolean
  working: boolean
}

export interface RewindDeps {
  manager: Pick<SessionManager, 'get' | 'interrupt' | 'send'>
  store: UndoStore
  undo: Pick<UndoService, 'preview' | 'apply'>
  /** Por motor: `{ claude, codex }`. Motor sem adaptador não volta a conversa. */
  adapters: Record<string, RewindAdapter>
  projects: { get(id: number): { id: number; name: string; path: string } | undefined }
  /** A pasta tem git (sem git, a volta dos arquivos fica desligada com `no_git`). */
  resolver: Pick<ReturnType<typeof createRepoResolver>, 'get'>
  nextSend: () => Pick<NextSend, 'poke'> | undefined
  /**
   * O ramo (`/fork`) ainda sem a cópia própria (`pending`), e o fim do
   * `fork_source` depois de uma volta da conversa (`settled`). Ausente: nenhum
   * terminal é ramo pendente.
   */
  fork?: {
    pending(info: SessionInfo, projectPath: string): boolean
    settled(localId: string): void
  }
  /** Quanto esperar o turno interrompido terminar. Padrão: 15 s. */
  waitFreeMs?: number
  log?(m: string): void
}

const MODES = new Set<RewindMode>(['conversation', 'conversation_and_files'])
/** Os resultados em que o arquivo foi escrito no disco (como no serviço do desfazer). */
const WRITTEN = new Set<RestoreResult>(['reverted', 'merged', 'forced'])
const off = (reason: RewindReason, params?: Record<string, string>): Availability =>
  ({ enabled: false, reason, ...(params ? { params } : {}) })
const ON: Availability = { enabled: true }
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))
const termKey = (projectId: number, engine: string) => `${projectId}\0${engine}`

/** O motivo de um turno do trecho não servir para a volta dos arquivos; null se serve (ou ainda corre). */
function snapshotProblem(t: TurnRow): RewindReason | null {
  if (t.snapshot === 'lost') return 'snapshot_lost'
  if (t.snapshot === 'late') return 'snapshot_late'
  if (t.snapshot === 'ok') return null
  // Retrato ainda a caminho num turno que corre: decide-se quando ele terminar.
  if (t.snapshot === 'pending' && t.endedAt === null) return null
  return 'no_snapshot'
}

/**
 * "Editar a partir daqui" (spec): volta a conversa do motor até antes da
 * mensagem e, se pedido, os arquivos dos turnos dela até o último, e manda o
 * texto editado como mensagem do operador.
 *
 * Enquanto a volta roda, o terminal fica segurado: `holds` para o árbitro do
 * próximo envio, o agendador e as tarefas e perguntas de outros agentes, e
 * `holdInput` (no rastreador, por onde passa todo envio) recusa qualquer outra
 * mensagem ao terminal com `rewind_in_progress`, menos o envio da própria volta.
 */
export function createRewindService(deps: RewindDeps) {
  const { manager, store } = deps
  const log = deps.log ?? ((m: string) => console.error(`[undo] ${m}`))
  const waitFreeMs = deps.waitFreeMs ?? 15_000
  /** Terminal (projeto + motor) em volta → o localId dela. */
  const rewinding = new Map<string, string>()
  /** O envio da própria volta passa pelo holdInput: o localId dele, só durante o `send`. */
  let ownSend: string | null = null
  /**
   * Claude: o id novo só chega ao banco no primeiro result. O trecho sai da
   * conversa atual (markRewound) e os turnos que ficam ganham o rótulo no fim
   * do primeiro turno da conversa nova, se ele confirmar o id; se o processo
   * morrer antes (ou o CLI recusar o corte), nada muda no banco.
   * `newId` null: voltou à primeira mensagem (conversa nova, id ainda
   * desconhecido). `after`: o maior id de turno do terminal na hora da volta.
   * `written`: os caminhos que a volta escreveu nos arquivos (sem nota, porque
   * iriam com a conversa voltada); se o pendente cair, viram a nota "files reverted".
   */
  interface Pending {
    newId: string | null; oldId: string | null; range: number[]; kept: number[]; after: number
    projectId: number; engine: string; written: string[]
  }
  const pendingLabel = new Map<string, Pending>()

  /** Todos os caminhos escritos pelo run (o gravado, não o filtrado para quem não é administrador). */
  function writtenPaths(run: UndoRunDto | undefined): string[] {
    if (!run) return []
    return (store.run(run.id)?.files ?? run.files).filter(f => WRITTEN.has(f.result)).map(f => f.path)
  }

  /**
   * A volta pendente não aconteceu (o processo morreu antes do result, o CLI
   * recusou o corte, outra volta passou por cima): a conversa ficou, então os
   * arquivos que ela desfez viram a nota "files reverted" da próxima mensagem.
   */
  function dropPending(localId: string, label: Pending): void {
    pendingLabel.delete(localId)
    if (!label.written.length) return
    try {
      store.addNote(label.projectId, label.engine, label.written)
    } catch (e) {
      log(`nota dos arquivos desfeitos em ${localId}: ${errText(e)}`)
    }
  }

  function sessionOf(localId: string): SessionInfo {
    const info = manager.get(localId)
    if (!info) throw new UserError('session_not_found', 'sessão não existe')
    return info
  }

  /** Os turnos da conversa atual do terminal (R2), por id. */
  function currentTurns(info: SessionInfo): TurnRow[] {
    return store.terminalTurns(info.projectId, info.engine).filter(t =>
      t.origin !== 'interactive' && t.rewoundAt === null && (t.conversationId === null || t.conversationId === info.engineSessionId))
  }

  function checkTarget(target: unknown): RewindTarget {
    const t = target as Partial<RewindTarget> | null | undefined
    const ok = !!t && typeof t.text === 'string' && turnKey(t.text) !== ''
      && Number.isSafeInteger(t.occurrence) && t.occurrence! >= 0
      && (t.turnId === undefined || (Number.isSafeInteger(t.turnId) && t.turnId > 0))
    if (!ok) throw new UserError('rewind_bad_request', 'mensagem a editar inválida (target)')
    return { text: t!.text!, occurrence: t!.occurrence!, ...(t!.turnId !== undefined ? { turnId: t!.turnId } : {}) }
  }

  /**
   * A mensagem a achar no motor: o turno gravado, a chave e a ocorrência (de
   * trás para frente, 0 = a última).
   *
   * Com `turnId` (R22), a chave é a `text_key` do turno e a ocorrência conta
   * os turnos da conversa atual depois dele com a mesma chave; o texto e a
   * ocorrência da web são ignorados. O rastreador grava todo envio como turno,
   * inclusive a mensagem enfileirada no meio do turno do Claude, que o CLI
   * guarda como `queued_command` e o `findClaudeCut` conta; a web não a vê
   * depois de recarregar e contaria uma a menos, cortando a mensagem errada.
   * Turno sem chave (aberto pelo motor) não tem texto a achar: fica com a da web.
   *
   * Sem `turnId` (mensagem anterior ao recurso): a chave do texto e a
   * ocorrência da web; o turno é o `occurrence`-ésimo com a chave, se houver.
   */
  function targetOf(info: SessionInfo, current: TurnRow[], target: RewindTarget): { turn: TurnRow | undefined; key: string; occurrence: number } {
    if (target.turnId !== undefined) {
      const row = store.turn(target.turnId)
      if (!row || row.projectId !== info.projectId || row.engine !== info.engine) {
        throw new UserError('undo_turn_not_found', `turno ${target.turnId} não encontrado`, { id: target.turnId })
      }
      if (!current.some(t => t.id === row.id)) throw new UserError('rewind_turn_outside', 'esta mensagem já não está na conversa atual')
      if (!row.textKey) return { turn: row, key: turnKey(target.text), occurrence: target.occurrence }
      const occurrence = current.filter(t => t.id > row.id && t.textKey === row.textKey).length
      return { turn: row, key: row.textKey, occurrence }
    }
    const key = turnKey(target.text)
    return { turn: current.filter(t => t.textKey === key).reverse()[target.occurrence], key, occurrence: target.occurrence }
  }

  async function hasGit(path: string): Promise<boolean> {
    try {
      return !!(await deps.resolver.get(path))
    } catch {
      return false
    }
  }

  async function planOf(localId: string, target: RewindTarget): Promise<Plan> {
    const info = sessionOf(localId)
    const project = deps.projects.get(info.projectId)
    if (!project) throw new UserError('session_project_gone', 'projeto da sessão não existe mais')
    const current = currentTurns(info)
    const { turn, key, occurrence } = targetOf(info, current, target)
    const range = turn ? current.filter(t => t.id >= turn.id) : current
    const kept = turn ? current.filter(t => t.id < turn.id) : []
    const filesTouched = range.some(t => t.declared.length > 0 || (!!t.summary && t.summary.files + t.summary.outside > 0))
    const plan: Plan = {
      info, projectPath: project.path, key, adapter: deps.adapters[info.engine], turn, range, kept, cut: null,
      conversation: ON, files: ON, filesTouched, working: info.status === 'working',
    }
    const both = (a: Availability): Plan => ({ ...plan, conversation: a, files: a })

    if (!plan.adapter) return both(off('engine_unsupported', { engine: info.engine }))
    // Aberta no terminal interativo, a sessão não pode ser relançada nem mexida.
    if (info.status === 'in_terminal') return both(off('in_terminal'))
    // Mensagem que entrou no meio do turno: o Codex só corta turnos inteiros, e
    // no Claude o corte ali não foi ensaiado (R20).
    if (turn?.midTurn) return both(off(info.engine === 'codex' ? 'codex_mid_turn' : 'claude_mid_turn'))
    // R23: no Claude, o que se digitou no terminal interativo depois da mensagem
    // não virou turno; a ocorrência do R22 sairia curta e o corte cairia na
    // mensagem errada.
    if (turn && info.engine === 'claude'
      && store.terminalTurns(info.projectId, info.engine).some(t => t.origin === 'interactive' && t.id > turn.id)) {
      return both(off('anchor_not_found'))
    }
    let cut: ConversationCut | null = null
    try {
      cut = await plan.adapter.locate({ localId, projectPath: project.path, engineSessionId: info.engineSessionId, turn }, key, occurrence)
    } catch (e) {
      // Conversa ocupada sem âncora, transcript ilegível: a tela mostra o motivo, nunca 500.
      log(`achar a mensagem em ${localId}: ${errText(e)}`)
    }
    if (!cut) {
      // Ramo do Claude antes do primeiro turno: a prévia mostra as mensagens da
      // origem, e a conversa do ramo ainda não existe para achá-las.
      let pending = false
      try {
        pending = deps.fork?.pending(info, project.path) ?? false
      } catch (e) {
        log(`ramo pendente em ${localId}: ${errText(e)}`)
      }
      if (pending) return both(off('fork_pending'))
      return both(off(info.engineSessionId ? 'anchor_not_found' : 'no_session'))
    }
    if (cut.kind === 'codex' && cut.midTurn) return both(off('codex_mid_turn'))
    plan.cut = cut

    if (!(await hasGit(project.path))) return { ...plan, files: off('no_git') }
    if (!turn) return { ...plan, files: off('no_snapshot') }
    for (const t of range) {
      const problem = snapshotProblem(t)
      if (problem) return { ...plan, files: off(problem, { turnId: String(t.id) }) }
    }
    return plan
  }

  function requireMode(plan: Plan, mode: RewindMode): void {
    const a = mode === 'conversation' ? plan.conversation : plan.files
    if (!a.enabled || !plan.conversation.enabled) {
      const reason = (plan.conversation.enabled ? a : plan.conversation).reason ?? 'no_session'
      throw new UserError('rewind_unavailable', 'não dá para voltar a conversa a partir desta mensagem', { reason })
    }
  }

  /**
   * Espera o terminal ficar livre e os turnos dele fecharem (o marco de fim
   * sai pela fila do git). Passou do prazo: `rewind_turn_stuck`.
   */
  async function settle(localId: string, projectId: number, engine: string): Promise<void> {
    const deadline = Date.now() + waitFreeMs
    const busy = () => manager.get(localId)?.status === 'working'
      || store.terminalTurns(projectId, engine).some(t => t.localId === localId && t.endedAt === null && t.origin !== 'interactive')
    while (busy()) {
      if (Date.now() >= deadline) throw new UserError('rewind_turn_stuck', 'o turno do agente não terminou a tempo; tente de novo')
      await sleep(25)
    }
  }

  /** O resumo dos turnos terminados chega logo depois do fim (git): espera um pouco, sem falhar, para a nota sair certa. */
  async function awaitSummaries(plan: Plan): Promise<void> {
    const deadline = Date.now() + Math.min(2_000, waitFreeMs)
    const missing = () => plan.range.some(t => {
      const row = store.turn(t.id)
      return !!row && row.summary === null && row.declared.length === 0 && (row.snapshot === 'ok' || row.snapshot === 'late')
    })
    while (missing() && Date.now() < deadline) await sleep(25)
  }

  const errorOf = (e: unknown) => ({ code: e instanceof UserError ? e.code : 'rewind_failed', message: errText(e) })

  return {
    async options(localId: string, target: RewindTarget, viewer: ViewerFull): Promise<RewindOptionsDto> {
      const plan = await planOf(localId, checkTarget(target))
      const files: RewindOptionsDto['files'] = { ...plan.files }
      // A prévia só com os turnos do trecho terminados; senão, ela vem no 409 do rewind.
      if (files.enabled && plan.range.every(t => t.endedAt !== null)) {
        try {
          files.preview = await deps.undo.preview(plan.range.map(t => t.id), viewer)
        } catch (e) {
          if (!(e instanceof UserError)) log(`prévia da volta em ${localId}: ${errText(e)}`)
          const code = e instanceof UserError ? e.code : 'error'
          return {
            engine: plan.info.engine, conversation: plan.conversation,
            files: off(code === 'snapshot_lost' ? 'snapshot_lost' : 'no_snapshot', { code }),
            filesTouched: plan.filesTouched, working: plan.working,
          }
        }
      }
      return { engine: plan.info.engine, conversation: plan.conversation, files, filesTouched: plan.filesTouched, working: plan.working }
    },

    async execute(
      localId: string,
      req: { target: RewindTarget; mode: RewindMode; editedText: string; token?: string; decisions?: Record<string, RestoreAction> },
      viewer: ViewerFull,
    ): Promise<RewindResultDto> {
      const target = checkTarget(req?.target)
      const mode = req.mode
      if (!MODES.has(mode)) throw new UserError('rewind_bad_request', 'modo de volta inválido')
      if (typeof req.editedText !== 'string' || !req.editedText.trim()) throw new UserError('rewind_bad_request', 'o texto editado está vazio')
      const first = sessionOf(localId)
      const term = termKey(first.projectId, first.engine)
      if (rewinding.has(term)) throw new UserError('rewind_busy', 'este terminal já está voltando a conversa')
      // 1. O terminal fica segurado até o fim (o árbitro e os outros envios esperam).
      rewinding.set(term, localId)
      try {
        // Recusa antes de interromper: a opção pedida tem de estar ligada.
        let plan = await planOf(localId, target)
        requireMode(plan, mode)
        // 2. Com o agente trabalhando: interrompe e espera o turno fechar.
        if (plan.working) await manager.interrupt(localId)
        await settle(localId, first.projectId, first.engine)
        plan = await planOf(localId, target)
        requireMode(plan, mode)
        const rangeIds = plan.range.map(t => t.id)

        // 3. Arquivos primeiro; recusa (prévia velha, bloqueio) para aqui, sem tocar na conversa.
        let run: UndoRunDto | undefined
        if (mode === 'conversation_and_files') {
          run = await deps.undo.apply(rangeIds, { token: req.token ?? '', decisions: req.decisions ?? {} }, viewer, { note: false })
        } else {
          await awaitSummaries(plan)
          plan = { ...plan, filesTouched: plan.range.some(t => {
            const row = store.turn(t.id) ?? t
            return row.declared.length > 0 || (!!row.summary && row.summary.files + row.summary.outside > 0)
          }) }
        }

        // 4. A conversa. Falhou: os arquivos desfeitos ficam desfeitos, nada é enviado.
        let applied: { newConversationId?: string }
        try {
          applied = await plan.adapter!.apply({ localId, projectPath: plan.projectPath, engineSessionId: plan.info.engineSessionId }, plan.cut!)
        } catch (e) {
          log(`voltar a conversa de ${localId}: ${errText(e)}`)
          // Os arquivos voltaram sem nota (ela viria com a conversa voltada); a
          // conversa ficou, então o agente precisa saber: a nota "files reverted"
          // espera a próxima mensagem, com todos os caminhos escritos (o run
          // gravado, não o filtrado para quem não é administrador).
          if (run) {
            try {
              const files = writtenPaths(run)
              if (files.length) store.addNote(first.projectId, first.engine, files)
            } catch (err) {
              log(`nota dos arquivos desfeitos em ${localId}: ${errText(err)}`)
            }
          }
          return { conversationRewound: false, ...(run ? { run } : {}), error: errorOf(e) }
        }

        // A conversa voltou: o ramo ainda com `fork_source` (o Codex copia no
        // `thread/fork` da subida, antes do primeiro turno) já não pode ser
        // refeito da origem, ou o revive desfaria a volta.
        try {
          deps.fork?.settled(localId)
        } catch (e) {
          log(`fim do fork_source de ${localId}: ${errText(e)}`)
        }

        // 5. Os turnos do trecho saem da conversa atual (continuam desfazíveis).
        // Codex: o revert/fork já foi confirmado pelo RPC, o terminal está no id
        // novo. Claude: só quando o primeiro turno da conversa nova fechar com o id dela.
        const keptIds = plan.kept.map(t => t.id)
        const previous = pendingLabel.get(localId)
        if (previous) dropPending(localId, previous)
        if (plan.info.engine === 'claude') {
          const after = store.terminalTurns(first.projectId, first.engine).reduce((m, t) => Math.max(m, t.id), 0)
          let written: string[] = []
          try { written = writtenPaths(run) } catch (e) { log(`caminhos desfeitos em ${localId}: ${errText(e)}`) }
          pendingLabel.set(localId, {
            newId: applied.newConversationId ?? null, oldId: plan.info.engineSessionId, range: rangeIds, kept: keptIds, after,
            projectId: first.projectId, engine: first.engine, written,
          })
        } else {
          store.markRewound(rangeIds)
          if (applied.newConversationId && keptIds.length) store.setConversation(keptIds, applied.newConversationId)
        }

        // 6. O texto editado sai como mensagem do operador (pausa o goal; passa pelo rastreador).
        const text = mode === 'conversation' && plan.filesTouched ? withNote(CONVERSATION_REWOUND_NOTE, req.editedText) : req.editedText
        ownSend = localId
        try {
          manager.send(localId, text, { echo: true })
        } catch (e) {
          log(`mandar o texto editado a ${localId}: ${errText(e)}`)
          return { conversationRewound: true, ...(run ? { run } : {}), error: errorOf(e) }
        } finally {
          ownSend = null
        }
        return { conversationRewound: true, ...(run ? { run } : {}) }
      } finally {
        // 7. Solta o terminal e cutuca o árbitro (a fila do operador segue de onde estava).
        rewinding.delete(term)
        try { deps.nextSend()?.poke(first.projectId, first.engine) } catch (e) { log(`cutucar ${localId}: ${errText(e)}`) }
      }
    },

    /** Para o árbitro, o agendador e as tarefas de outros agentes: o terminal está voltando a conversa. */
    holds(projectId: number, engine: string): boolean {
      return rewinding.has(termKey(projectId, engine))
    },

    /** Para o rastreador: durante a volta, só o envio da própria volta chega ao terminal. */
    holdInput(ctx: UndoCtx): void {
      if (rewinding.has(termKey(ctx.projectId, ctx.engine)) && ownSend !== ctx.localId) {
        throw new UserError('rewind_in_progress', 'o Claudinei está voltando a conversa deste terminal; tente de novo em alguns segundos')
      }
    },

    /**
     * Claude: o primeiro turno da conversa nova fechou. Com o id novo já no
     * banco, o trecho sai da conversa atual e os turnos que ficaram antes da
     * mensagem ganham o id novo. Sem ele (o processo morreu antes do result,
     * o CLI recusou o corte), a volta não aconteceu: o pendente é descartado, e
     * os arquivos que ela desfez viram a nota "files reverted".
     */
    onTurnClosed(turnId: number): void {
      if (!pendingLabel.size) return
      try {
        const t = store.turn(turnId)
        const label = t && pendingLabel.get(t.localId)
        if (!t || !label || t.id <= label.after || t.origin === 'interactive') return
        const now = manager.get(t.localId)?.engineSessionId ?? null
        const confirmed = now !== null && now !== label.oldId && (label.newId === null || now === label.newId)
          && t.conversationId === now
        if (!confirmed) {
          log(`a conversa nova de ${t.localId} não confirmou (turno ${turnId}): o trecho fica na conversa atual`)
          dropPending(t.localId, label)
          return
        }
        pendingLabel.delete(t.localId)
        store.markRewound(label.range)
        if (label.kept.length) store.setConversation(label.kept, now)
      } catch (e) {
        log(`rótulo da conversa nova (turno ${turnId}): ${errText(e)}`)
      }
    },
  }
}

export type RewindService = ReturnType<typeof createRewindService>
