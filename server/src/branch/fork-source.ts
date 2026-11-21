import type { Db } from '../db.js'
import type { SessionInfo } from '../claude/manager.js'
import type { Engine, EngineSessionOptions } from '../engine/types.js'
import { getEngine } from '../engine/index.js'
import { readRolloutPage } from '../engine/codex/rollout.js'
import { lastEventsOf, readPage, type HistoryPage, type HistoryResponse } from '../history-page.js'
import { openCodeLastMessageId } from './cut.js'

/**
 * De onde o ramo (`/fork`) copia a conversa, gravado em `sessions.fork_source`
 * até o primeiro turno gravar a cópia. Com ele, reviver o ramo antes disso
 * (reinício do serviço, sessão morta) refaz a mesma cópia em vez de abrir
 * conversa nova em branco.
 */
export interface ForkSource {
  engine: string
  /** Conversa de origem. */
  sourceId: string
  /** Ponto de corte (Claude: `uuid` da entrada; Codex: `turn_id`; OpenCode: id da última mensagem). */
  cut: string | null
  /** ISO do corte ("cópia até HH:MM"). */
  cutAt: string | null
  /** `before` do readPage que inclui o corte (a prévia do ramo e o pacote da cópia recusada). */
  previewBefore: number | null
  /** Claude: o id escolhido para o ramo (`--session-id`). */
  sessionId?: string
  /** OpenCode: pacote para quando o original andou desde o `/fork`. */
  seed?: string
}

/**
 * Formato aceito num id que vira argv (`--resume <id>`, `--resume-session-at <id>`):
 * começa com alfanumérico (barra flags "-x") e só tem `[A-Za-z0-9_-]`. O mesmo
 * critério do `resolveResume` do manager.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const safeOrNull = (v: unknown): boolean => v === null || (typeof v === 'string' && SAFE_ID.test(v))

/** Lê o `fork_source` do banco. Vazio, JSON torto, campo faltando ou id inseguro: `null`. */
export function parseForkSource(raw: string | null | undefined): ForkSource | null {
  if (!raw) return null
  let o: any
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (typeof o.engine !== 'string' || !o.engine) return null
  if (typeof o.sourceId !== 'string' || !SAFE_ID.test(o.sourceId)) return null
  if (!safeOrNull(o.cut ?? null) || !isStrOrNull(o.cutAt ?? null)) return null
  const pb = o.previewBefore ?? null
  if (pb !== null && (typeof pb !== 'number' || !Number.isFinite(pb))) return null
  if (o.sessionId !== undefined && (typeof o.sessionId !== 'string' || !SAFE_ID.test(o.sessionId))) return null
  if (o.seed !== undefined && typeof o.seed !== 'string') return null
  return {
    engine: o.engine,
    sourceId: o.sourceId,
    cut: o.cut ?? null,
    cutAt: o.cutAt ?? null,
    previewBefore: pb,
    ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
  }
}

/**
 * As opções da sessão que fazem dela a cópia descrita por `src`:
 * - Claude: `--resume <origem> --fork-session` (com `--resume-session-at` se houver
 *   corte) e o `--session-id` escolhido;
 * - Codex: `thread/fork` com o `lastTurnId`;
 * - OpenCode: `--fork` só se o original não andou desde o corte (`nativeOk`);
 *   senão, o pacote (`seed`) vai junto da primeira mensagem;
 * - Kimi e outros: nada (não há cópia nativa).
 */
export function forkPlanOf(src: ForkSource, projectPath: string): Pick<EngineSessionOptions, 'forkFrom' | 'sessionId'> {
  // A fonte também pode vir de código (o `start` do ramo): mesma defesa do parse.
  if (!SAFE_ID.test(src.sourceId) || !safeOrNull(src.cut)) throw new Error('fork_source com id inválido')
  const cut = src.cut ?? undefined
  switch (src.engine) {
    case 'claude':
      return { forkFrom: { sourceId: src.sourceId, ...(cut ? { cut } : {}) }, sessionId: src.sessionId }
    case 'codex':
      return { forkFrom: { sourceId: src.sourceId, ...(cut ? { cut } : {}) } }
    case 'opencode':
      return {
        forkFrom: {
          sourceId: src.sourceId,
          ...(src.seed !== undefined ? { seed: src.seed } : {}),
          // O `--fork` copia a conversa toda: só vale se a última mensagem da
          // origem ainda é o corte. Sem corte (o `/fork` no meio do turno), nunca.
          nativeOk: async () => src.cut != null && (await openCodeLastMessageId(projectPath, src.sourceId)) === src.cut,
        },
      }
    default:
      return {}
  }
}

/**
 * A cópia do ramo já está no storage do motor? É o que encerra o `fork_source`
 * (fim do primeiro turno), o que separa a morte comum da cópia recusada e o
 * que tira a prévia do ar.
 * - Claude: o transcript do id escolhido (`conversationExists`).
 * - Codex: o rollout do id que o `thread/fork` devolveu (`transcriptRef`). Só
 *   o id não basta: sem o arquivo, o revive tentaria `resume` de um thread que
 *   não existe (o "id fantasma", que trava o chat com "No conversation found").
 * - OpenCode e outros: basta o id gravado (o id só sai no init do primeiro turno).
 */
export function forkCopyDone(engine: Engine, projectPath: string, id: string | null | undefined): boolean {
  if (!id || !SAFE_ID.test(id)) return false
  if (engine.conversationExists) return engine.conversationExists(projectPath, id)
  if (engine.id === 'codex') return (engine.transcriptRef?.(projectPath, id) ?? null) !== null
  return true
}

/**
 * Prévia do ramo antes do primeiro turno: a página do histórico do ORIGINAL até
 * o corte, para o chat não abrir vazio. `null` quando não se aplica (a sessão
 * não é ramo pendente, a cópia própria já existe, ou o corte não tem posição,
 * como no OpenCode copiado no meio do turno) e a rota segue o caminho de sempre.
 *
 * O `before` é o menor entre o pedido e o `previewBefore`: a página anterior
 * pagina dentro do original, e nada depois do corte aparece.
 */
export async function forkPreviewPage(db: Db, info: SessionInfo, projectPath: string,
  before: number | undefined, limit: number): Promise<HistoryResponse | null> {
  const row = db.prepare('SELECT fork_source FROM sessions WHERE local_id=?').get(info.localId) as { fork_source?: string | null } | undefined
  const src = parseForkSource(row?.fork_source)
  if (!src || src.engine !== info.engine || src.previewBefore === null) return null
  const engine = getEngine(info.engine)
  if (forkCopyDone(engine, projectPath, info.engineSessionId)) return null
  const opts = { before: Math.min(before ?? Infinity, src.previewBefore), minItems: limit }
  let page: HistoryPage
  if (engine.id === 'codex') {
    // O mesmo arquivo do corte (`cutFor` acha pelo `transcriptRef`, sem memória):
    // depois de um `thread/revert` o caminho guardado pelo `readHistoryPage`
    // pode ser o rollout antigo, e o `previewBefore` é byte do novo.
    const file = engine.transcriptRef?.(projectPath, src.sourceId) ?? null
    page = file ? await readRolloutPage(file, opts) : { events: [], start: 0, atStart: true }
  } else {
    page = await readPage(engine, projectPath, src.sourceId, opts)
  }
  return lastEventsOf(page, limit)
}
