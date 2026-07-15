import type { ClaudeEvent, EngineMeta, PermissionMode, Project, SessionInfo } from './types'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'Content-Type': 'application/json' } : undefined
  const res = await fetch(url, { headers, ...init })
  if (!res.ok) {
    // Sessão expirada/revogada em qualquer chamada de app → volta à tela de
    // login (o App escuta). As rotas /api/auth tratam o próprio 401 (form).
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('claudinei:unauthorized'))
    }
    const body = await res.json().catch(() => ({ error: res.statusText }))
    const err = new Error(body.error ?? res.statusText) as Error & { status?: number; retryAfterMs?: number }
    err.status = res.status
    if (typeof body.retryAfterMs === 'number') err.retryAfterMs = body.retryAfterMs
    throw err
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const fetchProjects = () => req<Project[]>('/api/projects')
export const fetchSlashCommands = () => req<string[]>('/api/slash-commands')
export const fetchEngines = () => req<EngineMeta[]>('/api/engines')
export const createProject = (input: { name: string; path: string; color?: string; icon?: string }) =>
  req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) })
export type { PermissionMode }
export const startSession = (
  projectId: number,
  opts?: { continueConversation?: boolean; permissionMode?: PermissionMode; model?: string; engine?: string },
) =>
  req<SessionInfo>(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    ...(opts ? { body: JSON.stringify(opts) } : {}),
  })
export const setSessionOptions = (localId: string, opts: { model?: string; permissionMode?: PermissionMode; effort?: string }) =>
  req<SessionInfo>(`/api/sessions/${localId}/options`, { method: 'PATCH', body: JSON.stringify(opts) })
export const deleteProject = (id: number) =>
  req<void>(`/api/projects/${id}`, { method: 'DELETE' })
export const updateProject = (id: number, patch: { name?: string; color?: string; icon?: string }) =>
  req<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export interface Group { id: number; name: string; icon?: string; color?: string; sortOrder?: number }
/** Uma entrada da sidebar na ordem visual (grupo com filhos, ou terminal solto). */
export type SidebarEntry = { kind: 'group'; id: number; children: number[] } | { kind: 'project'; id: number }
export const putSidebarOrder = (entries: SidebarEntry[]) =>
  req<{ projects: Project[]; groups: Group[] }>('/api/sidebar-order', { method: 'PUT', body: JSON.stringify({ entries }) })
export const fetchGroups = () => req<Group[]>('/api/groups')
export const createGroup = (name: string) =>
  req<Group>('/api/groups', { method: 'POST', body: JSON.stringify({ name }) })
export const updateGroup = (id: number, patch: { name?: string; icon?: string; color?: string }) =>
  req<Group>(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteGroup = (id: number) =>
  req<void>(`/api/groups/${id}`, { method: 'DELETE' })
export const setProjectGroup = (projectId: number, groupId: number | null) =>
  req<{ ok: true }>(`/api/projects/${projectId}/group`, { method: 'PATCH', body: JSON.stringify({ groupId }) })

export const reorderProjects = (ids: number[]) =>
  req<Project[]>('/api/projects/order', { method: 'PUT', body: JSON.stringify({ ids }) })
export const stopSession = (localId: string) =>
  req<void>(`/api/sessions/${localId}/stop`, { method: 'POST' })
export const reviveSession = (localId: string) =>
  req<SessionInfo>(`/api/sessions/${localId}/revive`, { method: 'POST' })
export const openTerminal = (localId: string) =>
  req<{ token: string; wsUrl: string }>(`/api/sessions/${localId}/terminal`, { method: 'POST' })
export const closeTerminal = (localId: string) =>
  req<void>(`/api/sessions/${localId}/terminal`, { method: 'DELETE' })
export const fetchHistory = (localId: string) =>
  req<ClaudeEvent[]>(`/api/sessions/${localId}/history`)

export interface DirEntry { name: string; path: string; isDir: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[] }

export const fetchDir = (path?: string) =>
  req<DirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`)

export interface BoardPost {
  id: number
  projectId: number
  projectName: string
  title: string
  content: string
  createdAt: string
}

export const fetchBoard = (limit?: number) =>
  req<BoardPost[]>(`/api/hermes/board${limit ? `?limit=${limit}` : ''}`)

export interface Task {
  id: number
  fromProjectId: number | null
  fromProjectName: string | null
  toProjectId: number
  toProjectName: string
  /** Engine que despachou / que executou (null: operador, desconhecida ou ainda não entregue). */
  fromEngine?: string | null
  toEngine?: string | null
  description: string
  status: string
  result: string | null
  createdAt: string
  updatedAt: string
}

export const fetchTasks = (limit?: number) =>
  req<Task[]>(`/api/orchestrator/tasks${limit ? `?limit=${limit}` : ''}`)

/** Envia o WAV do microfone para transcrição no backend. Devolve o texto completo. */
export async function transcribeAudio(wav: Blob): Promise<{ text: string }> {
  const res = await fetch('/api/transcribe', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `transcrição falhou (${res.status})`)
  return data as { text: string }
}

export interface UsageLimit {
  kind: string; group: string; label: string | null
  percent: number; severity: string; resetsAt: string
}
/** Tokens por engine (ex.: Codex — o Claude não reporta tokens aqui). */
export interface EngineTokens { input: number; cachedInput: number; output: number; reasoning: number; total: number }
/** Acumulado (`total`) desde o 1º uso + `today` (bucket do dia UTC, zera à meia-noite). */
export interface EngineUsage { total: EngineTokens; today: EngineTokens }
/** Barras do /usage (limites do Claude via proxy OAuth) + tokens por engine (total + hoje). */
export const fetchUsage = () => req<{ limits: UsageLimit[]; tokens?: Record<string, EngineUsage> }>('/api/usage')

// fetch cru — o req() colocaria Content-Type json e quebraria o boundary do multipart
export const uploadFile = async (file: File, name?: string): Promise<{ path: string; name: string }> => {
  const fd = new FormData()
  fd.append('file', file, name ?? file.name)
  const res = await fetch('/api/uploads', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json()
}

export interface Me {
  setupRequired: boolean
  id?: number
  username?: string
  isAdmin?: boolean
  projectIds?: number[]
}
export interface AdminUser { id: number; username: string; isAdmin: boolean; projectIds: number[]; createdAt: string }

export const fetchMe = () => req<Me>('/api/auth/me')
export const login = (username: string, password: string) =>
  req<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
export const setupMaster = (username: string, password: string) =>
  req<Me>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) })
export const logout = () => req<void>('/api/auth/logout', { method: 'POST' })
export const changePassword = (currentPassword: string, newPassword: string) =>
  req<void>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
export const fetchUsers = () => req<AdminUser[]>('/api/auth/users')
export const createUser = (input: { username: string; password: string; isAdmin?: boolean; projectIds?: number[] }) =>
  req<AdminUser>('/api/auth/users', { method: 'POST', body: JSON.stringify(input) })
export const updateUser = (id: number, patch: { password?: string; isAdmin?: boolean; projectIds?: number[] }) =>
  req<AdminUser>(`/api/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteUser = (id: number) => req<void>(`/api/auth/users/${id}`, { method: 'DELETE' })
export const revokeAllSessions = () => req<void>('/api/auth/revoke-all', { method: 'POST' })
