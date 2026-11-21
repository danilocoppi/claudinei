import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { SessionInfo, SessionManager } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import type { PermissionMode } from '../claude/session.js'
import { createProjectsService, type Project } from '../projects.js'
import { parseEngines, sortEngines } from '../terminal-engines.js'
import { getEngine } from '../engine/index.js'
import { UserError } from '../user-error.js'
import { cutFor, type CutPoint } from './cut.js'
import { collectHandoff, type Handoff } from './handoff.js'
import type { ForkSource } from './fork-source.js'

/**
 * Ramificar (`/fork [nome]`): um terminal irmão na mesma pasta, logo abaixo do
 * original, com uma sessão que nasce da cópia da conversa até o último turno
 * fechado. O original segue como estava, mesmo trabalhando.
 */

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

/** Id de conversa aceito como origem: vira argv (`--resume <id>`) ou caminho. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * Nome do ramo: o dado (sem os espaços das pontas), mesmo que já exista; sem
 * nome, ou só com espaços, `<original> (ramo)`, depois `(ramo 2)`, `(ramo 3)`…,
 * o primeiro livre entre os nomes existentes.
 */
export function branchName(original: string, existing: string[], given?: string): string {
  const dado = given?.trim()
  if (dado) return dado
  const usados = new Set(existing)
  const base = `${original} (ramo)`
  if (!usados.has(base)) return base
  for (let n = 2; ; n++) {
    const nome = `${original} (ramo ${n})`
    if (!usados.has(nome)) return nome
  }
}

export interface ForkDeps {
  db: Db
  manager: Pick<SessionManager, 'list' | 'get' | 'start' | 'sendAsClaudinei' | 'turnStartedAt' | 'rewindPending'>
  cutFor?: typeof cutFor // testes
  collect?: typeof collectHandoff // testes
}

/** Só admin cria terminal: a mesma régua do `requireAdmin`. */
export const canFork = (u: AuthUser | undefined): boolean => !u || (u.kind === 'user' && u.isAdmin)

const noConversation = () => new UserError('no_conversation', 'Ainda não há conversa para copiar')

/**
 * Volta da conversa pendente ("Editar a partir daqui" antes do primeiro
 * result): o id que o manager mostra ainda é o de antes da volta, e copiá-lo
 * levaria a conversa antiga. O `/side`, o `/fork` e a ⇄ recusam até lá.
 */
export const rewindPending = () => new UserError('rewind_pending', 'Espere a primeira resposta depois de voltar a conversa')

/** As opções da sessão que o ramo herda: motor, modelo, esforço e modo de permissão. */
export interface Origin {
  sourceId: string
  model: string | null
  effort: string | null
  permissionMode: string | null
  working: boolean
  turnStartedAt?: number
}

/**
 * A conversa de origem do motor: a da sessão viva, ou, sem sessão de pé, a
 * mais recente do terminal com conversa gravada. Uma sessão de pé ainda sem id
 * aberta como conversa nova (`continue_latest = 0`): não há o que copiar (a
 * antiga do banco não é a da tela), como no `/side`. Aberta com "continuar
 * conversa" e ainda sem o init (no Claude, só com a primeira mensagem): vale a
 * mais recente do banco, a mesma que o `--continue` retoma. Com a volta da
 * conversa pendente (id segurado), lança `rewind_pending`.
 */
