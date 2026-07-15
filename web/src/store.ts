import { create } from 'zustand'
import type { ChatItem, ClaudeEvent, EngineMeta, Project, SessionInfo } from './types'
import type { BoardPost, Group, Task } from './api'
import type { FileKind, ScopeResult } from './files'
import { applyEvent } from './chat/applyEvent'
import { notifySessionChange } from './notifications'
import { BUILTIN_FALLBACK } from './slash'
import { OPENAI_ICON } from './components/EngineIcon'

/**
 * Fallback embutido para `store.engines`, usado até `GET /api/engines` resolver (ou se falhar).
 * Espelha `capabilities()` de server/src/engine/claude-engine.ts e server/src/engine/codex/codex-engine.ts —
 * mantenha em sincronia se o backend mudar. `setEngines` substitui por esta lista assim que o boot
 * (App.tsx) resolve o fetch; uma 3ª engine registrada no backend ainda aparece normalmente ali.
 */
const BUILTIN_ENGINES: EngineMeta[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    icon: '✳',
    models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
    efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'],
    slashSource: 'protocol',
    slashCommands: [],
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: OPENAI_ICON,
    models: ['', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    permissions: [],
    slashSource: 'curated',
    slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
  },
]

interface State {
  authStatus: 'loading' | 'setup' | 'login' | 'ready'
  me: import('./api').Me | null
  setAuth(status: 'loading' | 'setup' | 'login' | 'ready', me?: import('./api').Me | null): void
  projects: Project[]
  sessions: Record<string, SessionInfo>
  chat: Record<string, ChatItem[]>
  unread: Record<string, number>
  /** Preview efêmero de streaming token-a-token, por localId. Nunca entra em chat[]; some quando o evento assistant/result real chega. */
  streaming: Record<string, string>
  historyLoadedFor: Record<string, string>
  activeLocalId?: string
  /** Pedido de edição em curso: reenche o ChatInput da sessão-alvo com o texto original. `seq` distingue pedidos repetidos com o mesmo texto. */
  editRequest?: { localId: string; text: string; seq: number }
  /** Comandos slash disponíveis (global), populado pelo evento init; fallback até o 1º init chegar. */
  slashCommands: string[]
  /** Engines registradas no backend (metadados + capabilities), populado no boot ('ready'). */
  engines: EngineMeta[]
  /** Effort atual por sessão, farejado das respostas do /effort (ausente = auto). */
  sessionEffort: Record<string, string>
  /** Grupos visuais de terminais (sidebar). */
  groups: Group[]
  view: 'dashboard' | 'chat' | 'board' | 'tasks' | 'terminal'
  board: BoardPost[]
  tasks: Task[]
  /** Arquivo aberto no FileViewerModal (path detectado/resolvido no chat), ou null se fechado. */
  fileViewer: { path: string; kind: FileKind; projectId?: number } | null
  /** Link externo aguardando confirmação de segurança (popup) antes de abrir. */
  externalLink: string | null
  /** Cache de resolve de paths detectados no chat (MessageBlock), por path → resultado do `/api/files/resolve`. */
  fileResolved: Record<string, ScopeResult>
  setFilesResolved(results: ScopeResult[]): void
  setProjects(projects: Project[]): void
  setGroups(groups: Group[]): void
  setSlashCommands(cmds: string[]): void
  setEngines(engines: EngineMeta[]): void
  setHistory(localId: string, events: ClaudeEvent[]): void
  markHistoryLoaded(localId: string, engineSessionId: string): void
  addLocalUserText(localId: string, text: string): void
  requestEdit(localId: string, text: string): void
  applyWsMessage(msg: any): void
  openSession(localId: string): void
  openTerminal(localId: string): void
  openDashboard(): void
  setBoard(posts: BoardPost[]): void
  openBoard(): void
  setTasks(tasks: Task[]): void
  openTasks(): void
  openFile(path: string, kind: FileKind, projectId?: number): void
  closeFile(): void
  openExternalLink(url: string): void
  closeExternalLink(): void
}

