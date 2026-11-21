import type { BackgroundTask } from '../../shared/background-tasks.js'
import type { ModelCatalog } from '../../shared/engine-options'

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead' | 'in_terminal'

export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface Project {
  id: number; name: string; path: string; color: string; icon: string; favorite?: boolean; headsUp?: boolean; groupId?: number | null; sectorId?: number | null; sortOrder?: number
  /** Motores do terminal (ids, em ordem canônica); só eles ganham aba. Ver terminalEngines.ts. */
  engines?: string[]
  /** Ramo (`/fork`): o terminal de onde veio a cópia; null quando não é ramo ou o original sumiu. */
  forkedFrom?: number | null
  /** ISO do corte da cópia do ramo ("cópia até HH:MM"); null quando o motor não diz. */
  forkedCutAt?: string | null
}

export interface SessionInfo {
  localId: string
  projectId: number
  status: SessionStatus
  engineSessionId: string | null
  updatedAt: string
  detail?: string
  model?: string | null
  permissionMode?: PermissionMode
  /** Effort persistido (low..max) ou null/ausente = padrão (auto). */
  effort?: string | null
  /** Engine da sessão ('claude', 'codex', ...); default 'claude' no backend. */
  engine: string
  /** Heurística de atividade do TUI enquanto in_terminal (efêmero, via WS). */
  terminalActivity?: 'working' | 'waiting' | 'idle'
  /**
   * Agentes e processos de shell em background. Processos podem continuar
   * ligados após o turno sem deixar a sessão em working.
   */
  backgroundTasks?: BackgroundTask[]
  /**
   * Credencial do Claude expirada. A partir daqui todo turno falha até
   * reautenticar — a UI oferece o login em vez de mostrar mais um erro de API.
   */
  authExpired?: boolean
  /** Tamanho do contexto (tokens) do último result — alimenta o medidor do chat. Só sessão viva; ausente até o 1º turno. */
  contextTokens?: number
  /** Janela de contexto (tokens) do modelo em uso — o denominador do medidor. Ausente → fallback somente para Claude. */
  contextWindow?: number
  /** Pergunta (AskUserQuestion) esperando você. Ausente = nenhuma. */
  pendingQuestion?: PendingQuestion
  /** Aviso do plugin "You should know" desenhado agora (só Claude vivo). Ausente = nenhum. */
  headsUp?: HeadsUpNode
  /** Compactação de contexto em curso: epoch ms do início. Vem no session_status/snapshot só enquanto dura; ausente = não está compactando. */
  compactingSince?: number
}

/** Metadados + capabilities de uma engine, devolvidos por GET /api/engines. */
export interface EngineMeta extends ModelCatalog {
  contextManagement?: boolean
  id: string
  label: string
  icon: string
  permissions: string[]
  slashSource: 'protocol' | 'curated' | 'none'
  slashCommands: string[]
  /** O binário da CLI está no PATH do servidor? Ausente (fallback embutido) = assume true. */
  available?: boolean
  /** Comando de instalação, mostrado quando available=false. */
  installHint?: string
  /**
   * Enter no meio do turno entra no turno atual (Claude e Codex). Sem isto
   * (Kimi, OpenCode), a mensagem do meio do turno vai para a fila do operador.
   */
  midTurnInput?: boolean
}

export interface ContentBlock {
  type: string; text?: string; thinking?: string
  id?: string; name?: string; input?: unknown
  tool_use_id?: string; content?: unknown
  is_error?: boolean
}

export interface QuestionOption { label: string; description: string }
/** Uma pergunta da AskUserQuestion, como a CLI a manda. */
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
/** Pergunta que o agente fez e está esperando resposta. Estado do processo vivo: vem no session_status/snapshot, nunca do histórico. */
export interface PendingQuestion { toolUseId: string; questions: Question[] }

export interface ApiMessage { role: string; content: ContentBlock[] | string }

/**
 * `pos`: byte de início da linha do evento no arquivo da engine (OpenCode: índice
 * sintético). Só vem do histórico; o ao vivo não tem. É o que dá chave estável aos
 * itens do chat (ver applyEvent.ts).
 */