export function originOf(deps: { db: Db; manager: Pick<SessionManager, 'list' | 'turnStartedAt' | 'rewindPending'> }, projectId: number, engine: string): Origin | null {
  const live = deps.manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))
  if (live && deps.manager.rewindPending(live.localId)) throw rewindPending()
  const working = live?.status === 'working'
  const turnStartedAt = live && working ? deps.manager.turnStartedAt(live.localId) : undefined
  if (live?.engineSessionId) {
    return { sourceId: live.engineSessionId, model: live.model, effort: live.effort, permissionMode: live.permissionMode, working, turnStartedAt }
  }
  if (live) {
    const cont = deps.db.prepare('SELECT continue_latest FROM sessions WHERE local_id=?').get(live.localId) as { continue_latest: number } | undefined
    if (!cont || cont.continue_latest === 0) return null
  }
  const row = deps.db.prepare(
    `SELECT claude_session_id, model, effort, permission_mode FROM sessions
      WHERE project_id=? AND engine=? AND claude_session_id IS NOT NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
  ).get(projectId, engine) as { claude_session_id: string; model: string | null; effort: string | null; permission_mode: string | null } | undefined
  if (!row) return null
  // Com "continuar conversa" já trabalhando no primeiro turno, o corte respeita o turno aberto.
  return { sourceId: row.claude_session_id, model: row.model, effort: row.effort, permissionMode: row.permission_mode, working, turnStartedAt }
}

/** O que a sessão do ramo leva: a cópia nativa (`forkSource`) ou o pacote a mandar depois (`seed`). */
interface Plan { forkSource?: ForkSource; seed?: string; cutAt: string | null }

async function planOf(deps: ForkDeps, engine: string, projectPath: string, o: Origin): Promise<Plan> {
  const cutFn = deps.cutFor ?? cutFor
  const collect = deps.collect ?? collectHandoff
  const cut = async (): Promise<CutPoint | null> => {
    try {
      return await cutFn(engine, projectPath, o.sourceId, { working: o.working, turnStartedAt: o.turnStartedAt })
    } catch (err) {
      console.error('[ramo] corte falhou', err)
      return null
    }
  }
  // Nunca com `before`: o pacote vai até o último turno fechado de agora.
  const pack = async (): Promise<Handoff | null> => {
    try {
      return await collect(getEngine(engine), projectPath, o.sourceId, { working: o.working })
    } catch (err) {
      console.error('[ramo] pacote falhou', err)
      return null
    }
  }
  const base = { engine, sourceId: o.sourceId }
  switch (engine) {
    case 'claude':
    case 'codex': {
      // Sempre com o ponto de corte (no Claude, `--resume-session-at` mesmo ocioso):
      // a cópia vai à risca até o momento do `/fork`, também quando refeita.
      const c = await cut()
      if (!c?.cut) throw noConversation()
      return {
        forkSource: {
          ...base, cut: c.cut, cutAt: c.at, previewBefore: c.previewBefore,
          ...(engine === 'claude' ? { sessionId: randomUUID() } : {}),
        },
        cutAt: c.at,
      }
    }
    case 'opencode': {
      // Ocioso: `--fork` se o original não andar até a primeira mensagem, senão o
      // pacote junto dela. Trabalhando: só o pacote (o OpenCode não tem corte).
      const c = await cut()
      if (!o.working && !c?.cut) throw noConversation()
      const p = await pack()
      if (o.working && !p) throw noConversation()
      return {
        forkSource: {
          ...base,
          cut: o.working ? null : c!.cut,
          cutAt: c?.at ?? null,
          previewBefore: o.working ? null : c?.previewBefore ?? null,
          ...(p ? { seed: p.text } : {}),
        },
        cutAt: c?.at ?? null,
      }
    }
    default: {
      // Kimi (e motor sem cópia nativa): conversa nova e o pacote como mensagem do Claudinei.
      const p = await pack()
      if (!p) throw noConversation()
      return { seed: p.text, cutAt: null }
    }
  }
}

/**
 * Cria o terminal do ramo numa transação: logo abaixo do original (todo
 * `sort_order` maior que o dele anda uma casa, em terminais, grupos e setores,
 * que dividem o mesmo espaço de posições na lateral), com a pasta, a cor, o
 * ícone, o grupo, o setor, os avisos e os motores do original (o do ramo
 * garantido) e as mesmas linhas de `user_projects`. O resto do terminal
 * (estado, fila, agendamentos, triagem, fixado) não vem.
 */
function createBranchProject(db: Db, projectId: number, engine: string, name: string | undefined, cutAt: string | null): number {
  return db.transaction(() => {
    const orig = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as any
    if (!orig) throw new UserError('project_not_found', 'projeto não existe')
    const nomes = (db.prepare('SELECT name FROM projects').all() as Array<{ name: string }>).map((r) => r.name)
    const ordem = orig.sort_order ?? 0
    for (const tabela of ['projects', 'project_groups', 'sectors']) {
      db.prepare(`UPDATE ${tabela} SET sort_order = sort_order + 1 WHERE sort_order > ?`).run(ordem)
    }
    const engines = sortEngines([...(parseEngines(orig.engines) ?? ['claude']), engine])
    const info = db.prepare(
      `INSERT INTO projects (name, path, color, icon, sort_order, engines, group_id, sector_id, heads_up, forked_from, forked_cut_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(branchName(orig.name, nomes, name), orig.path, orig.color, orig.icon, ordem + 1, JSON.stringify(engines),
      orig.group_id ?? null, orig.sector_id ?? null, orig.heads_up ?? 1, projectId, cutAt)
    const id = Number(info.lastInsertRowid)
    db.prepare('INSERT INTO user_projects (user_id, project_id) SELECT user_id, ? FROM user_projects WHERE project_id=?').run(id, projectId)
    return id
  })()
}

/**
 * O `/fork`: acha a conversa de origem, calcula a cópia, cria o terminal e sobe
 * a sessão dele.
 * - Claude e Codex: cópia nativa até o corte, guardada em `fork_source` até o
 *   primeiro turno gravar a cópia. No Claude, o id da cópia é escolhido aqui.
 * - OpenCode: `fork_source` com o corte (nulo trabalhando) e o pacote.
 * - Kimi: conversa nova, e o pacote sai na hora como mensagem do Claudinei (o
 *   lugar 2: a fila do terminal só anda depois desse turno).
 */
export async function forkTerminal(deps: ForkDeps, req: { projectId: number; engine: string; name?: string; user?: AuthUser }):
  Promise<{ project: Project; session: SessionInfo }> {
  if (!canFork(req.user)) throw new UserError('fork_admin_only', 'Só um administrador pode criar terminais')
  const projects = createProjectsService(deps.db)
  const original = projects.get(req.projectId)
  if (!original) throw new UserError('project_not_found', 'projeto não existe')
  const origin = originOf(deps, req.projectId, req.engine)
  if (!origin || !SAFE_ID.test(origin.sourceId)) throw noConversation()
  const plan = await planOf(deps, req.engine, original.path, origin)

  const id = createBranchProject(deps.db, req.projectId, req.engine, req.name, plan.cutAt)
  const project = projects.get(id)!
  let session: SessionInfo
  try {
    session = deps.manager.start(project, {
      engine: req.engine,
      model: origin.model ?? undefined,
      effort: origin.effort ?? undefined,
      permissionMode: (origin.permissionMode ?? undefined) as PermissionMode | undefined,
      continueLatest: false,
      ...(plan.forkSource ? { forkSource: plan.forkSource } : {}),
    })
  } catch (err) {
    // Sem sessão o ramo não serve: o terminal recém-criado sai junto.
    deps.db.prepare('DELETE FROM projects WHERE id=?').run(id)
    throw err
  }
  if (plan.seed !== undefined && !plan.forkSource) {
    try {
      deps.manager.sendAsClaudinei(session.localId, plan.seed)
    } catch (err) {
      // O terminal e a sessão já existem: o operador segue sem o contexto.
      console.error('[ramo] o pacote não saiu', err)
    }
  }
  return { project, session: deps.manager.get(session.localId) ?? session }
}
