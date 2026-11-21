import type { BackgroundTask } from '../../../shared/background-tasks.js'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import type { SessionStatus, PermissionMode, PendingQuestion } from './session.js'
import type { ClaudeEvent } from './events.js'
import { getEngine, DEFAULT_ENGINE_ID, type EngineId, type EngineSession, type EngineSessionOptions } from '../engine/index.js'
import { userEchoEvent } from '../engine/echo.js'
import { contextWindowFor, windowFromModelUsage, DEFAULT_CONTEXT_WINDOW } from './context-window.js'
import { recordThread, foreignThreadIds, ownLatestThread, isSharedPath } from '../project-threads.js'
import { UserError } from '../user-error.js'
import { createHeadsUp, type HeadsUpNode, type HeadsUpPress, type HeadsUpSurface } from './heads-up.js'
import { RESTART_FAIL_TEXT, type LimitOrigin } from '../restart/terminal-state.js'
import type { SlotContext } from '../queue/operator-queue.js'
import { usageLimitFailText } from '../limit/texts.js'
import { forkPlanOf, parseForkSource, type ForkSource } from '../branch/fork-source.js'
import type { TurnObserver, InputOrigin } from '../undo/types.js'

/** A sessão sabe ser uma superfície remota (só a do Claude). */
const isHeadsUpSurface = (s: unknown): s is HeadsUpSurface =>
  !!s && typeof (s as HeadsUpSurface).uiAttach === 'function' && typeof (s as HeadsUpSurface).uiRender === 'function'

export interface SessionInfo {
  localId: string
  projectId: number
  engine: EngineId
  status: SessionStatus
  engineSessionId: string | null
  updatedAt: string
  model: string | null
  permissionMode: PermissionMode
  /** Effort persistido (low..max) ou null = padrão (auto). */
  effort: string | null
  /**
   * Tarefas despachadas com run_in_background que ainda rodam. Vem da sessão
   * VIVA (não do banco): é estado do processo, não persistido. Ausente/vazio =
   * nada em background.
   */
  backgroundTasks?: BackgroundTask[]
  /** Credencial do Claude expirada: a UI mostra "reautenticar" no lugar do erro cru. */
  authExpired?: boolean
  /** Tamanho do contexto (tokens) do último result da sessão VIVA. Só memória: restaurado pela engine ao retomar ou no próximo turno. */
  contextTokens?: number
  /** Janela de contexto (tokens) do modelo que a sessão viva está rodando — o denominador do medidor. */
  contextWindow?: number
  /** Pergunta (AskUserQuestion) esperando o operador — só sessão VIVA, só memória. Ausente = nenhuma. */
  pendingQuestion?: PendingQuestion
  /** Compactação de contexto em curso: epoch ms do início — só sessão VIVA, só memória. Ausente = não está compactando. */
  compactingSince?: number
  /** Aviso do plugin "You should know" desenhado agora (árvore do plugin) — só sessão VIVA do Claude. Ausente = nenhum. */
  headsUp?: HeadsUpNode
}

export interface TerminalLauncherOpts {
  localId: string
  cwd: string
  file: string
  args: string[]
  /** Mesclado ao ambiente do PTY (ex.: KIMI_CODE_HOME do projeto). */
  env?: Record<string, string>
  onExit: () => void
  onActivity?: (activity: 'working' | 'waiting' | 'idle') => void
}

interface Deps {
  db: Db
  // Sintaxe de método (não arrow-property): checagem bivariante do parâmetro
  // permite que os testes injetem `(opts: SessionOptions) => ClaudeSession`
  // (mais estrito que EngineSessionOptions/EngineSession) sem cast — o
  // arrow-property seria checado contravariantemente e rejeitaria essa
  // injeção mesmo sendo seguro em runtime (ClaudeSession implements EngineSession).
  sessionFactory?(opts: EngineSessionOptions): EngineSession
  broadcast: (msg: object) => void
  /** Injetável: lança o Claude interativo num PTY e retorna o token do canal. Obrigatório para openInTerminal. */
  terminalLauncher?: (opts: TerminalLauncherOpts) => string
  /** Se presente, toda sessão criada recebe o MCP hermes (agente↔agente + mural) via --mcp-config. */
  hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string; serviceTokenFile?: string }
  /** Chamado quando um evento init traz a lista de slash commands (para persistir). */
  onSlashCommands?: (cmds: string[]) => void
  /** Quantas sessões terminais (dead/stopped) manter por projeto no prune de arranque (default 5). */
  keepSessionsPerProject?: number
  /**
   * Chamado (via microtask, nunca inline) quando uma sessão do projeto vira
   * 'idle' ou 'needs_attention' — sinal de que o alvo está livre para receber
   * a próxima tarefa da fila. O adiamento evita reentrância: se disparasse
   * sincronamente dentro do próprio handler de status, um dispatchTask novo
   * poderia anexar seus listeners de 'event' a tempo de capturar o result
   * event que ainda está sendo emitido para a tarefa que acabou de terminar.
   *
   * `ctx` é a sessão que ficou livre (o árbitro do próximo envio entrega a ela).
   * Vem depois do onTurnResult do mesmo turno: o fim do turno é síncrono no
   * result, e este gancho espera a microtask.
   */
  onSessionAvailable?: (projectId: number, ctx?: { localId: string; engine: EngineId }) => void
  /** Chamado quando um evento result traz tokens (Codex e demais engines que os expõem). Claude não seta tokens → nunca dispara. */
  onEngineUsage?: (engine: EngineId, tokens: { input: number; cachedInput: number; output: number; reasoning: number; total: number }) => void
  /** `rate_limit_info` dos `rate_limit_event` dos terminais do Claude: o uso do plano sem consultar o endpoint. */
  onRateLimit?: (info: unknown) => void
  /**
   * Limiar do auto-compact em % da janela de contexto (0/ausente = desligado),
   * lido A CADA result — mudar a configuração vale na hora, sem recriar sessão.
   * Quando o contexto reportado cruza o limiar, chama a compactação nativa
   * da engine. A compactação interna do agente continua independente deste limiar.
   */
  autoCompactPct?: () => number
  /**
   * Chamado a cada evento result de qualquer sessão: o turno terminou de verdade.
   * `isError` = o result veio com erro; `interrupted` = o operador (ou o "enviar
   * agora") interrompeu este turno, pelo interrupt() do manager; `limited` = o
   * turno bateu no limite de uso (o mesmo que vai ao onUsageLimit).
   *
   * O turno interrompido que a engine fecha sem result (Kimi e OpenCode, e o
   * Claude quando o interrupt fecha o turno antes do result) também chega aqui,
   * sintetizado, antes do onSessionAvailable da mesma transição. No
   * encerramento do serviço, `interrupted` é sempre false: a parada não foi do
   * operador.
   *
   * `origin` é quem mandou o turno que terminou, lida no fim dele, antes de
   * qualquer envio novo. No turno interrompido, é a origem guardada no Esc: o
   * "enviar agora" que sai logo depois não troca a origem do turno interrompido.
   */
  onTurnResult?: (projectId: number, engine: EngineId, info: TurnResultInfo) => void
  /** A sessão morreu de verdade (status 'dead' fora do encerramento do serviço). */
  onSessionDied?: (projectId: number, engine: EngineId) => void
  /**
   * A sessão saiu: virou 'dead' ou 'stopped', inclusive no encerramento do
   * serviço. A conversa lateral do mesmo terminal e motor fecha com ela.
   */
  onSessionEnded?: (projectId: number, engine: EngineId, localId: string) => void
  /**
   * O turno bateu no limite de uso do Claude. Chamado no result, ANTES do
   * onTurnResult. `resetsAt` em epoch SEGUNDOS (null = desconhecido); `origin` é
   * quem mandou a última mensagem da sessão.
   */
  onUsageLimit?(projectId: number, engine: EngineId, p: { localId: string; resetsAt: number | null; origin: LimitOrigin }): void
  /** Recurso do horário quando o limite veio só pelo texto: o `resetsAt` que o uso guardou. */
  lastRejectedResetsAt?: () => number | null
  /**
   * Chamado quando o OPERADOR manda uma mensagem (manager.send, o que ele digita).
   * O que o próprio Claudinei manda (sendAsClaudinei, tarefas, agendamentos) não conta.
   * `queued`: a mensagem saiu da fila do operador (lugar 3 do árbitro), não foi
   * digitada agora; o goal não pausa por ela (ele vem sempre depois da fila).
   * `localId` e `text`: a sessão e o texto (o ramo guarda o que vai à cópia ainda pendente).
   */
  onOperatorMessage?: (projectId: number, engine: EngineId, info: { queued: boolean; localId?: string; text?: string }) => void
  /**
   * Comando do Claudinei digitado no chat (hoje só o `/goal`: `/goal` sozinho ou
   * `/goal <...>`, não `/goalx`). Chamado no início do `send`, com a sessão viva.
   * Devolve true se tratou: nada vai à sessão, o `onOperatorMessage` não é
   * chamado e a origem da sessão não muda. Com false (ou sem o gancho), o envio
   * segue normal. O que ele lança (ex.: `UserError('goal_invalid')`) chega a quem
   * chamou o `send`, sem enviar nada.
   */
  interceptCommand?: (ctx: SlotContext, text: string) => boolean
  /**
   * O terminal precisa do operador: abriu uma pergunta, o turno falhou ou a
   * sessão morreu. Liga ao despertador da triagem (assentado e adiado voltam).
   * Turno que só terminou, `working`, a interrupção pedida pelo operador e a
   * morte no encerramento NÃO chamam.
   */
  onNeedsOperator?: (projectId: number, reason: 'question' | 'failed' | 'dead') => void
  /** Rastreador de turnos do desfazer: vê cada mensagem, status e evento. O que o onInput lança sobe a quem enviou. */
  turnObserver?: TurnObserver
}

/**
 * O fim de um turno, para o onTurnResult (veja lá). `compaction`: o turno foi
 * uma compactação (a automática ou o /compact); a `origin` dela é a da mensagem
 * anterior, então quem conta turnos (o goal) precisa saber.
 */