export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; slashCommands?: string[]; raw: unknown }
  | { kind: 'assistant'; message: ApiMessage; raw: unknown; contextTokens?: number; pos?: number }
  | { kind: 'user'; message: ApiMessage; fromEngine?: boolean; raw: unknown; pos?: number }
  | { kind: 'system'; subtype: string; raw: unknown; pos?: number }
  | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown }
  | { kind: 'raw'; raw: unknown }
  | { kind: 'parse_error'; line: string }
  | { kind: 'stream'; text: string; raw: unknown }
  | { kind: 'context'; contextTokens?: number; contextWindow?: number; raw: unknown }

/** Página do histórico, como a rota `GET /api/sessions/:localId/history` devolve. */
export interface HistoryPage {
  events: ClaudeEvent[]
  /** `pos` do 1º evento devolvido: passado de volta, traz a página anterior. */
  before: number
  /** Chegou ao começo da conversa (byte 0): não há página anterior. */
  atStart: boolean
}

/** Onde a busca achou (iguais aos do servidor, `server/src/history-search.ts`). */
export type SearchField = 'text' | 'thinking' | 'tool_input' | 'tool_output'
/**
 * Uma ocorrência: `pos` é a do evento no arquivo da engine (a mesma das chaves
 * `p<pos>`); `toolUseId` vem nas entradas e saídas de ferramenta.
 */
export interface SearchHit { pos: number; toolUseId?: string; field: SearchField; snippet: string }
/** Uma fatia da busca: `before` é o começo dela, passado de volta para a fatia anterior. */
export interface SearchSlice { hits: SearchHit[]; before: number; atStart: boolean }

/**
 * `parentId`: id do tool_use do Agent que produziu este item — presente só no que
 * veio de um subagente. `fromSubagent` diz QUE veio de um; o parentId diz DE QUAL,
 * que é o que permite acompanhar vários subagentes em paralelo separadamente.
 *
 * `key`: chave estável — `p<pos>[.n]` para o que veio do histórico, `l<n>` para
 * o que chegou ao vivo (provisória até o refetch confirmar). Ver applyEvent.ts.
 */
export type ChatItem = ChatItemBody & { key?: string }

