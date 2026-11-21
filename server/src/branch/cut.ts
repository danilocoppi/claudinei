import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readPositionedTail, type PositionedLine } from '../tail.js'
import { claudeEngine } from '../engine/claude-engine.js'
import { codexEngine } from '../engine/codex/codex-engine.js'
import { openCodeEngine } from '../engine/opencode/opencode-engine.js'

/**
 * Ponto de corte da cópia: até onde a conversa de origem está "fechada" e pode
 * ser copiada para a lateral (`/side`) ou para o ramo (`/fork`).
 *
 * `null` (a função inteira) significa "nada fechado para copiar".
 */
export interface CutPoint {
  /** uuid da entrada (Claude) | turn_id (Codex) | id da última mensagem (OpenCode). */
  cut: string | null
  /** ISO da entrada do corte ("cópia até HH:MM"). */
  at: string | null
  /**
   * `before` do readPage que inclui o corte. No Claude e no Codex é o byte logo
   * depois do `\n` da linha do corte: a leitura posicionada descarta a linha que
   * `before` partiria, então apontar para o começo da linha a deixaria de fora.
   * No OpenCode, que pagina pelo índice, é o nº de eventos.
   */
  previewBefore: number | null
}

export type ExecLike = (file: string, args: string[]) => Promise<{ stdout: string }>

/** Byte seguinte ao `\n` da linha (no fim do arquivo sem `\n`, o readPage limita ao tamanho). */
function depoisDaLinha(l: PositionedLine): number {
  return l.pos + Buffer.byteLength(l.text, 'utf8') + 1
}

function parse(text: string): any {
  try { return JSON.parse(text) } catch { return null }
}

/** Lê pela cauda até achar ao menos uma entrada válida e devolve a última. */
async function ultimaPelaCauda(file: string, extrair: (l: PositionedLine) => CutPoint | null): Promise<CutPoint | null> {
  const parseLines = (lines: PositionedLine[]): CutPoint[] => {
    const out: CutPoint[] = []
    for (const l of lines) {
      const c = extrair(l)
      if (c) out.push(c)
    }
    return out
  }
  // A janela cresce enquanto não houver nenhuma: `minItems: 1`.
  const { items } = await readPositionedTail(file, parseLines, { minItems: 1 })
  return items.at(-1) ?? null
}

// Só estas entradas do transcript têm `uuid` que o `--resume-session-at` aceita
// como ponto de corte (ensaio: o valor é o `uuid`, nunca o `message.id` `msg_…`).
// `attachment` também traz `uuid`, mas não é mensagem da conversa.
const CLAUDE_TIPOS = new Set(['user', 'assistant', 'system'])

/**
 * Corte do Claude: o `uuid` da última entrada user/assistant/system do
 * transcript. O corte é inclusivo (a CLI copia até essa entrada).
 *
 * Com `turnStartedAt` (a principal trabalhando), as entradas do turno em curso
 * (timestamp >= início) ficam de fora: o corte é o fim do turno anterior. No
 * primeiro turno não há nada antes, e o resultado é `null`.
 */
export async function claudeCut(file: string, opts: { turnStartedAt?: number }): Promise<CutPoint | null> {
  const limite = opts.turnStartedAt
  return ultimaPelaCauda(file, (l) => {
    if (!l.text.includes('"uuid"')) return null // filtro barato antes do JSON.parse
    const o = parse(l.text)
    if (!o || typeof o !== 'object' || !CLAUDE_TIPOS.has(o.type)) return null
    if (typeof o.uuid !== 'string' || !o.uuid) return null
    const at = typeof o.timestamp === 'string' ? o.timestamp : null
    if (limite !== undefined) {
      // Sem horário legível não dá para provar que é de antes do turno: fica de fora.
      const t = at ? Date.parse(at) : NaN
      if (!(t < limite)) return null
    }
    return { cut: o.uuid, at, previewBefore: depoisDaLinha(l) }
  })
}

/**
 * Corte do Codex: o `turn_id` da última linha `event_msg`/`task_complete` do
 * rollout. O `lastTurnId` do fork é inclusivo e não aceita turno em andamento;
 * o turno em curso ainda não tem `task_complete`, então fica de fora sozinho.
 */
export async function codexCut(file: string): Promise<CutPoint | null> {
  return ultimaPelaCauda(file, (l) => {
    if (!l.text.includes('task_complete')) return null // filtro barato antes do JSON.parse
    const o = parse(l.text)
    if (!o || o.type !== 'event_msg' || o.payload?.type !== 'task_complete') return null
    const turnId = o.payload.turn_id
    if (typeof turnId !== 'string' || !turnId) return null
    return { cut: turnId, at: typeof o.timestamp === 'string' ? o.timestamp : null, previewBefore: depoisDaLinha(l) }
  })
}

const execFileP = promisify(execFile)

const runPadrao: ExecLike = async (file, args) => {
  // Mesmos limites do readHistory do OpenCode: o export pode levar segundos e ser grande.
  const { stdout } = await execFileP(file, args, { timeout: 8000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { stdout }
}

/** Id da última mensagem da conversa do OpenCode (`opencode export <id>`), ou `null`. */
export async function openCodeLastMessageId(_projectPath: string, id: string, run: ExecLike = runPadrao): Promise<string | null> {
  try {
    const { stdout } = await run(openCodeEngine.bin(), ['export', id])
    const d = parse(stdout)
    const msgs = Array.isArray(d?.messages) ? d.messages : []
    const ultimo = msgs.at(-1)?.info?.id
    return typeof ultimo === 'string' && ultimo ? ultimo : null
  } catch {
    return null
  }
}

/**
 * Corte por motor, achando o arquivo da conversa de cada um:
 * - Claude: o transcript; o `turnStartedAt` só vale com a principal trabalhando;
 * - Codex: o rollout; `working` não importa (o turno em curso não tem `task_complete`);
 * - OpenCode: sem corte nativo; ocioso, a última mensagem e o nº de eventos do
 *   histórico; trabalhando, nada (cai no pacote), sem chamar a CLI;
 * - Kimi (e qualquer outro): `null`, sempre o pacote.
 */
export async function cutFor(engineId: string, projectPath: string, sourceId: string,
  opts: { working: boolean; turnStartedAt?: number }): Promise<CutPoint | null> {
  switch (engineId) {
    case 'claude': {
      const file = claudeEngine.transcriptRef?.(projectPath, sourceId)
      if (!file) return null
      return claudeCut(file, { turnStartedAt: opts.working ? opts.turnStartedAt : undefined })
    }
    case 'codex': {
      // Varredura sem memória de propósito: depois de um `thread/revert` o
      // rollout antigo continua no disco, e um caminho guardado ficaria velho.
      const file = codexEngine.transcriptRef?.(projectPath, sourceId)
      if (!file) return null
      return codexCut(file)
    }
    case 'opencode': {
      if (opts.working) return { cut: null, at: null, previewBefore: null }
      const [lastId, eventos] = await Promise.all([
        openCodeLastMessageId(projectPath, sourceId),
        openCodeEngine.readHistory(projectPath, sourceId),
      ])
      return { cut: lastId, at: null, previewBefore: eventos.length }
    }
    default:
      return null
  }
}
