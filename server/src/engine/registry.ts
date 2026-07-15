import type { Engine, EngineId } from './types.js'

export const DEFAULT_ENGINE_ID: EngineId = 'claude'

const engines = new Map<EngineId, Engine>()

export function registerEngine(engine: Engine): void {
  if (engines.has(engine.id)) throw new Error(`engine_already_registered: ${engine.id}`)
  engines.set(engine.id, engine)
}

export function getEngine(id: EngineId): Engine {
  const e = engines.get(id)
  if (!e) throw new Error(`unknown_engine: ${id}`)
  return e
}

export function hasEngine(id: EngineId): boolean {
  return engines.has(id)
}

export function listEngines(): Engine[] {
  return [...engines.values()]
}

/** Somente testes: limpa o registry entre casos. */
export function __resetRegistry(): void {
  engines.clear()
}
