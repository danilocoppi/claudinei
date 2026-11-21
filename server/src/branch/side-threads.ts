import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { Db } from '../db.js'
import { openCodeEngine } from '../engine/opencode/opencode-engine.js'
import type { ExecLike } from './cut.js'
import { kimiSideHome } from './engine-args.js'

/**
 * O que cada conversa lateral deixa no disco, anotado em `side_threads` para a
 * limpeza: no fechamento e, depois de uma queda, na subida do serviço. O estado
 * vivo da lateral fica em memória (side.ts); aqui só o que precisa sobreviver a
 * um reinício para ser apagado.
 */

export interface SideThreadRow { id: string; projectId: number; engine: string; threadId: string | null }

export function recordSideThread(db: Db, r: SideThreadRow): void {
  db.prepare('INSERT INTO side_threads (id, project_id, engine, thread_id) VALUES (?, ?, ?, ?)')
    .run(r.id, r.projectId, r.engine, r.threadId)
}

/** O id da conversa só chega depois (o OpenCode o anuncia no init do primeiro turno). */
export function setSideThreadId(db: Db, id: string, threadId: string): void {
  db.prepare('UPDATE side_threads SET thread_id=? WHERE id=?').run(threadId, id)
}

export function removeSideThread(db: Db, id: string): void {
  db.prepare('DELETE FROM side_threads WHERE id=?').run(id)
}

export function listSideThreads(db: Db): SideThreadRow[] {
  const rows = db.prepare('SELECT id, project_id, engine, thread_id FROM side_threads ORDER BY created_at, id').all() as
    Array<{ id: string; project_id: number; engine: string; thread_id: string | null }>
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, engine: r.engine, threadId: r.thread_id }))
}

/**
 * As conversas laterais deste motor que existem no storage dele. Nunca são "a
 * mais recente da pasta" de nenhum terminal: entram no conjunto de exclusão do
 * `latestConversationId`.
 */
export function sideThreadIds(db: Db, engine: string): ReadonlySet<string> {
  const rows = db.prepare('SELECT thread_id FROM side_threads WHERE engine=? AND thread_id IS NOT NULL').all(engine) as
    Array<{ thread_id: string }>
  return new Set(rows.map((r) => r.thread_id))
}

// ---- limpeza ----------------------------------------------------------------
//
// SEGURANÇA: a limpeza apaga em ~/.claude, nos dados do OpenCode e nos homes do
// Kimi. Só apaga caminho montado a partir de um id VALIDADO aqui, nunca com id
// vazio, com barra ou com ponto, e só caminho absoluto.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Id de conversa do OpenCode (`ses_…`): vai como argv do `opencode session delete`. */
const OPENCODE_ID = /^ses_[A-Za-z0-9_-]+$/

const execFileP = promisify(execFile)

/** O `opencode session delete` com prazo: a CLI travada não segura o fechamento. */
const runPadrao: ExecLike = async (file, args) => {
  const { stdout } = await execFileP(file, args, { timeout: 10_000, encoding: 'utf8' })
  return { stdout }
}

function claudeConfigDir(dir?: string): string {
  return dir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Apaga `path` só se for absoluto; o resto (inexistente) é silêncio. */
async function apagar(path: string, recursive = false): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`caminho não absoluto: ${JSON.stringify(path)}`)
  await rm(path, { force: true, recursive })
}

/**
 * Apaga o que a conversa lateral deixou no disco. Nunca lança: o erro vai ao log.
 * - Claude: os rastros dos hooks do usuário com o id dela
 *   (`<cfg>/security/security_warnings_state_<id>.json` e `.lock`, e a pasta
 *   `<cfg>/session-env/<id>`). O transcript não existe (`--no-session-persistence`).
 * - OpenCode: `opencode session delete <id>` (a cópia fica no storage dele).
 * - Kimi: o data root próprio da lateral (`kimiSideHome(id)`), inteiro.
 * - Codex: nada (o fork efêmero não deixa rastro).
 */
export async function cleanupSideTrace(r: { id: string; engine: string; threadId: string | null },
  deps: { claudeConfigDir?: string; run?: ExecLike } = {}): Promise<void> {
  try {
    switch (r.engine) {
      case 'claude': {
        const tid = r.threadId
        if (!tid || !UUID.test(tid)) { if (tid) console.warn(`[lateral] id do Claude inválido, nada apagado: ${JSON.stringify(tid)}`); return }
        const cfg = claudeConfigDir(deps.claudeConfigDir)
        await apagar(join(cfg, 'security', `security_warnings_state_${tid}.json`))
        await apagar(join(cfg, 'security', `security_warnings_state_${tid}.lock`))
        await apagar(join(cfg, 'session-env', tid), true)
        return
      }
      case 'opencode': {
        const tid = r.threadId
        // Sem id (morreu antes do init), não há o que apagar com segurança.
        if (!tid) return
        if (!OPENCODE_ID.test(tid)) { console.warn(`[lateral] id do OpenCode inválido, nada apagado: ${JSON.stringify(tid)}`); return }
        await (deps.run ?? runPadrao)(openCodeEngine.bin(), ['session', 'delete', tid])
        return
      }
      case 'kimi':
        // kimiSideHome valida o id ([A-Za-z0-9_-], não vazio) e lança se não passar.
        await apagar(kimiSideHome(r.id), true)
        return
      default:
        return
    }
  } catch (err) {
    console.error(`[lateral] falha ao limpar os rastros da conversa lateral ${r.id} (${r.engine})`, err)
  }
}
