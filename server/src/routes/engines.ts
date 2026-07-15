import type { FastifyInstance } from 'fastify'
import { listEngines } from '../engine/index.js'
import { binAvailableCached } from '../engine/available.js'

/** Metadados + capabilities de cada engine registrada — alimenta a UX por engine no frontend.
 *  `available` = o binário da CLI está no PATH (sondado com cache curto); a UI usa
 *  para marcar a engine como "não instalada" em vez de deixar criar sessão fadada a morrer. */
export function registerEngineRoutes(app: FastifyInstance): void {
  app.get('/api/engines', async () => listEngines().map((e) => ({ id: e.id, available: binAvailableCached(e.bin()), ...e.capabilities() })))
}