export interface TurnResultInfo { isError: boolean; interrupted: boolean; limited: boolean; origin: LimitOrigin; compaction?: boolean }

/**
 * O resultado da tarefa delegada cujo turno o operador interrompeu (Esc ou
 * "enviar agora" no terminal de destino): fecha como falha com este texto, e
 * não como concluída e vazia (R18). Texto ao agente, em inglês.
 */
export const TASK_INTERRUPTED_TEXT = 'interrupted by the operator'

/** `/goal` sozinho ou seguido de espaço: o comando do objetivo, não `/goalx`. */
const GOAL_COMMAND = /^\/goal(\s|$)/

const ACTIVE = new Set<SessionStatus>(['starting', 'idle', 'working', 'needs_attention'])

/** Restrição da sessão que recebe uma tarefa de outro agente (veja pickTaskTarget). */
export interface TaskTarget { localId?: string; accept?: (engine: EngineId) => boolean }

/**
 * Como terminou o turno que alguém estava esperando: com a resposta, com a sessão
 * fora do ar (morreu ou parou), por tempo, ou derrubado pelo encerramento do
 * próprio Claudinei.
 */
type TurnEnd =
  /**
   * `limited`: o turno bateu no limite de uso; `resetsAt` em epoch segundos, null = desconhecido.
   * `interrupted`: o operador interrompeu o turno (o result é o do turno cortado).
   */
  | { kind: 'result'; text: string; limited?: { resetsAt: number | null }; interrupted?: true }
  /** O turno interrompido pelo operador fechou sem result (Kimi, OpenCode, ou o result póstumo descartado). */
  | { kind: 'interrupted' }
  | { kind: 'dead' | 'stopped' | 'timeout' | 'shutdown' }

/**
 * O que os ouvintes de turno precisam do manager: saber se o serviço está
 * encerrando e se o turno que acabou bateu no limite (com o horário já resolvido,
 * o mesmo que vai ao onUsageLimit).
 */
interface TurnCtx {
  isShuttingDown: () => boolean
  limitOf: (session: EngineSession) => { resetsAt: number | null } | undefined
  /**
   * O result que acabou de chegar fecha um turno interrompido pelo operador. O
   * ouvinte do wire() roda antes dos ouvintes de turno e consome a marca do Esc;
   * por isso ele guarda o veredito, lido aqui no mesmo result.
   */
  wasInterrupted: (session: EngineSession) => boolean
  /**
   * Assina o fim sintetizado do turno interrompido que fechou sem result (o
   * "livre" do wire()). Devolve o cancelamento.
   */
  onCutEnd: (session: EngineSession, cb: () => void) => () => void
}

/**
 * Ouve o turno em curso da sessão até ele terminar e avisa UMA vez como terminou.
 * É o ouvinte comum de quem "manda e espera" (waitForResult, dispatchTask,
 * watchTurn). Devolve o cancelamento, para quem desiste antes (envio que falhou).
 *
 * `timeoutMs` ausente (ou 0): sem prazo, nenhum relógio é armado — o turno só
 * termina com o result ou com a sessão fora do ar. É o caso das tarefas
 * delegadas, que podem levar o tempo que o outro agente precisar.
 *
 * `isShuttingDown`: com o serviço encerrando, a sessão que para não terminou o
 * turno por conta própria — foi o reinício que a derrubou. Quem espera precisa
 * saber disso para não registrar a interrupção como falha do agente.
 */
function watchTurnEnd(
  session: EngineSession, timeoutMs: number | undefined, ctx: TurnCtx, onEnd: (end: TurnEnd) => void,
  opts?: { cut?: boolean },
): () => void {
  let settled = false
  const finish = (end: TurnEnd) => {
    if (settled) return
    settled = true; cleanup(); onEnd(end)
  }
  const cleanup = () => {
    session.removeListener('event', onEvent)
    session.removeListener('status', onStatus)
    offCut?.()
    if (timer) clearTimeout(timer)
  }
  const onEvent = (evt: ClaudeEvent) => {
    if (evt.kind === 'result') {
      const limited = ctx.limitOf(session)
      const interrupted = ctx.wasInterrupted(session)
      finish({ kind: 'result', text: evt.resultText, ...(limited ? { limited } : {}), ...(interrupted ? { interrupted: true as const } : {}) })
    }
  }
  const onStatus = (status: SessionStatus) => {
    // 'stopped' cobre também openInTerminal (que passa por session.stop()):
    // sem isso o ouvinte ficaria pendurado até o prazo (ou para sempre, sem
    // prazo) com o agente já fora.
    if (status !== 'dead' && status !== 'stopped') return
    finish({ kind: ctx.isShuttingDown() ? 'shutdown' : status })
  }
  const timer = timeoutMs ? setTimeout(() => finish({ kind: 'timeout' }), timeoutMs) : undefined
  // Só quem pede (a tarefa): o turno cortado sem result também é um fim. No
  // encerramento não termina aqui: a parada que vem depois dá o 'shutdown'.
  const offCut = opts?.cut ? ctx.onCutEnd(session, () => { if (!ctx.isShuttingDown()) finish({ kind: 'interrupted' }) }) : undefined
  session.on('event', onEvent)
  session.on('status', onStatus)
  return () => { if (!settled) { settled = true; cleanup() } }
}

/**
 * Espera o `result` do turno em curso da sessão. É a primitiva por trás de tudo que
 * "manda e espera a resposta" (askAgent, agendamentos): a resposta de um turno só
 * existe como evento, e quem espera precisa desistir por três motivos — a resposta
 * chegou, a sessão morreu/parou, ou o tempo acabou. No encerramento do serviço, a
 * recusa leva o RESTART_FAIL_TEXT: quem esperava fica sabendo que foi o reinício.
 * Turno que bateu no limite de uso recusa com o texto do limite (e a hora em que
 * a janela reabre, quando se sabe).
 */
function waitForResult(session: EngineSession, timeoutMs: number, ctx: TurnCtx): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    watchTurnEnd(session, timeoutMs, ctx, (end) => {
      if (end.kind === 'result') {
        if (end.limited) reject(new Error(usageLimitFailText(end.limited.resetsAt)))
        else resolve(end.text)
      } else reject(new Error(
        end.kind === 'shutdown' ? RESTART_FAIL_TEXT
          : end.kind === 'dead' ? 'target agent exited unexpectedly before responding'
            : end.kind === 'stopped' ? 'target agent was stopped before responding'
              : end.kind === 'interrupted' ? TASK_INTERRUPTED_TEXT
                : 'timed out waiting for the agent response'))
    })
  })
}

/**
 * Ouvinte de tarefa (dispatchTask, watchTurn): fecha a tarefa com o result ou como
 * falha. Sem `timeoutMs`, não há prazo: a sessão que morre ou para ainda fecha a
 * tarefa como falha. No encerramento do serviço NÃO fecha: só solta os ouvintes, e a tarefa
 * continua in_progress no banco para ser reanexada depois do boot. Turno que
 * bateu no limite fecha a tarefa como falha, com o texto do limite. Turno que o
 * operador interrompeu (com result ou sem) fecha como falha, com o texto da
 * interrupção (R18); o limite tem prioridade sobre ele.
 */
function watchTask(
  session: EngineSession, timeoutMs: number | undefined, ctx: TurnCtx,
  onComplete: (status: 'completed' | 'failed', result: string) => void,
): () => void {
  return watchTurnEnd(session, timeoutMs, ctx, (end) => {
    if (end.kind === 'shutdown') return
    if (end.kind === 'result') {
      if (end.limited) onComplete('failed', usageLimitFailText(end.limited.resetsAt))
      // Interrompido no encerramento: a tarefa fica in_progress para ser religada.
      else if (end.interrupted) { if (!ctx.isShuttingDown()) onComplete('failed', TASK_INTERRUPTED_TEXT) }
      else onComplete('completed', end.text)
    }
    else onComplete('failed', end.kind === 'dead' ? 'target agent exited'
      : end.kind === 'stopped' ? 'target agent was stopped'
        : end.kind === 'interrupted' ? TASK_INTERRUPTED_TEXT : 'timed out')
  }, { cut: true })
}

