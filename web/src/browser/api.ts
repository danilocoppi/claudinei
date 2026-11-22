import { req } from '../api'

/**
 * As rotas do navegador embutido e dos servidores locais do terminal (projeto +
 * motor). A tela e o bastão vão pelo WebSocket da tela, não por aqui.
 */

/** Espelho do `LocalServer` do servidor (`server/src/local-servers/scan.ts`). */
export interface LocalServer {
  pid: number
  port: number
  /** O endereço do bind (`127.0.0.1`, `0.0.0.0`, `::`…); o Abrir vai a `http://127.0.0.1:<port>`. */
  host: string
  label: string
  /** O início do processo: o Parar o devolve, contra PID reaproveitado. */
  startTime: string
  /** `exact`: marcador do terminal; `cwd`: sem marcador, achado pela pasta (só Abrir). */
  marker: 'exact' | 'cwd'
}

/** Erro da abertura da aba: o texto (no idioma da tela, quando há tradução), o código e a dica (o comando de instalação). */
export type BrowserApiError = Error & { status?: number; code?: string; hint?: string }

const terminal = (projectId: number, engine: string) =>
  `/api/projects/${projectId}/terminals/${encodeURIComponent(engine)}`

/** As abas abertas agora, só dos projetos a que o usuário tem acesso. */
export const fetchBrowserTabs = () =>
  req<{ tabs: Array<{ projectId: number; engine: string }> }>('/api/browser/tabs')

/** Abre (ou reaproveita) a aba do terminal. Sem Chromium: 503, com o comando de instalação em `hint`. */
export const openBrowserTab = (projectId: number, engine: string) =>
  req<{ ok: true }>(`${terminal(projectId, engine)}/browser`, { method: 'POST' })

export const closeBrowserTab = (projectId: number, engine: string) =>
  req<void>(`${terminal(projectId, engine)}/browser`, { method: 'DELETE' })

export const fetchServers = (projectId: number, engine: string) =>
  req<{ servers: LocalServer[] }>(`${terminal(projectId, engine)}/servers`)

/** Para o servidor; 409 `not_same_process` quando o PID já não é o mesmo processo. */
export const stopLocalServer = (projectId: number, engine: string, pid: number, startTime: string) =>
  req<{ ok: true; target: 'group' | 'pid' }>(`${terminal(projectId, engine)}/servers/${pid}/stop`, {
    method: 'POST', body: JSON.stringify({ startTime }),
  })
