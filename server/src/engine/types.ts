import type { BackgroundTask } from '../../../shared/background-tasks.js'
import type { EventEmitter } from 'node:events'
import type { ClaudeEvent } from '../claude/events.js'
import type { SessionStatus, HermesOptions, PendingQuestion } from '../claude/session.js'
import type { ModelCatalog } from '../../../shared/engine-options.js'
import type { HistoryPage, HistoryPageOptions } from '../history-page.js'

/** Id de engine — aberto; a validade é "está registrado no registry?", nunca um union fechado. */
export type EngineId = string

/** Evento normalizado de agente. Hoje idêntico ao shape do Claude; o Codex normaliza para cá (SP-B). */
export type AgentEvent = ClaudeEvent

/** Origem de uma conversa copiada (ramificar a conversa). */
export interface ForkFrom {
  sourceId: string
  /** Claude: `uuid` da entrada do transcript (inclusivo). Codex: `lastTurnId`. Ausente = a conversa toda. */
  cut?: string
  /** OpenCode: pacote a juntar à 1ª mensagem quando a cópia nativa não vale mais. */
  seed?: string
  /** OpenCode: a cópia nativa ainda vale (o original não andou)? Ausente = vale. */
  nativeOk?: () => Promise<boolean>
}

/** Opções genéricas para criar uma sessão de qualquer engine. */
export interface EngineSessionOptions {
  projectPath: string
  resumeSessionId?: string
  continueLatest?: boolean
  model?: string
  effort?: string
  permissionMode?: string
  hermes?: HermesOptions
  /** Binário da engine (Claude: config.claudeBin). Ausente → default da engine. */
  bin?: string
  /** Somente testes: substitui TODOS os args do processo (aponta para o fake). */
  extraArgsOverride?: string[]
  /** Abre a sessão como cópia de outra conversa (ramo ou conversa lateral). */
  forkFrom?: ForkFrom
  /** Sessão só de leitura (conversa lateral). */
  readOnly?: boolean
  /** Sem rastro no disco (Claude: `--no-session-persistence`; Codex: fork `ephemeral`). */
  ephemeral?: boolean
  /** Id da conversa escolhido pelo Claudinei (Claude: `--session-id`). */
  sessionId?: string
  /** Só o Kimi: data root próprio, no lugar do derivado da pasta do projeto. */
  dataRoot?: string
  /**
   * `CLAUDINEI_TERMINAL=<projectId>:<motor>` no ambiente da CLI (ver
   * local-servers/marker.ts). Ausente = a chave sai do ambiente (nunca herda a do serviço).
   */
  terminalMarker?: string
  extraArgs?: string[] // Acrescentados ao argv montado (só o Claude; o desfazer volta a conversa com eles).
}

/** Uma sessão viva. EventEmitter: o manager assina 'status' e 'event' e chama start(). */
export interface EngineSession extends EventEmitter {
  status: SessionStatus
  sessionId?: string
  readonly lastStderr: string
  /**
   * Tarefas em background ainda rodando (agentes e processos de shell). Só o Claude Code tem esse conceito
   * hoje; nas outras engines fica ausente.
   */
  readonly backgroundTasks?: BackgroundTask[]
  /** Credencial expirada (só Claude): a UI oferece reautenticar em vez de mais um erro. */
  readonly authExpired?: boolean
  /**
   * O último turno bateu no limite de uso (só Claude). `resetsAt` em epoch
   * SEGUNDOS, null = horário desconhecido. Lido pelo manager no result.
   */
  readonly usageLimit?: { resetsAt: number | null }
  /** Fluxo OAuth de reautenticação — só o Claude Code expõe. */
  startAuth?(): Promise<{ manualUrl: string; automaticUrl: string }>
  completeAuth?(codeOrUrl: string): Promise<void>
  /**
   * Pergunta (AskUserQuestion) que a engine fez e está esperando o operador —
   * só o Claude Code tem isso. Estado do processo vivo, publicado no SessionInfo.
   */
  readonly pendingQuestion?: PendingQuestion
  /** Epoch ms do início da compactação de contexto em curso; ausente = não está compactando. */
  readonly compactingSince?: number
  /** Compactação nativa; reserva a sessão sincronamente, como send(). */
  compact?(): void
  /** Responde a pergunta pendente (`answers` chaveado pelo texto da pergunta) / nega para responder em prosa. */
  answerQuestion?(answers: Record<string, string>): void
  dismissQuestion?(): void
  start(): void
  /**
   * `echoToClients`: emite também um evento `user` com o mesmo texto, para a UI
   * mostrar a mensagem na hora. Usado quando quem envia é o SERVIDOR (task de outro
   * terminal): nenhuma engine devolve a mensagem que recebe, e a UI só desenha o que
   * ela própria inseriu ao digitar — sem o eco, a mensagem só aparece num refresh.
   */
  send(text: string, opts?: { echoToClients?: boolean }): void
  markRead(): void
  interrupt(): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setEffort(effort: string): Promise<void>
  stop(): Promise<void>
}

