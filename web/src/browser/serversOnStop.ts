import { fetchServers, stopLocalServer, type LocalServer } from './api'

/** Um servidor de pé, com o motor do terminal que o deixou (o Parar vai pela rota dele). */
export type EngineServer = LocalServer & { engine: string }

/**
 * Os servidores que os terminais (motores) do projeto deixaram no ar, só os do
 * marcador exato: os achados pela pasta (`cwd`) não têm Parar e ficam fora da
 * pergunta. Uma consulta que falha (rede, 403) conta como nenhum servidor
 * daquele motor: a pergunta é um extra e não pode impedir o encerramento.
 */
export async function serversOf(projectId: number, engines: string[]): Promise<EngineServer[]> {
  const unique = [...new Set(engines)]
  const lists = await Promise.all(unique.map(async (engine) => {
    try {
      const r = await fetchServers(projectId, engine)
      const servers = Array.isArray(r?.servers) ? r.servers : []
      return servers.filter((s) => s.marker === 'exact').map((s) => ({ ...s, engine }))
    } catch {
      return []
    }
  }))
  return lists.flat()
}

/** ":5173 vite, :3000 node" — a porta e o rótulo de cada servidor. */
export function serversSummary(list: LocalServer[]): string {
  return list.map((s) => (s.label ? `:${s.port} ${s.label}` : `:${s.port}`)).join(', ')
}

/**
 * Para todos, ao mesmo tempo (cada Parar pode levar até ~5 s, até o SIGKILL).
 * Um processo com duas portas aparece duas vezes e é parado uma vez só. Falhas
 * individuais (processo que já saiu, 409 `not_same_process`; 403) não
 * interrompem as outras nem o encerramento que vem depois.
 */
export async function stopAll(projectId: number, list: EngineServer[]): Promise<void> {
  const seen = new Set<string>()
  const targets = list.filter((s) => {
    const key = `${s.engine}:${s.pid}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  await Promise.allSettled(targets.map((s) => stopLocalServer(projectId, s.engine, s.pid, s.startTime)))
}
