import { req } from '../api'
import type { ClaudeEvent, Project, SessionInfo, SessionStatus } from '../types'

/**
 * As rotas do ramificar (`server/src/routes/branch.ts`): a conversa lateral
 * (`/side`, `/btw`), o ramo (`/fork`) e a troca de motor (⇄). Os erros saem
 * como os do resto da API (`req`): a mensagem no idioma da tela, com o `code`
 * e o `status` crus para quem precisa comparar.
 */

/** Quanto a lateral pode mexer nos arquivos da pasta (o aviso da coluna). */
export type SideFiles = 'read_only' | 'no_edit_tools' | 'can_write'

/** Cópia de `SideInfo` (server/src/branch/side.ts). */
export interface SideInfo {
  id: string
  projectId: number
  engine: string
  status: SessionStatus
  /** `native`: a CLI copiou a conversa; `seed`: o pacote de contexto vai na primeira mensagem. */
  mode: 'native' | 'seed'
  /** ISO do corte ("cópia até HH:MM"); null quando o motor não diz. */
  cutAt: string | null
  files: SideFiles
  /** A última pergunta do operador na lateral. */
  question: string | null
  openedAt: string
}

/** O que o servidor guarda da lateral: o estado e os eventos (sem os `stream`). */
export interface SideSnapshot { side: SideInfo | null; events: ClaudeEvent[] }

const sideUrl = (projectId: number) => `/api/projects/${projectId}/side`
const post = (body: object): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const getSide = (projectId: number, engine: string) =>
  req<SideSnapshot>(`${sideUrl(projectId)}?engine=${encodeURIComponent(engine)}`)

/** Abre a lateral; `text` é a pergunta. `replace` fecha a que já houver (sem ele, 409 `side_exists`). */
export const openSide = (projectId: number, engine: string, text?: string, replace?: boolean) =>
  req<SideInfo>(sideUrl(projectId), post({
    engine,
    ...(text !== undefined ? { text } : {}),
    ...(replace ? { replace: true } : {}),
  }))

export const sendSide = (projectId: number, engine: string, text: string) =>
  req<void>(`${sideUrl(projectId)}/message`, post({ engine, text }))

export const interruptSide = (projectId: number, engine: string) =>
  req<void>(`${sideUrl(projectId)}/interrupt`, post({ engine }))

export const closeSide = (projectId: number, engine: string) =>
  req<void>(`${sideUrl(projectId)}?engine=${encodeURIComponent(engine)}`, { method: 'DELETE' })

/** `/fork [nome]`: o terminal irmão com a cópia da conversa. Sem nome, o servidor escolhe "(ramo)". */
export const forkTerminal = (projectId: number, engine: string, name?: string) =>
  req<{ project: Project; session: SessionInfo }>(`/api/projects/${projectId}/fork`, post({
    engine,
    ...(name !== undefined ? { name } : {}),
  }))

/** ⇄ Continuar noutro motor: devolve a sessão do destino. */
export const handoff = (projectId: number, from: string, to: string) =>
  req<SessionInfo>(`/api/projects/${projectId}/handoff`, post({ from, to }))