export const useStore = create<State>((set, get) => ({
  authStatus: 'loading',
  me: null,
  setAuth: (authStatus, me) => set((s) => ({ authStatus, me: me === undefined ? s.me : me })),
  projects: [],
  sessions: {},
  chat: {},
  unread: {},
  streaming: {},
  historyLoadedFor: {},
  activeLocalId: undefined,
  editRequest: undefined,
  slashCommands: BUILTIN_FALLBACK,
  engines: BUILTIN_ENGINES,
  sessionEffort: {},
  groups: [],
  view: 'dashboard',
  board: [],
  tasks: [],
  fileViewer: null,
  fileResolved: {},
  externalLink: null,

  setProjects: (projects) => set({ projects }),

  setGroups: (groups) => set({ groups }),

  setSlashCommands: (cmds) => set((s) => (cmds.length ? { slashCommands: cmds } : s)),

  setEngines: (engines) => set({ engines }),

  setHistory: (localId, events) =>
    set((s) => ({ chat: { ...s.chat, [localId]: events.reduce(applyEvent, [] as ChatItem[]) } })),

  markHistoryLoaded: (localId, engineSessionId) =>
    set((s) => ({ historyLoadedFor: { ...s.historyLoadedFor, [localId]: engineSessionId } })),

  addLocalUserText: (localId, text) =>
    set((s) => ({ chat: { ...s.chat, [localId]: [...(s.chat[localId] ?? []), { kind: 'user_text', text }] } })),

  requestEdit: (localId, text) =>
    set((s) => ({ editRequest: { localId, text, seq: (s.editRequest?.seq ?? 0) + 1 } })),

  applyWsMessage: (msg) => {
    if (msg.type === 'sessions_snapshot') {
      const sessions: Record<string, SessionInfo> = {}
      for (const info of msg.sessions as SessionInfo[]) sessions[info.localId] = info
      set({ sessions })
    } else if (msg.type === 'session_status') {
      const prev = get().sessions[msg.localId]?.status
      const projectId = get().sessions[msg.localId]?.projectId
      const projectName = get().projects.find((p) => p.id === projectId)?.name ?? 'projeto'
      notifySessionChange(projectName, msg.status, prev)
      set((s) => ({
        sessions: {
          ...s.sessions,
          [msg.localId]: {
            ...(s.sessions[msg.localId] ?? { updatedAt: '' }),
            localId: msg.localId,
            projectId: msg.projectId ?? s.sessions[msg.localId]?.projectId ?? 0,
            status: msg.status,
            engineSessionId: msg.engineSessionId ?? null,
            detail: msg.detail,
            model: msg.model ?? s.sessions[msg.localId]?.model,
            permissionMode: msg.permissionMode ?? s.sessions[msg.localId]?.permissionMode,
            effort: msg.effort !== undefined ? msg.effort : s.sessions[msg.localId]?.effort,
            engine: msg.engine ?? s.sessions[msg.localId]?.engine ?? 'claude',
          },
        },
      }))
    } else if (msg.type === 'session_event') {
      const { localId, event } = msg
      if (event.kind === 'init' && Array.isArray(event.slashCommands) && event.slashCommands.length) {
        set({ slashCommands: event.slashCommands })
      }
      if (event.kind === 'init') {
        // processo novo (1ª mensagem, revive, restart): effort volta ao padrão do CLI
        set((s) => {
          if (!(localId in s.sessionEffort)) return s
          const { [localId]: _gone, ...rest } = s.sessionEffort
          return { sessionEffort: rest }
        })
      }
      if (event.kind === 'result' && typeof event.resultText === 'string') {
        // confirmação do /effort — vale tanto para o popover quanto para o comando digitado
        const m = /^Set effort level to (\w+)/.exec(event.resultText)
        if (m) set((s) => ({ sessionEffort: { ...s.sessionEffort, [localId]: m[1] } }))
      }
      if (event.kind === 'stream') {
        set((s) => ({ streaming: { ...s.streaming, [localId]: (s.streaming[localId] ?? '') + event.text } }))
        return
      }
      set((s) => {
        const nextChat = applyEvent(s.chat[localId] ?? [], event)
        const isActive = s.activeLocalId === localId && s.view === 'chat'
        const grew = nextChat.length > (s.chat[localId] ?? []).length
        const clearsStreaming = event.kind === 'assistant' || event.kind === 'result'
        return {
          chat: { ...s.chat, [localId]: nextChat },
          unread: isActive || !grew ? s.unread : { ...s.unread, [localId]: (s.unread[localId] ?? 0) + 1 },
          streaming: clearsStreaming ? { ...s.streaming, [localId]: '' } : s.streaming,
        }
      })
    } else if (msg.type === 'board_post') {
      const post: BoardPost = {
        id: msg.id,
        projectId: msg.projectId,
        projectName: msg.projectName,
        title: msg.title,
        content: msg.content,
        createdAt: msg.createdAt ?? new Date().toISOString(),
      }
      set((s) => ({ board: [post, ...s.board] }))
    } else if (msg.type === 'task_update') {
      const task = msg.task as Task | undefined
      if (!task) return
      set((s) => {
        const idx = s.tasks.findIndex((t) => t.id === task.id)
        if (idx === -1) return { tasks: [task, ...s.tasks] }
        const next = [...s.tasks]
        next[idx] = task
        return { tasks: next }
      })
    }
  },

  openSession: (localId) =>
    set((s) => ({ activeLocalId: localId, view: 'chat', unread: { ...s.unread, [localId]: 0 } })),

  openTerminal: (localId) => set({ view: 'terminal', activeLocalId: localId }),

  openDashboard: () => set({ view: 'dashboard', activeLocalId: undefined }),

  setBoard: (posts) => set({ board: posts }),

  openBoard: () => set({ view: 'board', activeLocalId: undefined }),

  setTasks: (tasks) => set({ tasks }),

  openTasks: () => set({ view: 'tasks', activeLocalId: undefined }),

  openFile: (path, kind, projectId) => set({ fileViewer: { path, kind, projectId } }),

  closeFile: () => set({ fileViewer: null }),

  openExternalLink: (url) => set({ externalLink: url }),

  closeExternalLink: () => set({ externalLink: null }),

  setFilesResolved: (results) =>
    set((s) => {
      const fileResolved = { ...s.fileResolved }
      for (const r of results) fileResolved[r.path] = r
      return { fileResolved }
    }),
}))

