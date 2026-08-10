export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead' | 'in_terminal'

export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface Project { id: number; name: string; path: string; color: string; icon: string; groupId?: number | null; sortOrder?: number }

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
   * Subagentes despachados com run_in_background que ainda rodam. Eles seguem
   * trabalhando DEPOIS que o turno que os despachou fecha — é o que impede a
   * sessão de parecer parada enquanto ainda há trabalho em curso.
   */
  backgroundTasks?: { id: string; description: string; type: string }[]
}

/** Metadados + capabilities de uma engine, devolvidos por GET /api/engines. */
export interface EngineMeta {
  id: string
  label: string
  icon: string
  models: string[]
  efforts: string[]
  permissions: string[]
  slashSource: 'protocol' | 'curated' | 'none'
  slashCommands: string[]
  /** O binário da CLI está no PATH do servidor? Ausente (fallback embutido) = assume true. */
  available?: boolean
  /** Comando de instalação, mostrado quando available=false. */
  installHint?: string
}

export interface ContentBlock {
  type: string; text?: string; thinking?: string
  id?: string; name?: string; input?: unknown
  tool_use_id?: string; content?: unknown
  is_error?: boolean
}

export interface ApiMessage { role: string; content: ContentBlock[] | string }

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; slashCommands?: string[]; raw: unknown }
  | { kind: 'assistant'; message: ApiMessage; raw: unknown }
  | { kind: 'user'; message: ApiMessage; raw: unknown }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown }
  | { kind: 'raw'; raw: unknown }
  | { kind: 'parse_error'; line: string }
  | { kind: 'stream'; text: string; raw: unknown }

/**
 * `parentId`: id do tool_use do Agent que produziu este item — presente só no que
 * veio de um subagente. `fromSubagent` diz QUE veio de um; o parentId diz DE QUAL,
 * que é o que permite acompanhar vários subagentes em paralelo separadamente.
 */
export type ChatItem =
  // fromEngine: conteúdo que aparece do lado do usuário mas foi injetado pela
  // engine/harness (isMeta, resumo de compact) — não foi digitado pelo operador.
  | { kind: 'user_text'; text: string; fromSubagent?: boolean; parentId?: string; fromEngine?: boolean }
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
