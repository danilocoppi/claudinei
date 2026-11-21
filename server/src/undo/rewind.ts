import type { SessionInfo, SessionManager } from '../claude/manager.js'
import type { createRepoResolver } from '../checkpoint/repo.js'
import type { NextSend } from '../queue/next-send.js'
import { UserError } from '../user-error.js'
import { errText } from './scope.js'
import type { UndoService } from './service.js'
import type { TurnRow, UndoStore } from './store.js'
import type { UndoCtx } from './types.js'
import {
  CONVERSATION_REWOUND_NOTE, turnKey, withNote, type Availability, type RestoreAction, type RewindMode,
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
  /** Quanto esperar o turno interrompido terminar. Padrão: 15 s. */
  waitFreeMs?: number
  log?(m: string): void
}

const MODES = new Set<RewindMode>(['conversation', 'conversation_and_files'])
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
  /** Claude: o id novo só chega ao banco no primeiro result; os turnos que ficam ganham o rótulo no fim do primeiro turno da conversa nova. */
  const pendingLabel = new Map<string, { newId: string; kept: number[] }>()

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

  /** O turno gravado da mensagem: o `turnId` pedido, ou a `occurrence`-ésima com a chave, de trás para frente. */
  function targetTurn(info: SessionInfo, current: TurnRow[], target: RewindTarget, key: string): TurnRow | undefined {
    if (target.turnId !== undefined) {
      const row = store.turn(target.turnId)
      if (!row || row.projectId !== info.projectId || row.engine !== info.engine) {
        throw new UserError('undo_turn_not_found', `turno ${target.turnId} não encontrado`, { id: target.turnId })
      }
      if (!current.some(t => t.id === row.id)) throw new UserError('rewind_turn_outside', 'esta mensagem já não está na conversa atual')
      return row
    }
    return current.filter(t => t.textKey === key).reverse()[target.occurrence]
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
    const key = turnKey(target.text)
    const current = currentTurns(info)
    const turn = targetTurn(info, current, target, key)
    const range = turn ? current.filter(t => t.id >= turn.id) : current
    const kept = turn ? current.filter(t => t.id < turn.id) : []
    const filesTouched = range.some(t => t.declared.length > 0 || (!!t.summary && t.summary.files + t.summary.outside > 0))
    const plan: Plan = {
      info, projectPath: project.path, key, adapter: deps.adapters[info.engine], turn, range, kept, cut: null,
      conversation: ON, files: ON, filesTouched, working: info.status === 'working',
    }
    const both = (a: Availability): Plan => ({ ...plan, conversation: a, files: a })

    if (!plan.adapter) return both(off('engine_unsupported', { engine: info.engine }))
    // Mensagem que entrou no meio do turno: o Codex só corta turnos inteiros, e
    // no Claude o corte ali não foi ensaiado (R20).
    if (turn?.midTurn) return both(off(info.engine === 'codex' ? 'codex_mid_turn' : 'claude_mid_turn'))
    let cut: ConversationCut | null = null
    try {
      cut = await plan.adapter.locate({ localId, projectPath: project.path, engineSessionId: info.engineSessionId, turn }, key, target.occurrence)
    } catch (e) {
      // Conversa ocupada sem âncora, transcript ilegível: a tela mostra o motivo, nunca 500.
      log(`achar a mensagem em ${localId}: ${errText(e)}`)
    }
    if (!cut) return both(off(info.engineSessionId ? 'anchor_not_found' : 'no_session'))
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
          return { conversationRewound: false, ...(run ? { run } : {}), error: errorOf(e) }
        }

        // 5. Os turnos do trecho saem da conversa atual (continuam desfazíveis).
        store.markRewound(rangeIds)
        const keptIds = plan.kept.map(t => t.id)
        pendingLabel.delete(localId)
        if (applied.newConversationId) {
          // Codex (fork): o terminal já está no id novo. Claude: só depois do primeiro result.
          if (plan.info.engine === 'claude') pendingLabel.set(localId, { newId: applied.newConversationId, kept: keptIds })
          else if (keptIds.length) store.setConversation(keptIds, applied.newConversationId)
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
     * Claude: o primeiro turno da conversa nova fechou com o id dela já no
     * banco. Os turnos que ficaram antes da mensagem ganham o id novo e
     * continuam na conversa atual.
     */
    onTurnClosed(turnId: number): void {
      if (!pendingLabel.size) return
      try {
        const t = store.turn(turnId)
        const label = t && pendingLabel.get(t.localId)
        if (!t || !label || t.conversationId !== label.newId) return
        // O processo pode ter morrido antes do result: o banco segue no id antigo.
        if (manager.get(t.localId)?.engineSessionId !== label.newId) return
        pendingLabel.delete(t.localId)
        if (label.kept.length) store.setConversation(label.kept, label.newId)
      } catch (e) {
        log(`rótulo da conversa nova (turno ${turnId}): ${errText(e)}`)
      }
    },
  }
}

export type RewindService = ReturnType<typeof createRewindService>
