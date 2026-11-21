import type { EngineSessionOptions } from '../engine/types.js'
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
