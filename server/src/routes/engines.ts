import type { FastifyInstance } from 'fastify'
import { listEngines } from '../engine/index.js'
import { binAvailableCached } from '../engine/available.js'

/** Metadados + capabilities de cada engine registrada — alimenta a UX por engine no frontend.
 *  `available` = o binário da CLI está no PATH (sondado com cache curto); a UI usa
 *  para marcar a engine como "não instalada" em vez de deixar criar sessão fadada a morrer.
 *
 *  Ordem: a canônica do registry (Claude, Codex, Kimi, OpenCode — ver engine/index.ts),
 *  com as NÃO INSTALADAS por último. O sort é estável, então a ordem canônica se
 *  mantém dentro de cada grupo. */
export function registerEngineRoutes(app: FastifyInstance): void {
  app.get('/api/engines', async () =>
    listEngines()
      .map((e) => ({ id: e.id, available: binAvailableCached(e.bin()), ...e.capabilities() }))
      .sort((a, b) => Number(a.available === false) - Number(b.available === false)))
}