type ChatItemBody =
  // fromEngine: conteúdo que aparece do lado do usuário mas foi injetado pela
  // engine/harness (isMeta, resumo de compact) — não foi digitado pelo operador.
  // compactSummary: o resumo que o CLI injeta após compactar o contexto — vira
  // uma linha recolhida (como o grupo de ações), não uma bolha.
  // preTokens: tamanho do contexto ANTES da compactação, herdado da fronteira
  // (compact_boundary) que antecede o resumo — só o de antes é honesto de mostrar.
  | { kind: 'user_text'; text: string; fromSubagent?: boolean; parentId?: string; fromEngine?: boolean; compactSummary?: boolean; preTokens?: number }
  /**
   * Fronteira de compactação (system/compact_boundary), provisória: nasce com o
   * tamanho anterior do contexto e é absorvida pelo resumo que vem logo depois.
   * Se ficar solta (compactação sem resumo), não desenha nada.
   */
  | { kind: 'compact_boundary'; preTokens?: number; fromSubagent?: boolean; parentId?: string }
  // isApiError: erro interno da API do provedor que o CLI injeta como texto do
  // assistant ("API Error: …") — vira callout de erro, não resposta normal.
  | { kind: 'assistant_text'; text: string; fromSubagent?: boolean; parentId?: string; isApiError?: boolean }
  | { kind: 'thinking'; text: string; fromSubagent?: boolean; parentId?: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown; result?: string; isError?: boolean; fromSubagent?: boolean; parentId?: string }
  /** Slash command digitado no terminal (ex.: /exit), registrado no transcript. */
  | { kind: 'local_command'; command: string; args?: string; fromSubagent?: boolean; parentId?: string }
  /** Saída (stdout/stderr) de um slash command local. */
  | { kind: 'command_output'; text: string; isError?: boolean; fromSubagent?: boolean; parentId?: string }
  /** Nota do sistema injetada no transcript (ex.: task-notification de tarefa em 2º plano). */
  | { kind: 'system_note'; text: string; fromSubagent?: boolean; parentId?: string }
  /**
   * Task despachada por OUTRO terminal (hermes dispatch_task). Entra pelo mesmo
   * canal de uma mensagem digitada — o backend escreve no stdin do CLI —, então no
   * transcript o prefixo `[Task from …]` é o único sinal que sobra de que não foi o
   * operador que escreveu. `from` é o terminal de origem; `text` é o corpo (markdown).
   */
  | { kind: 'task_message'; from: string; text: string; fromSubagent?: boolean; parentId?: string }
  /**
   * Mensagem que um AGENDAMENTO despachou. Chega pelo mesmo canal de uma digitada
   * (o backend escreve no stdin da CLI), então o selo `[Agendamento: <nome> #<n>]`
   * é o único sinal que sobra no transcript de que não foi o operador que escreveu.
   * `run` é o número da execução, que casa com o feed da tela de Agendas.
   */
  | { kind: 'scheduled_message'; name: string; run: number; text: string; fromSubagent?: boolean; parentId?: string }
  /**
   * Mensagem de retomada que o PRÓPRIO Claudinei mandou ao agente: depois de um
   * reinício no meio do turno (`restart`) ou da reabertura da janela do limite de
   * uso (`limit`). Vai em inglês ao agente (como as regras do Hermes); a tela
   * mostra o texto traduzido do motivo, e o selo (`[Claudinei: resume after
   * restart]` ou `[Claudinei: resume after usage limit]`) é o que a separa de uma
   * mensagem digitada. `text` é o corpo em inglês, guardado só para referência.
   */
  | { kind: 'claudinei_message'; reason: 'restart' | 'limit'; text: string; fromSubagent?: boolean; parentId?: string }
  /**
   * Aviso de resultado de tarefa delegada (`[Claudinei: task result]`): o
   * Claudinei acorda o terminal que delegou com o resultado. Várias tarefas
   * saem numa mensagem só, um bloco por tarefa; `tasks` é a lista já separada.
   */
  | { kind: 'claudinei_message'; reason: 'task_result'; text: string; tasks: ClaudineiTaskResult[]; fromSubagent?: boolean; parentId?: string }
  /**
   * "Continue" do goal (`[Claudinei: goal]`), com o critério e o turno. `turn`
   * e `max` ficam ausentes se o texto não casar com o formato conhecido.
   */
  | { kind: 'claudinei_message'; reason: 'goal'; text: string; criterion: string; turn?: number; max?: number; fromSubagent?: boolean; parentId?: string }
  /** Partida do goal (`[Claudinei: goal start]`), com o critério. */
  | { kind: 'claudinei_message'; reason: 'goal_start'; text: string; criterion: string; fromSubagent?: boolean; parentId?: string }
  /**
   * Pacote de contexto da troca de motor (`[Claudinei: context handoff]`):
   * `text` são as mensagens trazidas (sem o cabeçalho); `request`, o pedido do
   * operador que foi junto, quando há.
   */
  | { kind: 'claudinei_message'; reason: 'handoff'; text: string; engineLabel: string; messages: number; tokens: number; request?: string; fromSubagent?: boolean; parentId?: string }

/**
 * Uma tarefa dentro do aviso de resultado: o número, o projeto que a recebeu, o
 * estado e o resultado (markdown). `truncated`: o servidor cortou o resultado e
 * o texto inteiro está em `list_tasks #<id>`.
 */
export interface ClaudineiTaskResult {
  id: number
  project: string
  status: 'completed' | 'failed'
  body: string
  truncated?: boolean
}

/**
 * Um nó do cartão que o plugin "You should know" do Claude desenha (o mesmo que o
 * app Desktop recebe): Box/Text/div/span/b com filhos, Button com o `press` que o
 * plugin entende, Markdown, Link, Code… Strings são texto.
 */
export type HeadsUpNode = string | {
  type: string
  props?: Record<string, unknown>
  children?: HeadsUpNode[]
  press?: { plugin: string; handle: number }
}

/**
 * Reinício sem prejuízo e limite de uso, por terminal (projeto + motor): os
 * interruptores, a marca de turno interrompido pelo reinício do serviço e o
 * limite de uso que o terminal bateu. Espelha `TerminalStateDto`
 * de server/src/restart/terminal-state.ts.
 * - `queued`: na fila para retomar sozinho;
 * - `off`: "retomar" desligado no terminal;
 * - `question`: havia pergunta aberta, que se perdeu (vem em `question`);
 * - `limit`: retomado 3 vezes seguidas sem concluir;
 * - `failed`: a retomada automática falhou.
 */