/**
 * Resolve a engine da sessão dada dentro de uma lista de engines já carregada.
 * Fallback: engine de id 'claude'; se nem essa existir, a primeira da lista.
 */
function resolveEngine(engines: EngineMeta[], session: SessionInfo | undefined): EngineMeta | undefined {
  const byId = session ? engines.find((e) => e.id === session.engine) : undefined
  return byId ?? engines.find((e) => e.id === 'claude') ?? engines[0]
}

/**
 * Engine da sessão dada (`store.engines`, procurada por `session.engine`).
 * Fallback: engine de id 'claude'; se nem essa existir, a primeira da lista.
 * Sem sessão ou sem engines carregadas ainda → mesmo fallback (undefined se `engines` vazio).
 *
 * Versão NÃO reativa (lê `getState()` na hora) — use fora de render (callbacks,
 * efeitos, testes). Dentro de um componente, prefira `useEngineFor`.
 */
export function engineFor(session: SessionInfo | undefined): EngineMeta | undefined {
  return resolveEngine(useStore.getState().engines, session)
}

/** Versão reativa de `engineFor`, para uso dentro do corpo de componentes (re-renderiza quando `engines` chega do boot). */
export function useEngineFor(session: SessionInfo | undefined): EngineMeta | undefined {
  const engines = useStore((s) => s.engines)
  return resolveEngine(engines, session)
}

/**
 * Lista de slash commands efetiva da sessão, dirigida pela engine:
 * - `slashSource === 'protocol'` → `store.slashCommands` (hoje só o Claude; farejado do evento `init`).
 * - `slashSource === 'curated'` → `engine.slashCommands` (lista fixa da engine, ex.: Codex).
 * - `slashSource === 'none'` → nenhum autocomplete.
 * Sem engine resolvida ainda (boot) → cai no protocolo (comportamento idêntico ao de hoje).
 * Reativa: use dentro do corpo de componentes.
 */
export function useSessionSlashCommands(session: SessionInfo | undefined): string[] {
  const engine = useEngineFor(session)
  const protocolCommands = useStore((s) => s.slashCommands)
  const source = engine?.slashSource ?? 'protocol'
  if (source === 'none') return []
  if (source === 'curated') return engine?.slashCommands ?? []
  return protocolCommands
}
