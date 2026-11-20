import type { AgentEvent, Engine } from './engine/types.js'

/**
 * Histórico em páginas. `pos` é o byte de início da linha do evento no arquivo
 * da engine: estável porque o arquivo só cresce no fim, e é por ele que a tela
 * identifica cada mensagem e pede "a página antes do byte X". Vários eventos
 * podem dividir o mesmo `pos` quando saem da mesma linha.
 */
export type PositionedEvent = AgentEvent & { pos: number }

export interface HistoryPage {
  events: PositionedEvent[]
  /** Byte da primeira linha lida: a próxima página pede `before = start`. */
  start: number
  /** Chegou ao começo da conversa: não há página anterior. */
  atStart: boolean
}

export interface HistoryPageOptions {
  /** Só eventos de linhas que começam antes deste byte. Ausente = até o fim. */
  before?: number
  /** Quantos eventos bastam para parar de crescer a janela. */
  minItems: number
  maxBytes?: number
  firstChunkBytes?: number
}

/**
 * Uma página do histórico de qualquer engine. Quem não lê por posição (OpenCode,
 * que monta o histórico do próprio banco) devolve o trecho que o `readHistory`
 * já entrega, numerado pelo índice e sempre no começo.
 */
export async function readPage(engine: Engine, projectPath: string, id: string, opts: HistoryPageOptions): Promise<HistoryPage> {
  if (engine.readHistoryPage) return engine.readHistoryPage(projectPath, id, opts)
  const events = (await engine.readHistory(projectPath, id)).map((e, i): PositionedEvent => ({ ...e, pos: i }))
  return {
    events: opts.before === undefined ? events : events.filter((e) => e.pos < opts.before!),
    start: 0,
    atStart: true,
  }
}