export type InterruptionReason = 'off' | 'question' | 'limit' | 'failed' | 'queued'
/**
 * Limite de uso que o terminal bateu. `resetsAt` em epoch SEGUNDOS (`null`:
 * reabertura desconhecida). `action`: `none` (só o aviso), `armed` (retoma
 * sozinho 60 s depois da reabertura) ou `snoozed` (aviso escondido até ela).
 */
export type UsageLimitAction = 'none' | 'armed' | 'snoozed'
export interface UsageLimit {
  hitAt: string
  resetsAt: number | null
  action: UsageLimitAction
  origin: 'operator' | 'schedule' | 'task' | 'claudinei'
}
export interface TerminalState {
  projectId: number
  engine: string
  autostart: boolean
  autoResume: boolean
  interruption: null | { at: string; reason: InterruptionReason; question?: Question[] }
  /** "Continuar sozinho quando o limite reabrir" (só o Claude). */
  autoResumeLimit: boolean
  usageLimit: null | UsageLimit
  /** Resultados de tarefas delegadas por este terminal ainda não entregues (só os pendentes). */
  taskResults: { id: number; toProjectName: string; status: 'completed' | 'failed' }[]
  /**
   * Os pendentes estão segurados pela marca do limite de uso: o limite está
   * ativo, ou já saiu e o terminal ainda não voltou a trabalhar.
   */
  taskResultsHeld: boolean
  /** O goal (`/goal`) do terminal; null = sem goal. */
  goal: null | TerminalGoal
}

/**
 * Goal do terminal. `active`: o laço gira; `waiting`: esperando tarefas
 * delegadas; `paused`: parado (motivo em `pause`); `cap`: chegou ao teto de
 * turnos; `done`: o agente declarou cumprido, com `evidence`.
 */
export type GoalStatus = 'active' | 'waiting' | 'paused' | 'cap' | 'done'
export type GoalPause = 'operator' | 'error' | 'limit' | 'interrupt'
export interface TerminalGoal {
  criterion: string
  status: GoalStatus
  pause: GoalPause | null
  turns: number
  max: number
  evidence: string | null
}

/**
 * Triagem da lista, por usuário e projeto. Espelha `TriageDto` de
 * server/src/triage/store.ts. `snoozedUntil` em ISO UTC; o servidor já manda
 * `null` no adiamento vencido, mas um que vença com a página aberta só é visto
 * aqui (ver `triageStateOf`).
 */
export interface TriageItem {
  projectId: number
  pinned: boolean
  settled: boolean
  snoozedUntil: string | null
  /**
   * Posição nos Fixados deste usuário (menor primeiro). Ausente ou `null`: sem
   * pin, ou pin de antes da ordem existir — esses vêm antes, na ordem global.
   */
  pinOrder?: number | null
}

/** Acompanhamento de tarefas longas, por terminal (projeto + motor). Ver server/src/progress.ts. */
export type ProgressStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done'
export interface Progress {
  title: string
  now: { title: string; detail?: string }
  tasks: { name: string; status: ProgressStatus; note?: string }[]
  waiting: string[]
  updatedAt: string
}

/**
 * Fila do operador de um terminal (projeto + motor): mensagens que esperam o
 * próximo turno. Espelha `QueueDto` de server/src/queue/operator-queue.ts.
 * `pauseReason`: erro do turno, interrupção pelo operador, morte da sessão ou
 * pausa à mão. Só "Retomar fila" tira a pausa. O limite de uso não pausa: o
 * aviso do limite segura a fila enquanto está aberto.
 */
export type QueuePauseReason = 'error' | 'interrupted' | 'dead' | 'manual'
/**
 * Como o item entrou na fila: `alt-enter`, enfileirado de propósito (o goal não
 * pausa quando ele sai); `enter-busy`, o Enter com o motor ocupado (Kimi,
 * OpenCode), que sai como mensagem do operador e pausa o goal.
 */
export type QueueVia = 'alt-enter' | 'enter-busy'
export interface QueueItem { id: number; text: string; createdAt: string; via: QueueVia }
export interface OperatorQueue {
  projectId: number
  engine: string
  items: QueueItem[]
  paused: boolean
  pauseReason: QueuePauseReason | null
}