export function createSessionManager(deps: Deps) {
  const live = new Map<string, {
    session: EngineSession; projectId: number; engine: EngineId; contextTokens?: number; contextWindow?: number; autoCompacting?: boolean; initModel?: string
    /**
     * A auto-compactação foi decidida neste result e ainda não abriu o turno
     * dela. O "livre" desta transição espera: a compactação (lugar 1) vem antes
     * de qualquer coisa que o árbitro do próximo envio mandaria.
     */
    compactPending?: boolean
    /** O turno em curso é uma compactação (a automática ou o /compact): o fim dele chega ao onTurnResult com `compaction`. */
    compactTurn?: boolean
    /** Quem mandou a última mensagem desta sessão: decide se o limite pode retomar sozinho. */
    origin: LimitOrigin
    /** Início (epoch ms) do turno em curso: o corte da conversa lateral deixa de fora o que veio depois. */
    turnStartedAt?: number
    /** Avisos do plugin You should know (só Claude): o cartão de agora e o controlador da superfície. */
    headsUp?: HeadsUpNode | null; headsUpCtl?: ReturnType<typeof createHeadsUp>; setHeadsUp?: (on: boolean) => Promise<void>
  }>()
  // Resolve a sessão pela engine (registry) — ou, em teste, pelo override sessionFactory.
  const makeSession = (engineId: EngineId, opts: EngineSessionOptions): EngineSession =>
    deps.sessionFactory ? deps.sessionFactory(opts) : getEngine(engineId).createSession(opts)
  /** Todo envio (menos o /compact) passa pelo observador, que pode pôr uma nota na frente; o que ele lança sobe. */
  const sendVia = (entry: { projectId: number; engine: EngineId }, localId: string, text: string, origin: InputOrigin, doSend: (t: string) => void): void =>
    deps.turnObserver ? deps.turnObserver.onInput({ localId, projectId: entry.projectId, engine: entry.engine }, text, origin, doSend) : doSend(text)
  /** O terminal dono de uma entrada viva (askAgent e dispatchTask escolhem a entrada, não o id). */
  const idOf = (entry: object): string => [...live].find(([, e]) => e === entry)![0]
  /**
   * Sessões relançadas com o id de conversa segurado (relaunch com holdEngineId):
   * até o primeiro result, o id novo não vai ao banco, ao project_threads nem à
   * web. Se o processo morre antes, o banco fica com o id antigo (sem resume de
   * id fantasma). Chave: localId; valor: a sessão que segura.
   */
  const heldEngineId = new Map<string, EngineSession>()
  /**
   * Sessões relançadas por uma volta da conversa que ainda não emitiram o init
   * (relaunch com awaitInit; hoje, a conversa nova do Codex). Diferente do
   * heldEngineId, NÃO segura a gravação: o id do init é real e vai ao banco na
   * hora. Só marca a volta como pendente até lá, para o ramificar recusar em vez
   * de copiar a conversa de antes da volta. Sai no init (com id) ou quando essa
   * sessão morre/para. Chave: localId; valor: a sessão marcada.
   */
  const awaitingInit = new Map<string, EngineSession>()

  /**
   * Ligado por beginShutdown, quando o serviço vai parar. A partir daí, sessão que
   * para foi derrubada pelo reinício: tarefa encaminhada não fecha como falha,
   * quem espera o turno recebe o RESTART_FAIL_TEXT e a pergunta gravada fica no
   * banco (é ela que o boot seguinte mostra ao operador).
   */
  let shuttingDown = false
  const isShuttingDown = () => shuttingDown

  /** Havia pergunta aberta no último status de cada sessão: só a borda ausente→presente acorda. */
  const hadQuestion = new Map<string, boolean>()
  /**
   * Sessões com uma interrupção do operador em curso. O Claude fecha o turno
   * interrompido com um result de erro (`error_during_execution`), que não é
   * falha: foi o operador que parou. O Codex já marca `interrupted`.
   */
  const interrupting = new Set<string>()
  /**
   * Sessões cujo turno em curso o operador mandou interromper. Diferente do
   * `interrupting`, a marca dura até o fim do turno: no Kimi e no OpenCode o
   * interrupt() resolve na hora e o processo só sai depois, sem result. Sai no
   * result do turno, no "livre" que fecha o turno sem result ou na morte.
   * Guarda a origem do turno interrompido, lida no Esc: o fim dele sai com ela.
   */
  const interruptedTurn = new Map<string, LimitOrigin>()
  /**
   * O veredito do último result de cada sessão: era um turno interrompido pelo
   * operador? Gravado pelo ouvinte do wire() (que consome a marca do Esc) antes
   * de os ouvintes de turno lerem o mesmo result (TurnCtx.wasInterrupted).
   */
  const lastResultInterrupted = new WeakMap<EngineSession, boolean>()
  /** Quem espera o fim sintetizado do turno interrompido sem result, por sessão (TurnCtx.onCutEnd). */
  const cutWatchers = new WeakMap<EngineSession, Set<() => void>>()
  const onCutEnd = (session: EngineSession, cb: () => void): (() => void) => {
    let set = cutWatchers.get(session)
    if (!set) { set = new Set(); cutWatchers.set(session, set) }
    set.add(cb)
    return () => { cutWatchers.get(session)?.delete(cb) }
  }

  /**
   * O limite em que o turno da sessão bateu, com o horário resolvido: o do
   * rate_limit_event do turno ou, se a CLI só mandou o texto, o que o uso guardou.
   */
  const limitOf = (session: EngineSession): { resetsAt: number | null } | undefined => {
    const hit = session.usageLimit
    if (!hit) return undefined
    if (hit.resetsAt !== null) return { resetsAt: hit.resetsAt }
    let fallback: number | null = null
    try { fallback = deps.lastRejectedResetsAt?.() ?? null } catch { /* sem horário */ }
    return { resetsAt: fallback }
  }
  const turnCtx: TurnCtx = {
    isShuttingDown, limitOf, onCutEnd,
    wasInterrupted: (session) => lastResultInterrupted.get(session) ?? false,
  }

  /**
   * O id de conversa a retomar, DEPOIS de conferir que ele ainda existe.
   *
   * Um `claude_session_id` gravado cujo transcript sumiu (limpeza do ~/.claude,
   * máquina trocada) fazia `--resume` morrer com "No conversation found" — e como
   * o id vinha do banco e nunca era descartado, chat e terminal ficavam presos
   * para sempre. Aqui o fantasma é jogado fora E apagado do banco (o COALESCE do
   * persist nunca sobrescreve com null, então sem este DELETE explícito ele
   * voltaria na próxima abertura).
   */
  const resolveResume = (engineId: EngineId, projectPath: string, localId: string, candidate: string | null): string | null => {
    if (!candidate) return null
    // Formato ANTES de existência: um id malformado no banco não pode virar argv
    // ("-x flag") nem sequer tocar o disco. Rejeita em vez de descartar.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(candidate)) throw new Error('id de sessão inválido')
    const eng = getEngine(engineId)
    if (eng.conversationExists && !eng.conversationExists(projectPath, candidate)) {
      deps.db.prepare('UPDATE sessions SET claude_session_id=NULL WHERE local_id=?').run(localId)
      return null
    }
    return candidate
  }

  /**
   * A conversa PRÓPRIA deste terminal, para usar no lugar do `--continue` quando
   * a pasta é compartilhada.
   *
   * Não passa por `resolveResume` porque aqui a sessão pode nem existir ainda no
   * banco (é chamada de dentro do `start`, antes do INSERT) — e não haveria linha
   * para o UPDATE de descarte. As duas defesas que importam continuam: formato,
   * porque o id vai virar argv; e existência, porque um transcript que sumiu faz
   * o `--resume` morrer com "No conversation found".
   */
  const ownResume = (projectId: number, engineId: EngineId, projectPath: string): string | undefined => {
    const own = ownLatestThread(deps.db, projectId, engineId)
    if (!own || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(own)) return undefined
    const eng = getEngine(engineId)
    if (eng.conversationExists && !eng.conversationExists(projectPath, own)) return undefined
    return own
  }

  const persist = (localId: string, status: SessionStatus, engineSessionId: string | null) => {
    if (heldEngineId.has(localId)) engineSessionId = null // o COALESCE mantém o antigo
    deps.db.prepare(
      `UPDATE sessions SET status=?, claude_session_id=COALESCE(?, claude_session_id), updated_at=datetime('now') WHERE local_id=?`,
    ).run(status, engineSessionId, localId)
    // Único lugar que grava um id de conversa em `sessions` (o UPDATE ... = NULL
    // de resolveResume só descarta id fantasma), e por isso o único lugar de onde
    // a posse do thread precisa sair. Vai para project_threads porque a linha da
    // sessão não sobrevive: a limpeza mantém só 5 finalizadas por projeto.
    if (!engineSessionId) return
    const row = deps.db.prepare('SELECT project_id, engine FROM sessions WHERE local_id=?').get(localId) as any
    if (row) recordThread(deps.db, row.project_id, row.engine ?? DEFAULT_ENGINE_ID, engineSessionId)
  }

  // O id efetivo: o do processo vivo, ou — enquanto ele ainda não emitiu o
  // init (ex.: revive/--continue ficam em 'starting' até a 1ª msg) — o que já
  // está persistido no banco. Assim a UI conhece o id imediatamente e carrega
  // o histórico da conversa anterior (D4) sem esperar o operador digitar.
  const effectiveEngineSessionId = (localId: string, session: EngineSession): string | null => {
    if (session.sessionId && !heldEngineId.has(localId)) return session.sessionId
    const row = deps.db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any
    return row?.claude_session_id ?? null
  }

  /**
   * Fim de turno para o gancho. Grava no banco e roda dentro do handler da
   * engine: nunca lança daqui. No encerramento, nenhum turno conta como
   * interrompido pelo operador (a fila não pausa por causa de um reinício).
   */
  const turnResult = (projectId: number, engine: EngineId, info: TurnResultInfo): void => {
    try { deps.onTurnResult?.(projectId, engine, { ...info, interrupted: info.interrupted && !shuttingDown }) } catch {}
  }

  /**
   * Lê e limpa a marca de turno de compactação: ela vale só para o fim deste
   * turno. Só aparece no info quando é compactação (o turno comum segue igual).
   */
  const compactionOf = (localId: string): { compaction?: true } => {
    const entry = live.get(localId)
    if (!entry?.compactTurn) return {}
    entry.compactTurn = false
    return { compaction: true }
  }

  /** A sessão ficou livre. Roda numa microtask: um erro seria exceção sem dono e derrubaria o processo. */
  const available = (projectId: number, localId: string, engine: EngineId): void => {
    try { deps.onSessionAvailable?.(projectId, { localId, engine }) } catch (err) { console.error('[manager] onSessionAvailable falhou', err) }
  }

  const wire = (localId: string, projectId: number, engine: EngineId, session: EngineSession, opts?: { holdEngineId?: boolean; awaitInit?: boolean }) => {
    live.set(localId, { session, projectId, engine, origin: 'operator' })
    if (opts?.holdEngineId) heldEngineId.set(localId, session); else heldEngineId.delete(localId)
    if (opts?.awaitInit) awaitingInit.set(localId, session); else awaitingInit.delete(localId)
    // Avisos do plugin "You should know" (heads-up.ts): só no Claude, e só com o
    // interruptor do terminal ligado — lido do banco na hora, para valer o atual.
    const surface = engine === 'claude' && isHeadsUpSurface(session) ? session : undefined
    const headsUpWanted = () => {
      const row = deps.db.prepare('SELECT heads_up FROM projects WHERE id=?').get(projectId) as { heads_up?: number } | undefined
      return (row?.heads_up ?? 1) !== 0
    }
    const setHeadsUp = async (on: boolean) => {
      const entry = live.get(localId)
      if (!entry || !surface) return
      if (!on) {
        const ctl = entry.headsUpCtl
        entry.headsUpCtl = undefined
        await ctl?.stop()
        return
      }
      if (entry.headsUpCtl || !session.sessionId) return // antes do init, o init liga
      const ctl = createHeadsUp({
        surface,
        onChange: (tree) => {
          const e = live.get(localId)
          if (e) e.headsUp = tree
          deps.broadcast({ type: 'heads_up', localId, projectId, tree })
        },
        log: (m) => console.info(`[avisos] ${localId}: ${m}`),
      })
      entry.headsUpCtl = ctl
      await ctl.start()
    }
    live.get(localId)!.setHeadsUp = setHeadsUp
    // O início do turno é o relógio de ANTES da escrita no stdin: a CLI carimba
    // a mensagem com o relógio dela, e o status 'working' só chega depois da
    // escrita (e do eco ao navegador). Sem isto, a pergunta do turno em curso
    // podia cair antes do início e entrar no corte da conversa lateral.
    let sendingSince: number | undefined
    const sendOriginal = session.send.bind(session)
    session.send = (text, o) => {
      sendingSince = Date.now()
      try { sendOriginal(text, o) } finally { sendingSince = undefined }
    }
    // Um lugar só monta o session_status do wire(): cada campo novo do SessionInfo
    // (hoje, pendingQuestion) entra aqui e chega igual nos três momentos em que
    // ele publica — mudança de status, init e arranque.
    const statusMsg = (over: { status?: SessionStatus; engineSessionId?: string | null; detail?: string } = {}) => {
      const info = infoOf(localId)
      return {
        type: 'session_status' as const, localId, projectId,
        engine: info?.engine ?? engine,
        status: over.status ?? session.status,
        engineSessionId: over.engineSessionId !== undefined ? over.engineSessionId : effectiveEngineSessionId(localId, session),
        detail: over.detail,
        model: info?.model ?? null, permissionMode: info?.permissionMode, effort: info?.effort ?? null,
        backgroundTasks: info?.backgroundTasks ?? [], authExpired: info?.authExpired ?? false,
        contextTokens: info?.contextTokens,
        contextWindow: info?.contextWindow,
        pendingQuestion: info?.pendingQuestion,
        compactingSince: info?.compactingSince,
      }
    }
    session.on('status', (status: SessionStatus) => {
      const entryT = live.get(localId)
      if (entryT?.session === session) {
        if (status === 'working') entryT.turnStartedAt ??= sendingSince ?? Date.now()
        else entryT.turnStartedAt = undefined
      }
      persist(localId, status, session.sessionId ?? null)
      try { deps.turnObserver?.onStatus({ localId, projectId, engine }, status, { compaction: () => !!live.get(localId)?.compactTurn, engineSessionId: session.sessionId ?? null, shuttingDown }) } catch (err) { console.error('[manager] onStatus do desfazer falhou', err) }
      // A pergunta aberta vai ao banco porque o processo não sobrevive ao reinício:
      // é dela que o boot seguinte sabe que a interrupção esperava uma decisão.
      // No encerramento a coluna fica como está — o processo saindo zera a
      // pendência na memória, e gravar isso apagaria justamente o que importa.
      if (!shuttingDown) {
        const q = session.pendingQuestion
        deps.db.prepare('UPDATE sessions SET pending_question=? WHERE local_id=?')
          .run(q ? JSON.stringify(q.questions) : null, localId)
      }
      const detail = status === 'dead'
        ? (session.lastStderr || 'O processo do agente encerrou inesperadamente.')
        : undefined
      deps.broadcast(statusMsg({ status, detail }))
      // O despertador da triagem. Grava no banco e roda dentro do handler da
      // engine, então nunca pode lançar daqui (mesmo cuidado do onTurnResult).
      const hasQuestion = session.pendingQuestion !== undefined
      if (hasQuestion && !hadQuestion.get(localId)) {
        try { deps.onNeedsOperator?.(projectId, 'question') } catch {}
      }
      hadQuestion.set(localId, hasQuestion)
      // No encerramento, a sessão que morre foi derrubada pelo próprio Claudinei.
      if (status === 'dead' && !shuttingDown) {
        try { deps.onNeedsOperator?.(projectId, 'dead') } catch {}
        try { deps.onSessionDied?.(projectId, engine) } catch {}
      }
      if (status === 'dead' || status === 'stopped') {
        // O processo saiu: o aviso que estava na tela some com ele.
        if (live.get(localId)?.headsUp) deps.broadcast({ type: 'heads_up', localId, projectId, tree: null })
        live.delete(localId)
        hadQuestion.delete(localId)
        interruptedTurn.delete(localId)
        try { deps.onSessionEnded?.(projectId, engine, localId) } catch (err) { console.error('[manager] onSessionEnded falhou', err) }
        if (heldEngineId.get(localId) === session) heldEngineId.delete(localId)
        if (awaitingInit.get(localId) === session) awaitingInit.delete(localId)
      }
      if (status === 'idle' || status === 'needs_attention') {
        queueMicrotask(() => {
          // Turno interrompido que fechou sem result (Kimi, OpenCode, ou o Claude
          // cujo result póstumo a sessão descarta): o fim dele sai daqui. Na
          // microtask, e não no status: no Claude o status chega ANTES do result
          // do mesmo turno, e aqui o result (se houve) já consumiu a marca.
          const cut = interruptedTurn.get(localId)
          if (cut !== undefined) {
            interruptedTurn.delete(localId)
            turnResult(projectId, engine, { isError: false, interrupted: true, limited: false, origin: cut, ...compactionOf(localId) })
            // A tarefa delegada que este turno executava também termina aqui
            // (R18), antes do "livre": o turno seguinte não é dela.
            for (const cb of [...(cutWatchers.get(session) ?? [])]) {
              try { cb() } catch (err) { console.error('[manager] fim do turno interrompido falhou', err) }
            }
          }
          // No Claude, o status chega antes do result que decide compactar: o
          // "livre" espera a compactação, cujo fim dá outro "livre".
          if (live.get(localId)?.compactPending) return
          available(projectId, localId, engine)
        })
      }
    })
    session.on('event', (event) => {
      try { deps.turnObserver?.onEvent({ localId, projectId, engine }, event) } catch (err) { console.error('[manager] onEvent do desfazer falhou', err) }
      // O primeiro result do processo relançado: a conversa nova existe, o id vai ao banco e à web.
      if (event.kind === 'result' && heldEngineId.get(localId) === session) { heldEngineId.delete(localId); persist(localId, session.status, session.sessionId ?? null); deps.broadcast(statusMsg()) }
      if (event.kind === 'system' && event.subtype === 'ui_invalidate') { live.get(localId)?.headsUpCtl?.invalidate(); return }
      if (event.kind === 'init' && surface && headsUpWanted()) void setHeadsUp(true).catch(() => {})
      if (event.kind === 'init') {
        // A janela sai do modelo que o CLI reporta aqui (o stream não anuncia o
        // tamanho). Vale para o modelo EM USO: trocar de modelo emite novo init,
        // então a janela acompanha — inclusive os 1M do Opus/Sonnet/Fable atuais.
        const entryI = live.get(localId)
        if (entryI && engine === 'claude') {
          entryI.initModel = event.model
          entryI.contextWindow = contextWindowFor(event.model)
        }
        // O init carrega a lista de slash commands instalados: persiste para o
        // autocomplete do chat ficar disponível já no load (sem esperar a 1ª msg).
        if (Array.isArray(event.slashCommands) && event.slashCommands.length) {
          deps.onSlashCommands?.(event.slashCommands)
        }
        // Persiste/broadcasta o id de conversa ASSIM QUE conhecido. No Codex
        // (turn-based) o thread_id só nasce no 1º turno via thread.started e NÃO
        // dispara mudança de status — sem isto o engineSessionId só chegaria à UI
        // no fim do turno, deixando "Open in terminal" desabilitado no meio.
        if (event.sessionId) {
          // A conversa nova da volta existe: o ramificar já pode copiá-la.
          if (awaitingInit.get(localId) === session) awaitingInit.delete(localId)
          persist(localId, session.status, event.sessionId)
          deps.broadcast(statusMsg({ engineSessionId: heldEngineId.has(localId) ? undefined : event.sessionId }))
        }
      }
      if (event.kind === 'result' && event.tokens) {
        // Métrica nunca derruba o processo: isto roda dentro do handler de
        // stdout da engine — um erro do SQLite aqui viraria uncaughtException.
        try { deps.onEngineUsage?.(engine, event.tokens) } catch {}
      }
      // Mesmo cuidado: os ganchos gravam no banco e rodam dentro do stdout da engine.
      // O limite vem ANTES do fim do turno: quem cuida do limite registra primeiro,
      // e o onTurnResult (com isError) decide depois.
      // Turno que bateu no limite, com quem cuide dele: é o caminho do limite que
      // acorda o terminal (só quando o aviso nasce), não a falha abaixo.
      const limited = event.kind === 'result' ? limitOf(session) : undefined
      const limitHandled = !!limited && !!deps.onUsageLimit
      if (event.kind === 'result') {
        if (limited) {
          const origin = live.get(localId)?.origin ?? 'operator'
          try { deps.onUsageLimit?.(projectId, engine, { localId, resetsAt: limited.resetsAt, origin }) } catch {}
        }
        // A marca do operador vale para este turno e sai com ele. O `interrupted`
        // do Codex é o próprio motor confirmando a interrupção.
        // A origem é lida aqui, no próprio result: a do Esc, se houve, senão a da sessão.
        const origin = interruptedTurn.get(localId) ?? live.get(localId)?.origin ?? 'operator'
        const interrupted = interruptedTurn.delete(localId) || interrupting.has(localId) || event.subtype === 'interrupted'
        lastResultInterrupted.set(session, interrupted)
        turnResult(projectId, engine, { isError: event.isError, interrupted, limited: !!limited, origin, ...compactionOf(localId) })
      }
      // Turno que falhou acorda o terminal assentado ou adiado; o interrompido
      // pelo operador e o do limite de uso (acordado pelo serviço do limite), não.
      if (event.kind === 'result' && event.isError && event.subtype !== 'interrupted' && !interrupting.has(localId) && !limitHandled) {
        try { deps.onNeedsOperator?.(projectId, 'failed') } catch {}
      }
      if (engine === 'claude' && event.kind === 'raw') {
        const raw = event.raw as { type?: unknown; rate_limit_info?: unknown } | null
        // Mesmo cuidado da métrica acima: nada aqui pode derrubar o stdout.
        if (raw?.type === 'rate_limit_event') { try { deps.onRateLimit?.(raw.rate_limit_info) } catch {} }
      }
      // Compactação: a conversa encolheu, mas ninguém remede o contexto aqui — o
      // result do próprio /compact vem com o usage TODO ZERADO (ordem empírica,
      // capturada da CLI: status compacting → compact_boundary → resumo → result
      // zerado). Sem invalidar na fronteira, o medidor seguiria exibindo o
      // tamanho de ANTES — justamente o valor alto que disparou a compactação —
      // até o próximo turno de verdade. A fronteira chega ANTES do result, então
      // limpar aqui não corre risco de ser sobrescrita.
      //
      // Por que não usar o post_tokens que a fronteira traz: ele conta só as
      // mensagens da conversa, sem o system prompt/ferramentas que o usage do
      // result inclui — na captura, post_tokens=2524 contra 21083 medidos no
      // turno seguinte. Exibi-lo seria trocar um número velho por um otimista.
      if (event.kind === 'system' && event.subtype === 'compact_boundary') {
        const entry = live.get(localId)
        if (entry) entry.contextTokens = undefined
      }
      // Quem sabe o tamanho do contexto é a mensagem `assistant`: o usage dela é o
      // que entrou naquela requisição — a conversa inteira até ali. O usage do
      // `result` NÃO serve: ele soma as requisições do turno (medido: 182.557
      // contra 34.449 reais num turno de 5 ferramentas), e era o que fazia o
      // auto-compact disparar com a janela quase vazia.
      //
      // Subagente não conta: a conversa dele é outra, e menor — deixá-la entrar
      // faria o medidor pular para baixo no meio do turno principal.
      if (event.kind === 'assistant' && typeof event.contextTokens === 'number') {
        const deSubagente = !!(event.raw as { parent_tool_use_id?: string } | undefined)?.parent_tool_use_id
        const entry = live.get(localId)
        if (entry && !deSubagente) entry.contextTokens = event.contextTokens
      }
      if (event.kind === 'context') {
        const entry = live.get(localId)
        if (entry) {
          entry.contextTokens = event.contextTokens
          entry.contextWindow = event.contextWindow
        }
      }
      if (event.kind === 'result') {
        const entry = live.get(localId)
        if (entry) {
          // A janela que a CLI informa no result manda: o nome do modelo é só o
          // palpite de arranque, e um modelo novo cairia nos 200k conservadores.
          const janelaDaCli = windowFromModelUsage((event.raw as { modelUsage?: unknown } | undefined)?.modelUsage, entry.initModel)
          if (janelaDaCli) entry.contextWindow = janelaDaCli
          // Auto-compact: UMA operação nativa por cruzamento do limiar.
          // O flag só re-arma quando um result volta abaixo do limiar (o da própria
          // compactação, tipicamente) — se compactar não reduzir o bastante, não
          // entra em loop de /compact atrás de /compact.
          const pct = deps.autoCompactPct?.() ?? 0
          const janela = entry.contextWindow ?? (engine === 'claude' ? DEFAULT_CONTEXT_WINDOW : undefined)
          const limiar = pct > 0 && janela ? (janela * pct) / 100 : Infinity
          const used = entry.contextTokens
          if (used !== undefined && used >= limiar && !entry.autoCompacting && session.compact && !event.isError && event.subtype !== 'compact' && event.subtype !== 'interrupted') {
            entry.autoCompacting = true
            entry.compactPending = true
            // Microtask: deixa o status do result assentar antes de abrir o turno
            // de compactação (mesmo adiamento do onSessionAvailable, mesmo motivo).
            queueMicrotask(() => {
              entry.compactPending = false
              if (live.get(localId) !== entry) return // sessão saiu entre o result e o envio
              let compacted = false
              try {
                if (!['idle', 'needs_attention'].includes(entry.session.status)) { entry.autoCompacting = false; return }
                entry.session.compact!()
                entry.compactTurn = true
                compacted = true
                // Eco na UI: sem ele a sessão "trabalha sozinha" sem explicação.
                deps.broadcast({ type: 'session_event', localId, event: userEchoEvent('/compact') })
              } catch { /* stopped/dead no meio do caminho: nada a compactar */ } finally {
                // Não compactou e a sessão segue livre: o "livre" que esperou sai agora.
                if (!compacted && ['idle', 'needs_attention'].includes(entry.session.status)) available(projectId, localId, engine)
              }
            })
          } else if (used !== undefined && used < limiar) {
            entry.autoCompacting = false
          }
        }
      }
      deps.broadcast({ type: 'session_event', localId, event })
    })
    session.start()
    // O status inicial não vem como evento, e a CLI retomando uma conversa só
    // emite o init junto da 1ª mensagem: sem gravar aqui, o revive deixava a linha
    // "stopped" com o processo de pé — e excluir o terminal não achava o que parar.
    persist(localId, session.status, session.sessionId ?? null)
    deps.broadcast(statusMsg())
  }

  /**
   * A sessão do projeto que recebe uma tarefa de outro agente: a primeira ativa
   * e não-working (como sempre), restrita por `opts` quando o árbitro escolhe a
   * sessão (`localId`) ou quando um terminal está com aviso aberto (`accept`).
   */
  const pickTaskTarget = (projectId: number, opts?: TaskTarget) => {
    let anyActive = false
    for (const [id, entry] of live) {
      if (entry.projectId !== projectId || !ACTIVE.has(entry.session.status)) continue
      if (opts?.localId !== undefined && id !== opts.localId) continue
      anyActive = true
      if (entry.session.status === 'working') continue
      if (opts?.accept && !opts.accept(entry.engine)) continue
      return { target: entry, anyActive }
    }
    return { target: undefined, anyActive }
  }

  const infoOf = (localId: string): SessionInfo | undefined => {
    const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
    if (!row) return undefined
    const liveEntry = live.get(localId)
    return {
      localId,
      projectId: row.project_id,
      engine: (row.engine ?? DEFAULT_ENGINE_ID) as EngineId,
      status: (liveEntry?.session.status ?? row.status) as SessionStatus,
      engineSessionId: (heldEngineId.has(localId) ? undefined : liveEntry?.session.sessionId) ?? row.claude_session_id,
      updatedAt: row.updated_at,
      model: row.model ?? null,
      permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
      effort: row.effort ?? null,
      backgroundTasks: liveEntry?.session.backgroundTasks ?? [],
      authExpired: liveEntry?.session.authExpired ?? false,
      contextTokens: liveEntry?.contextTokens,
      contextWindow: liveEntry?.contextWindow,
      pendingQuestion: liveEntry?.session.pendingQuestion,
      compactingSince: liveEntry?.session.compactingSince,
      headsUp: liveEntry?.headsUp ?? undefined,
    }
  }

  // Nenhum processo pode estar vivo no momento em que o manager é construído,
  // então quaisquer status ATIVOS persistidos são órfãos de uma execução anterior.
  deps.db.prepare(
    `UPDATE sessions SET status='dead', updated_at=datetime('now') WHERE status IN ('starting','idle','working','needs_attention')`,
  ).run()

  // Handoffs de terminal órfãos: o PTY da execução anterior pode
  // seguir aberto, mas o callback onExit→stopped morreu com o processo antigo.
  // Normaliza para 'stopped' para não travar o projeto (o operador pode Reviver,
  // trazendo o histórico atualizado pelo transcript — consistente com D3).
  deps.db.prepare(
    `UPDATE sessions SET status='stopped', updated_at=datetime('now') WHERE status='in_terminal'`,
  ).run()

  // Prune: mantém apenas as N sessões terminais mais recentes por projeto
  // (as demais dead/stopped são removidas do banco para não crescer sem limite).
  // Não apaga transcripts — a mais recente por projeto sempre fica (revive/histórico).
  const keep = deps.keepSessionsPerProject ?? 5
  deps.db.prepare(
    `DELETE FROM sessions
     WHERE status IN ('dead','stopped')
       AND local_id NOT IN (
         SELECT local_id FROM (
           SELECT local_id,
                  ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, local_id DESC) AS rn
           FROM sessions WHERE status IN ('dead','stopped')
         ) WHERE rn <= ?
       )`,
  ).run(keep)

  return {
    start(project: Project, opts?: { continueLatest?: boolean; permissionMode?: PermissionMode; model?: string; engine?: string; effort?: string; forkSource?: ForkSource }): SessionInfo {
      const engine = (opts?.engine ?? DEFAULT_ENGINE_ID) as EngineId
      for (const [id, entry] of live) {
        if (entry.projectId === project.id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new UserError('session_already_active', `projeto ${project.name} já possui sessão ativa (${id})`, { project: project.name })
        }
      }
      const inTerm = deps.db.prepare(
        `SELECT 1 FROM sessions WHERE project_id=? AND engine=? AND status='in_terminal' LIMIT 1`,
      ).get(project.id, engine)
      if (inTerm) throw new UserError('session_in_terminal', `projeto ${project.name} tem uma sessão aberta no terminal`, { project: project.name })
      // Em pasta compartilhada não existe "--continue desta pasta": a conversa
      // mais recente pode ser a do vizinho, e não há flag que saiba excluí-la. A
      // regra é uniforme para todos os cards da pasta, sem card privilegiado —
      // privilegiar o mais antigo não funcionaria, porque assim que o vizinho
      // conversa é a conversa DELE que o --continue traria.
      const shared = isSharedPath(deps.db, project.id)
      // O ramo (`/fork`) abre como cópia da origem: nem retoma nem continua.
      const forkSource = opts?.forkSource
      const forkPlan = forkSource ? forkPlanOf(forkSource, project.path) : undefined
      const continueLatest = shared || forkSource ? false : !!opts?.continueLatest
      const sharedResume = shared && opts?.continueLatest
        ? ownResume(project.id, engine, project.path)
        : undefined
      const permissionMode = opts?.permissionMode ?? 'bypassPermissions'
      const model = opts?.model || undefined
      const localId = randomUUID()
      // Cria a sessão ANTES do INSERT: makeSession resolve a engine pelo registry
      // (lança 'unknown_engine' se não registrada). Falhar aqui não deixa linha
      // órfã no banco. O construtor é inerte — nada spawna até wire()→start().
      const session = makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: forkSource ? undefined : sharedResume,
        continueLatest: shared || forkSource ? false : opts?.continueLatest,
        permissionMode,
        model,
        effort: opts?.effort,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id, engine } : undefined,
        ...forkPlan,
      })
      // O id vai no INSERT (e não só quando a engine anunciar): é o que faz o
      // effectiveEngineSessionId conhecê-lo de imediato, e com ele a prévia do
      // chat mostra a conversa retomada antes da primeira mensagem.
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, engine, status, permission_mode, model, continue_latest, effort, claude_session_id, fork_source) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`,
      ).run(localId, project.id, engine, permissionMode, model ?? null, continueLatest ? 1 : 0, opts?.effort ?? null,
        forkSource?.sessionId ?? sharedResume ?? null, forkSource ? JSON.stringify(forkSource) : null)
      wire(localId, project.id, engine, session)
      return infoOf(localId)!
    },

    /** Clique num botão do aviso: vai ao plugin, que redesenha (ou tira) o cartão. */
    async pressHeadsUp(localId: string, press: HeadsUpPress): Promise<void> {
      const ctl = live.get(localId)?.headsUpCtl
      if (!ctl) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      await ctl.press(press)
    },

    /** Interruptor dos avisos de um terminal: anexa ou solta a superfície das sessões vivas dele. */
    async setHeadsUp(projectId: number, on: boolean): Promise<void> {
      const entries = [...live.values()].filter((e) => e.projectId === projectId && e.setHeadsUp)
      await Promise.all(entries.map((e) => e.setHeadsUp!(on).catch(() => {})))
    },

    /**
     * Mensagem do operador. `echo`: a sessão emite também o evento `user`, para a
     * mensagem aparecer no chat quando não foi digitada nele (ex.: item da fila).
     * `queued`: vem da fila do operador (repassado ao `onOperatorMessage`).
     */
    send(localId: string, text: string, opts?: { echo?: boolean; queued?: boolean }): void {
      const entry = live.get(localId)
      if (!entry) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      // O /goal tratado pelo Claudinei não vai à sessão nem conta como mensagem do operador.
      if (deps.interceptCommand && typeof text === 'string' && GOAL_COMMAND.test(text.trim())) {
        if (deps.interceptCommand({ projectId: entry.projectId, engine: entry.engine, localId }, text)) return
      }
      if (typeof text === 'string' && text.trim() === '/compact') {
        if (!entry.session.compact) throw new UserError('engine_no_compact', 'esta engine não oferece compactação no chat')
        if (!['idle', 'needs_attention'].includes(entry.session.status)) throw new UserError('wait_turn_to_compact', 'aguarde o turno terminar para compactar')
        entry.session.compact()
        entry.compactTurn = true
      } else sendVia(entry, localId, text, 'operator', (t) => opts?.echo ? entry.session.send(t, { echoToClients: true }) : entry.session.send(t))
      entry.origin = 'operator'
      // Só depois do envio aceito: mensagem recusada não conta como o operador agindo.
      try { deps.onOperatorMessage?.(entry.projectId, entry.engine, { queued: !!opts?.queued, localId, text }) } catch {}
    },

    /**
     * Mensagem do próprio Claudinei (ex.: a retomada depois do reinício): aparece
     * no chat como a do operador, mas não dispara onOperatorMessage.
     */
    sendAsClaudinei(localId: string, text: string): void {
      const entry = live.get(localId)
      if (!entry) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      sendVia(entry, localId, text, 'claudinei', (t) => entry.session.send(t, { echoToClients: true }))
      entry.origin = 'claudinei'
    },

    /** O serviço vai parar: daqui em diante, sessão que para foi derrubada pelo reinício. */
    beginShutdown(): void {
      shuttingDown = true
    },

    isShuttingDown,

    /**
     * A auto-compactação foi decidida no último result e ainda não abriu o
     * turno dela: a sessão parece livre, mas o lugar 1 vem antes. O `isFree` do
     * árbitro do próximo envio consulta isto (um cutucão na mesma folga não
     * pode passar na frente da compactação).
     */
    compactionPending(localId: string): boolean {
      return !!live.get(localId)?.compactPending
    },

    /** Início (epoch ms) do turno em curso da sessão viva; ausente fora de um turno. */
    turnStartedAt(localId: string): number | undefined {
      return live.get(localId)?.turnStartedAt
    },

    /**
     * Acompanha o turno da sessão e fecha com o result dele, como o dispatchTask.
     * Serve para reanexar uma tarefa encaminhada depois do boot. Devolve false se
     * a sessão não está viva (nada a acompanhar). Sem `timeoutMs`, sem prazo.
     */
    watchTurn(localId: string, onComplete: (status: 'completed' | 'failed', result: string) => void, timeoutMs?: number): boolean {
      const entry = live.get(localId)
      if (!entry) return false
      watchTask(entry.session, timeoutMs, turnCtx, onComplete)
      return true
    },

    markRead(localId: string): void {
      live.get(localId)?.session.markRead()
    },

    async interrupt(localId: string): Promise<void> {
      const entry = live.get(localId)
      if (!entry) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      // O result do turno interrompido chega antes de o interrupt() resolver ou,
      // se a sessão já fechou o turno, é descartado por ela como póstumo. Nos
      // dois casos a marca pode sair no fim.
      interrupting.add(localId)
      // Só um turno em curso tem o que interromper: fora dele, a marca cairia
      // no turno seguinte.
      // Um segundo Esc no mesmo turno não troca a origem guardada pelo primeiro.
      if (entry.session.status === 'working' && !interruptedTurn.has(localId)) interruptedTurn.set(localId, entry.origin)
      try {
        await entry.session.interrupt()
      } catch (err) {
        // O pedido falhou e o turno segue: ele não foi interrompido.
        if (entry.session.status === 'working') interruptedTurn.delete(localId)
        throw err
      } finally {
        interrupting.delete(localId)
      }
    },

    async stop(localId: string): Promise<void> {
      await live.get(localId)?.session.stop()
    },

    /**
     * Para UM subagente de background sem tocar no resto da sessão. Só o Claude
     * Code tem esse conceito; nas outras engines o método não existe e a chamada
     * vira no-op.
     */
    /** Inicia o fluxo OAuth de reautenticação da sessão (só Claude). */
    async startAuth(localId: string): Promise<{ manualUrl: string; automaticUrl: string }> {
      const session = live.get(localId)?.session
      if (!session?.startAuth) throw new UserError('engine_no_reauth', 'esta engine não suporta reautenticação')
      return session.startAuth()
    },

    /** Fecha o fluxo com o código/URL que o operador trouxe do navegador. */
    async completeAuth(localId: string, codeOrUrl: string): Promise<void> {
      const session = live.get(localId)?.session
      if (!session?.completeAuth) throw new UserError('engine_no_reauth', 'esta engine não suporta reautenticação')
      await session.completeAuth(codeOrUrl)
    },

    /** Responde a pergunta (AskUserQuestion) que a sessão está esperando — só Claude. */
    answerQuestion(localId: string, answers: Record<string, string>): void {
      const session = live.get(localId)?.session
      if (!session) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      if (!session.answerQuestion) throw new UserError('engine_no_questions', 'esta engine não faz perguntas estruturadas')
      session.answerQuestion(answers)
    },

    /** Nega a pergunta pendente: o operador vai responder em prosa pela caixa de mensagem. */
    dismissQuestion(localId: string): void {
      const session = live.get(localId)?.session
      if (!session) throw new UserError('session_not_active', `sessão ${localId} não está ativa`)
      if (!session.dismissQuestion) throw new UserError('engine_no_questions', 'esta engine não faz perguntas estruturadas')
      session.dismissQuestion()
    },

    async stopBackgroundTask(localId: string, taskId: string): Promise<void> {
      const session = live.get(localId)?.session as { stopTask?: (id: string) => Promise<void> } | undefined
      await session?.stopTask?.(taskId)
    },

    revive(localId: string): SessionInfo {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new UserError('session_not_found', `sessão ${localId} não existe`)
      const engine = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      const cur = live.get(localId)
      const effective = cur?.session.status ?? (row.status as SessionStatus)
      if (ACTIVE.has(effective)) throw new UserError('session_still_active', `sessão ${localId} ainda está ativa`)
      if (effective === 'in_terminal') throw new UserError('session_open_in_terminal', `sessão ${localId} está aberta no terminal`)
      for (const [id, entry] of live) {
        if (entry.projectId === row.project_id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new UserError('project_has_active_session', `projeto já possui sessão ativa (${id})`)
        }
      }
      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new UserError('session_project_gone', 'projeto da sessão não existe mais')
      // Fantasma (transcript sumiu) é descartado aqui também: sem isto, reviver o
      // chat caía no mesmo "No conversation found" do terminal.
      // Ramo antes do primeiro turno gravar a cópia: copia de novo da origem.
      const forkSource = parseForkSource(row.fork_source)
      let reviveResume = forkSource ? null : resolveResume(engine, project.path, localId, row.claude_session_id ?? null)
      // Sem conversa própria para retomar (--resume), preserva a intenção
      // original: sessão nascida com --continue revive continuando a última
      // conversa da pasta — não uma conversa nova em branco.
      let reviveContinue: boolean | undefined = forkSource ? false : reviveResume ? undefined : row.continue_latest !== 0
      if (!forkSource && !reviveResume && isSharedPath(deps.db, row.project_id)) {
        // Em pasta compartilhada, "a última da pasta" é uma resposta errada:
        // tenta o thread deste projeto e, sem ele, abre conversa nova.
        reviveResume = ownResume(row.project_id, engine, project.path) ?? null
        reviveContinue = false
      }
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: reviveResume ?? undefined,
        continueLatest: reviveContinue,
        permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        hermes: deps.hermes ? { ...deps.hermes, projectId: row.project_id, engine } : undefined,
        ...(forkSource ? forkPlanOf(forkSource, project.path) : {}),
      }))
      return infoOf(localId)!
    },

    /** A sessão viva do terminal (o desfazer lê dela o motor e o id da conversa). */
    liveSession(localId: string): EngineSession | undefined {
      return live.get(localId)?.session
    },

    /**
     * Volta da conversa pendente: o terminal foi relançado com o id segurado
     * (holdEngineId) e o primeiro result ainda não chegou, ou com awaitInit e o
     * init ainda não chegou. Até lá o id que o manager mostra é o antigo, do
     * banco; o ramificar (`/side`, `/fork`, ⇄) copiaria a conversa de antes da
     * volta, então recusa com `rewind_pending`.
     */
    rewindPending(localId: string): boolean {
      return heldEngineId.has(localId) || awaitingInit.has(localId)
    },

    /**
     * Para a sessão viva (se houver) e sobe outra no MESMO terminal, retomando
     * `resumeSessionId` (null = conversa nova) com `extraArgs` no fim do argv. É
     * como o desfazer volta a conversa do Claude. `holdEngineId`: o id novo só
     * chega ao banco e à web no primeiro result (veja heldEngineId).
     * `awaitInit`: a volta fica pendente (rewindPending) até o init, sem segurar
     * a gravação do id (veja awaitingInit).
     */
    async relaunch(localId: string, opts: { resumeSessionId: string | null; extraArgs?: string[]; holdEngineId?: boolean; awaitInit?: boolean }): Promise<SessionInfo> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new UserError('session_not_found', `sessão ${localId} não existe`)
      if (row.status === 'in_terminal') throw new UserError('session_open_in_terminal', `sessão ${localId} está aberta no terminal`)
      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new UserError('session_project_gone', 'projeto da sessão não existe mais')
      // O id vai como argv: mesma defesa do resolveResume.
      if (opts.resumeSessionId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.resumeSessionId)) throw new Error('id de sessão inválido')
      const engine = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      const cur = live.get(localId)
      if (cur) {
        await cur.session.stop()
        live.delete(localId)
      }
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: opts.resumeSessionId ?? undefined,
        continueLatest: false,
        permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        hermes: deps.hermes ? { ...deps.hermes, projectId: row.project_id, engine } : undefined,
        extraArgs: opts.extraArgs,
      }), { holdEngineId: opts.holdEngineId, awaitInit: opts.awaitInit })
      return infoOf(localId)!
    },

    async setSessionOptions(localId: string, opts: { model?: string; permissionMode?: PermissionMode; effort?: string }): Promise<SessionInfo> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new UserError('session_not_found', `sessão ${localId} não existe`)
      const catalog = getEngine(row.engine ?? DEFAULT_ENGINE_ID).capabilities()
      const selectedModel = (opts.model ?? row.model) || catalog.defaultModel || ''
      const modelOptions = catalog.modelOptions?.[selectedModel]
      if (modelOptions) {
        if (opts.effort && opts.effort !== 'auto' && !modelOptions.efforts.includes(opts.effort)) {
          throw new UserError('effort_not_supported', `effort ${opts.effort} não é suportado por ${selectedModel}`, { effort: opts.effort, model: selectedModel })
        }
        // Trocar Astra/ultra por Luna, por exemplo, precisa retirar o override
        // incompatível do próximo turno E do banco (inclusive no revive).
        if (opts.model !== undefined && opts.effort === undefined && row.effort
          && !modelOptions.efforts.includes(row.effort)) {
          opts = { ...opts, effort: modelOptions.defaultEffort }
        }
      }
      const entry = live.get(localId)
      if (entry) {
        // Hot-swap de model/permission exige turno parado (control_request no meio
        // do turno não vale). Effort NÃO entra no guard: é no-op no Claude (aplicado
        // via mensagem /effort) e um campo p/ o PRÓXIMO turno nas engines turn-based —
        // e o próprio /effort põe a sessão em working um instante antes do PATCH.
        // Com o guard total, o effort nunca persistia: o PATCH era recusado aqui e o
        // front engolia o erro → refresh voltava ao default.
        if ((opts.model !== undefined || opts.permissionMode) && entry.session.status === 'working') {
          throw new UserError('session_busy', 'sessão está trabalhando; aguarde o turno terminar')
        }
        // model !== undefined inclui '' (voltar ao Padrão): as engines turn-based
        // tratam '' como "sem -m no próximo turno"; no Claude o protocolo não tem
        // reset, então o setModel('') é no-op no processo vivo (vale no relaunch).
        if (opts.model !== undefined) await entry.session.setModel(opts.model)
        if (opts.permissionMode) await entry.session.setPermissionMode(opts.permissionMode)
        if (opts.effort !== undefined) await entry.session.setEffort(opts.effort === 'auto' ? '' : opts.effort)
      }
      // '' = limpar (Padrão): COALESCE não distingue "limpar" de "não tocar",
      // então o model tem update próprio com NULLIF.
      if (opts.model !== undefined) {
        deps.db.prepare(`UPDATE sessions SET model = NULLIF(?, ''), updated_at = datetime('now') WHERE local_id = ?`).run(opts.model, localId)
      }
      deps.db.prepare(
        `UPDATE sessions SET permission_mode = COALESCE(?, permission_mode), updated_at = datetime('now') WHERE local_id = ?`,
      ).run(opts.permissionMode ?? null, localId)
      if (opts.effort !== undefined) {
        // 'auto' limpa (volta ao padrão do modelo); a aplicação ao processo vivo é
        // feita pelo front via mensagem /effort — aqui só persistimos p/ o relaunch
        deps.db.prepare(`UPDATE sessions SET effort = ?, updated_at = datetime('now') WHERE local_id = ?`)
          .run(opts.effort === 'auto' ? null : opts.effort, localId)
      }
      const info = infoOf(localId)!
      // pendingQuestion (e os outros campos só-memória abaixo) precisam vir aqui:
      // o guard de `working` acima não cobre effort, então este broadcast é
      // alcançável com uma AskUserQuestion pendente (operador troca o effort
      // enquanto uma pergunta está aberta) — e o store não tem fallback: campo
      // ausente é lido como "nenhuma pendência", derrubando o painel na cara do
      // operador enquanto a CLI ainda está bloqueada esperando resposta.
      deps.broadcast({
        type: 'session_status', localId, projectId: row.project_id, engine: info.engine, status: info.status,
        engineSessionId: info.engineSessionId, model: info.model, permissionMode: info.permissionMode, effort: info.effort,
        backgroundTasks: info.backgroundTasks, authExpired: info.authExpired, contextTokens: info.contextTokens, contextWindow: info.contextWindow,
        pendingQuestion: info.pendingQuestion, compactingSince: info.compactingSince,
      })
      return info
    },

    async openInTerminal(localId: string): Promise<SessionInfo & { token: string }> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new UserError('session_not_found', 'sessão não existe')
      if (row.status === 'in_terminal') throw new UserError('already_in_terminal', 'esta sessão já está aberta no terminal')
      if (!deps.terminalLauncher) throw new Error('terminal launcher não configurado')

      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new UserError('session_project_gone', 'projeto da sessão não existe mais')

      // A engine resolve file/args do terminal interativo — para o Claude,
      // isso reproduz exatamente o que era montado inline antes (--resume +
      // --dangerously-skip-permissions sempre, já que toda sessão nasce com
      // essa flag, Task 1); Codex/outras engines resolvem o próprio comando.
      const engineId = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      // Id da conversa a retomar: o persistido no banco ou, se ausente (turno que não
      // chegou a gravar o id, servidor antigo, ou processo morto no meio), o último
      // thread desta pasta lido do storage da engine (rollouts do Codex / sessões do
      // Claude) — assim o terminal RETOMA a conversa em vez de abrir em branco. Sem
      // nenhum → sessão nova (fresh).
      // Descarta um id cujo transcript não existe mais (senão --resume morre); só
      // então cai para o último thread real da pasta, ou fresh.
      let resumeId: string | null = resolveResume(engineId, project.path, localId, row.claude_session_id ?? null)
      if (!resumeId) {
        try {
          const eng = getEngine(engineId)
          // O storage da engine muda fora do Claudinei (TUI cria sessão só na 1ª
          // mensagem): sem invalidar o cache, retomaríamos um id de até 30 s atrás.
          eng.invalidateLatestConversation?.(project.path)
          // Sem o exclude, "a última conversa desta pasta" seria a do terminal
          // vizinho — que é justamente o caso em que ele acabou de conversar.
          resumeId = eng.latestConversationId(project.path, foreignThreadIds(deps.db, row.project_id, engineId))
        } catch { resumeId = null }
      }
      // Defesa: o id vai como argv — exige começar com alfanumérico (barra flags
      // "-x") e só chars seguros.
      if (resumeId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(resumeId)) {
        throw new Error('id de sessão inválido')
      }
      const { file, args, env } = getEngine(engineId).terminalCommand({
        resumeSessionId: resumeId,
        projectPath: project.path,
      })

      const entry = live.get(localId)
      if (entry) {
        await entry.session.stop()
        live.delete(localId)
      }

      // Persiste o id recuperado (COALESCE não sobrescreve com null): uma sessão que
      // retomou via fallback passa a conhecer o próprio thread nas próximas aberturas.
      persist(localId, 'in_terminal', resumeId)
      try { deps.turnObserver?.onInteractive({ localId, projectId: row.project_id, engine: engineId }, 'open') } catch (err) { console.error('[manager] onInteractive do desfazer falhou', err) }
      // Sem pendingQuestion aqui de propósito: `stop()` acima só resolve depois do
      // 'close' do processo, e o handler desse 'close' já zera `this.pending` ANTES
      // de resolver (session.ts) — e `live.delete` já tirou a sessão do mapa. Não
      // há como uma pendência sobreviver até este ponto.
      deps.broadcast({
        type: 'session_status',
        localId,
        projectId: row.project_id,
        engine: row.engine ?? DEFAULT_ENGINE_ID,
        status: 'in_terminal',
        engineSessionId: resumeId,
      })

      let token: string
      try {
        token = deps.terminalLauncher({
          localId,
          cwd: project.path,
          file,
          args,
          env,
          // Heurística de atividade do TUI: broadcast efêmero (não persiste) — a
          // sidebar mostra "no terminal · processando/esperando você" ao vivo.
          onActivity: (activity) => {
            const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
            if (cur?.status !== 'in_terminal') return
            deps.broadcast({ type: 'terminal_activity', localId, projectId: row.project_id, activity })
          },
          onExit: () => {
            const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
            if (cur?.status === 'in_terminal') {
              // O TUI (claude --resume / codex resume) grava a conversa num
              // transcript NOVO — o id de antes do terminal ficou velho e o chat
              // web voltaria sem o que aconteceu lá. Re-resolve o último thread
              // da pasta e persiste: o histórico do chat passa a refletir o
              // terminal assim que a UI recarrega pela troca de engineSessionId.
              // (OpenCode continua no MESMO id — quem força a rebusca lá é a
              // invalidação do historyLoadedFor na volta do terminal, no web.)
              let latest: string | null = null
              try {
                const eng = getEngine(engineId)
                // O TUI ACABOU de gravar no storage da engine: sem invalidar o
                // cache (OpenCode cacheia por 30 s), releríamos o id de antes do
                // terminal e o chat não veria o que foi conversado lá.
                eng.invalidateLatestConversation?.(project.path)
                latest = eng.latestConversationId(project.path, foreignThreadIds(deps.db, row.project_id, engineId))
              } catch { latest = null }
              // `?? resumeId`: nada achado significa "não sei", não "adote o que
              // apareceu". Era aqui que o id do vizinho entrava no banco de forma
              // permanente — os outros pontos só mostravam conversa alheia.
              const nextId = latest ?? resumeId
              persist(localId, 'stopped', nextId)
              try { deps.turnObserver?.onInteractive({ localId, projectId: row.project_id, engine: engineId }, 'close') } catch (err) { console.error('[manager] onInteractive do desfazer falhou', err) }
              // Sem pendingQuestion aqui: a entrada já saiu de `live` antes do
              // terminal sequer abrir (acima) — não existe sessão viva, única
              // fonte da pendência, neste ponto.
              deps.broadcast({
                type: 'session_status',
                localId,
                projectId: row.project_id,
                engine: row.engine ?? DEFAULT_ENGINE_ID,
                status: 'stopped',
                engineSessionId: nextId,
              })
            }
          },
        })
      } catch (err) {
        persist(localId, 'stopped', null)
        try { deps.turnObserver?.onInteractive({ localId, projectId: row.project_id, engine: engineId }, 'close') } catch (e) { console.error('[manager] onInteractive do desfazer falhou', e) }
        // Mesmo motivo do broadcast acima: a entrada já saiu de `live` antes do
        // launcher ser sequer chamado — sem sessão viva não há pendência.
        deps.broadcast({
          type: 'session_status',
          localId,
          projectId: row.project_id,
          engine: row.engine ?? DEFAULT_ENGINE_ID,
          status: 'stopped',
          engineSessionId: resumeId,
        })
        throw err
      }

      return { ...infoOf(localId)!, token }
    },

    list(): SessionInfo[] {
      const rows = deps.db.prepare('SELECT local_id, project_id, engine FROM sessions ORDER BY updated_at DESC').all() as any[]
      const keep = new Set<string>()
      // Dedup por (projeto, ENGINE), não por projeto: com 1 Claude + 1 Codex no mesmo
      // projeto, se ambos saem do `live` (ex.: os dois in_terminal, ou ambos stopped),
      // deduplicar por projeto some com a engine mais antiga — a aba dela vira "No
      // Session" e o ▶ tenta iniciar e falha calado (a outra engine já está in_terminal).
      const seenPerEngine = new Set<string>()
      for (const r of rows) {
        const key = `${r.project_id}:${r.engine ?? DEFAULT_ENGINE_ID}`
        if (!seenPerEngine.has(key)) { seenPerEngine.add(key); keep.add(r.local_id) }
      }
      for (const localId of live.keys()) keep.add(localId)
      return [...keep].map((id) => infoOf(id)!).filter(Boolean)
    },

    get: infoOf,

    hasActiveSession(projectId: number): boolean {
      for (const [, entry] of live) {
        if (entry.projectId === projectId && ACTIVE.has(entry.session.status)) return true
      }
      return false
    },

    /**
     * Sessão ativa do projeto E não-working — livre para receber a próxima entrega da fila.
     * `opts` restringe a escolha: `localId`, só aquela sessão; `accept`, só os motores aceitos.
     */
    hasFreeSession(projectId: number, opts?: TaskTarget): boolean {
      return !!pickTaskTarget(projectId, opts).target
    },

    async stopAll(): Promise<void> {
      await Promise.all([...live.values()].map((e) => e.session.stop()))
    },

    /**
     * `opts.accept` restringe os motores, como no `dispatchTask`: terminal com
     * aviso aberto esperando o operador não recebe a pergunta. Se a única sessão
     * livre for de um terminal recusado, falha na hora com o motivo.
     */
    askAgent(toProjectId: number, fromLabel: string, question: string, timeoutMs = 120_000, opts?: Pick<TaskTarget, 'accept'>): Promise<string> {
      let target: { session: EngineSession; projectId: number; engine: EngineId; origin: LimitOrigin } | undefined
      let anyActive = false
      let held = false
      for (const [, entry] of live) {
        if (entry.projectId !== toProjectId || !ACTIVE.has(entry.session.status)) continue
        anyActive = true
        // Pula sessões ocupadas: com 2 engines no mesmo projeto (uma working,
        // outra idle), a entrega vai para a livre — não falha com "busy".
        if (entry.session.status === 'working') continue
        if (opts?.accept && !opts.accept(entry.engine)) { held = true; continue }
        target = entry
        break
      }
      if (!target) {
        return Promise.reject(new Error(held
          ? 'target terminal has a notice open waiting for the operator (interrupted by a restart, or usage limit); '
            + 'it cannot answer now — use dispatch_task instead, the task waits until the operator clears the notice'
          : anyActive
            ? 'target agent is busy; try again shortly'
            : 'target project has no active session'))
      }
      const session = target.session

      const waited = waitForResult(session, timeoutMs, turnCtx)
      try {
        sendVia(target, idOf(target), `[Question from agent of ${fromLabel}]: ${question}`, 'task', (t) => session.send(t))
      } catch (err) {
        waited.catch(() => {}) // envio recusado (ex.: undo_writing): ninguém espera mais este turno, e a recusa tardia derrubaria o processo
        return Promise.reject(err as Error)
      }
      target.origin = 'task'
      return waited
    },

    /**
     * Manda um texto para UMA sessão específica e, opcionalmente, espera a resposta
     * final do turno. É o que o agendador usa: ele sabe exatamente em qual sessão
     * quer falar (a engine está no agendamento), então não serve a escolha
     * automática de alvo que o askAgent faz.
     */
    sendAndWait(localId: string, text: string, opts?: { timeoutMs?: number; wait?: boolean }): Promise<string | null> {
      const entry = live.get(localId)
      if (!entry) return Promise.reject(new Error(`sessão ${localId} não está ativa`))
      const waited = opts?.wait === false ? null : waitForResult(entry.session, opts?.timeoutMs ?? 1_800_000, turnCtx)
      try {
        sendVia(entry, localId, text, 'schedule', (t) => entry.session.send(t, { echoToClients: true }))
      } catch (err) {
        waited?.catch(() => {}) // mesmo cuidado do askAgent
        return Promise.reject(err as Error)
      }
      entry.origin = 'schedule'
      return waited ?? Promise.resolve(null)
    },

    /**
     * Devolve a engine da sessão que recebeu a task (ou null se a entrega falhou na hora).
     * Sem `timeoutMs`, a tarefa não tem prazo: fecha com o result do turno ou como
     * falha quando a sessão alvo morre ou para.
     */
    dispatchTask(
      toProjectId: number,
      fromLabel: string,
      description: string,
      onComplete: (status: 'completed' | 'failed', result: string) => void,
      timeoutMs?: number,
      opts?: TaskTarget,
    ): EngineId | null {
      const { target, anyActive } = pickTaskTarget(toProjectId, opts)
      if (!target) {
        onComplete('failed', anyActive ? 'target agent is busy' : 'target project has no active session')
        return null
      }
      const session = target.session
      const cancel = watchTask(session, timeoutMs, turnCtx, onComplete)

      try {
        // echoToClients: a UI não tem como saber desta mensagem sozinha (o CLI não
        // ecoa e ninguém a inseriu localmente) — sem isso a task só aparecia no
        // chat do terminal-alvo depois de um refresh.
        sendVia(target, idOf(target), `[Task from ${fromLabel}]: ${description}`, 'task', (t) => session.send(t, { echoToClients: true }))
      } catch (err) {
        cancel()
        onComplete('failed', (err as Error).message)
        return null
      }
      target.origin = 'task'
      return target.engine
    },
  }
}

export type SessionManager = ReturnType<typeof createSessionManager>