export interface EngineCapabilities extends ModelCatalog {
  contextManagement?: boolean
  permissions: string[]
  slashSource: 'protocol' | 'curated' | 'none'
  label: string
  icon: string
  slashCommands: string[]
  /** Comando de instalação da CLI (mostrado na UI quando o binário não está no PATH). */
  installHint?: string
  /**
   * A sessão aceita mensagem no meio do turno (entra no turno atual). Sem o
   * campo, vale `false`: no meio do turno, a mensagem vai para a fila e o
   * "enviar agora" interrompe o turno para mandar.
   */
  midTurnInput?: boolean
  /**
   * Como a engine copia uma conversa: `'native'` (a CLI copia) ou `'seed'` (o
   * Claudinei monta um pacote com o histórico). Ausente = não copia.
   */
  fork?: 'native' | 'seed'
}

/** Uma engine (registrada uma vez). */
export interface Engine {
  id: EngineId
  /** Binário da CLI desta engine (resolvido de env) — usado p/ sondar disponibilidade no PATH. */
  bin(): string
  createSession(opts: EngineSessionOptions): EngineSession
  /** Pode ser assíncrono: históricos grandes (transcript de 30 MB, `opencode export`) não podem bloquear o event loop. */
  readHistory(projectPath: string, engineSessionId: string): AgentEvent[] | Promise<AgentEvent[]>
  /**
   * Uma página do histórico, lida de trás para a frente a partir de um byte do
   * arquivo da engine, com a posição de cada evento. Opcional: sem ela, quem
   * pagina (history-page.ts) usa o `readHistory` numerado pelo índice.
   */
  readHistoryPage?(projectPath: string, engineSessionId: string, opts: HistoryPageOptions): Promise<HistoryPage>
  /**
   * O id da conversa mais recente desta pasta, no storage da engine.
   *
   * `exclude` são conversas que pertencem a OUTRO terminal da mesma pasta. Duas
   * entradas da sidebar podem apontar para o mesmo diretório, e o storage da
   * engine é indexado por diretório: sem descartar os ids alheios, cada terminal
   * retomaria a conversa do vizinho. Quem chama sem o parâmetro — e toda pasta
   * com um único terminal — vê o comportamento de sempre.
   */
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null
  /**
   * Descarta o cache interno de `latestConversationId` desta pasta (opcional).
   * O manager chama antes de resolver o thread na ABERTURA e na SAÍDA do
   * terminal — são os momentos em que o storage da engine acabou de mudar
   * (o TUI cria/atualiza sessões lá), e um id cacheado apontaria para uma
   * conversa anterior ao terminal.
   */
  invalidateLatestConversation?(projectPath: string): void
  /**
   * Uma conversa específica ainda existe no storage da engine?
   *
   * Opcional: engine que não implementa faz o manager confiar no id do banco
   * como antes. O Claude implementa porque é onde um id fantasma vira erro fatal
   * de `--resume`. Ver SessionManager.resolveResume.
   */
  conversationExists?(projectPath: string, id: string): boolean
  /**
   * Onde está a conversa no storage da engine (caminho do arquivo, ou o comando
   * que a exporta), para o operador conferir. null = não achou.
   */
  transcriptRef?(projectPath: string, id: string): string | null
  /**
   * Comando do terminal interativo. resumeSessionId ausente/null → sessão NOVA (fresh), sem retomar.
   * `env` (opcional) é MESCLADO ao ambiente do PTY — o Kimi precisa disso para abrir
   * no mesmo data root (KIMI_CODE_HOME) das sessões do chat.
   */
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }): { file: string; args: string[]; env?: Record<string, string> }
  capabilities(): EngineCapabilities
  /** Atualiza metadados sem abrir conversa (ex.: model/list do Codex). */
  refreshCapabilities?(): Promise<void>
}
