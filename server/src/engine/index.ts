// Ponto único de import do registry pelos consumidores (manager, rotas): importar
// este módulo registra as engines embutidas como side-effect, garantindo o registry
// populado onde quer que o manager rode. Adicionar uma engine futura = mais uma linha.
import { registerEngine, hasEngine } from './registry.js'
import { claudeEngine } from './claude-engine.js'
import { codexEngine } from './codex/codex-engine.js'
import { openCodeEngine } from './opencode/opencode-engine.js'

if (!hasEngine(claudeEngine.id)) registerEngine(claudeEngine)
if (!hasEngine(codexEngine.id)) registerEngine(codexEngine)
if (!hasEngine(openCodeEngine.id)) registerEngine(openCodeEngine)

export { getEngine, hasEngine, listEngines, registerEngine, DEFAULT_ENGINE_ID } from './registry.js'
export type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, EngineId, AgentEvent } from './types.js'
