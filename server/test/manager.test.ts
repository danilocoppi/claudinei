import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js' // registra claude + codex (getEngine no openInTerminal)

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let db: Db
let project: Project
let broadcasts: object[]

beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  project = projects.create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  broadcasts = []
})

function makeManager() {
  return createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
}

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('SessionManager', () => {
  it('start cria sessão, persiste e broadcast de status flui', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    expect(info.projectId).toBe(project.id)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(mgr.get(info.localId)?.engineSessionId).toBe('fake-session-0001')
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.claude_session_id).toBe('fake-session-0001')
    expect(broadcasts.some((b: any) => b.type === 'session_status' && b.status === 'idle')).toBe(true)
    await mgr.stop(info.localId)
  })

  it('não permite 2 sessões ativas do mesmo projeto', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(() => mgr.start(project)).toThrow(/já possui sessão ativa/)
    await mgr.stop(info.localId)
  })

  it('interrupt delega à sessão viva e rejeita para localId desconhecido', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'tarefa demorada')
    await waitUntil(() => mgr.get(info.localId)?.status === 'working')
    await mgr.interrupt(info.localId)
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    await mgr.stop(info.localId)

    await expect(mgr.interrupt('nao-existe')).rejects.toThrow()
  })

  it('send flui e eventos são broadcast', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'olá')
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    expect(broadcasts.some((b: any) => b.type === 'session_event' && b.event.kind === 'result')).toBe(true)
    await mgr.stop(info.localId)
  })

  it('revive após morte respawna com resume', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'crash')
    await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
    const revived = mgr.revive(info.localId)
    expect(revived.localId).toBe(info.localId)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('list inclui sessões persistidas de execuções anteriores', () => {
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('old-1','sid-old',?, 'stopped')`).run(project.id)
    const mgr = makeManager()
    expect(mgr.list().find((s) => s.localId === 'old-1')?.status).toBe('stopped')
  })

  it('linhas ativas órfãs viram dead na criação do manager (varredura pós-restart)', () => {
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('orfa-1','sid-x',?, 'working')`).run(project.id)
    const mgr = makeManager()
    expect(mgr.get('orfa-1')?.status).toBe('dead')
  })

  it('revive de linha órfã funciona após a varredura', async () => {
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('orfa-2','sid-y',?, 'idle')`).run(project.id)
    const mgr = makeManager()
    const revived = mgr.revive('orfa-2')
    expect(revived.localId).toBe('orfa-2')
    await waitUntil(() => mgr.get('orfa-2')?.status === 'idle')
    await mgr.stop('orfa-2')
  })

  it('revive é bloqueado se o projeto tem outra sessão ativa', async () => {
    const mgr = makeManager()
    const a = mgr.start(project)
    await waitUntil(() => mgr.get(a.localId)?.status === 'idle')
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('dead-1','sid-z',?, 'dead')`).run(project.id)
    expect(() => mgr.revive('dead-1')).toThrow(/sessão ativa/)
    await mgr.stop(a.localId)
  })

  it('start faz broadcast imediato do status inicial (sessão visível antes de qualquer evento)', () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    expect(
      broadcasts.some((b: any) => b.type === 'session_status' && b.localId === info.localId),
    ).toBe(true)
    return mgr.stop(info.localId)
  })

  it('broadcast de session_status carrega projectId', () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    const statusMsgs = broadcasts.filter((b: any) => b.type === 'session_status')
    expect(statusMsgs.length).toBeGreaterThan(0)
    expect(statusMsgs.every((b: any) => b.projectId === project.id)).toBe(true)
    return mgr.stop(info.localId)
  })

  it('sessões terminais saem do mapa vivo: stopAll não rejeita e novo start funciona', async () => {
    const mgr = makeManager()
    const a = mgr.start(project)
    await waitUntil(() => mgr.get(a.localId)?.status === 'idle')
    await mgr.stop(a.localId)
    await expect(mgr.stopAll()).resolves.toBeUndefined()
    const b = mgr.start(project)
    await waitUntil(() => mgr.get(b.localId)?.status === 'idle')
    await mgr.stop(b.localId)
  })

  it('list retorna só a sessão mais recente por projeto (não cresce sem limite)', () => {
    for (const sid of ['s1','s2','s3']) {
      db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, updated_at) VALUES (?, ?, ?, 'stopped', datetime('now','+' || ? || ' seconds'))`).run(sid, sid, project.id, String(['s1','s2','s3'].indexOf(sid)))
    }
    const mgr = makeManager()
    const forProject = mgr.list().filter((s) => s.projectId === project.id)
    expect(forProject).toHaveLength(1)
    expect(forProject[0].localId).toBe('s3') // a mais recente
  })

  it('list mantém uma sessão POR ENGINE no mesmo projeto (1 Claude + 1 Codex não somem)', () => {
    // Regressão: as duas fora do `live` (ex.: ambas in_terminal/stopped) e o codex
    // mais recente — o dedup por PROJETO sumia com a do claude → a aba dela virava
    // "No Session" e o ▶ tentava iniciar e falhava calado (a engine já estava in_terminal).
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, updated_at) VALUES ('cl', ?, 'claude', 'stopped', datetime('now','-10 seconds'))`).run(project.id)
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, updated_at) VALUES ('cx', ?, 'codex', 'stopped', datetime('now'))`).run(project.id)
    const mgr = makeManager()
    const engines = mgr.list().filter((s) => s.projectId === project.id).map((s) => s.engine).sort()
    expect(engines).toEqual(['claude', 'codex'])
  })

  it('start repassa continueLatest/permissionMode à factory e persiste permission_mode', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project, { continueLatest: false, permissionMode: 'default' })
    expect(seen.at(-1)?.continueLatest).toBe(false)
    expect(seen.at(-1)?.permissionMode).toBe('default')
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.permission_mode).toBe('default')
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('setSessionOptions persiste effort; "auto" limpa; revive relança com o effort salvo', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => { seen.push(opts); return fakeFactory(opts) }
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'oi') // ganha engineSessionId p/ reviver depois
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')

    await mgr.setSessionOptions(info.localId, { effort: 'max' })
    let row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.effort).toBe('max')
    expect(mgr.get(info.localId)?.effort).toBe('max')

    await mgr.stop(info.localId)
    mgr.revive(info.localId)
    expect(seen.at(-1)?.effort).toBe('max') // --effort volta no relaunch
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')

    await mgr.setSessionOptions(info.localId, { effort: 'auto' })
    row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.effort).toBeNull() // auto = padrão (limpa)
    await mgr.stop(info.localId)
  })

  it('start repassa hermes (com projectId) à factory quando deps.hermes está configurado', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    const mgr = createSessionManager({
      db,
      sessionFactory: spyFactory,
      broadcast: (m) => broadcasts.push(m),
      hermes: { command: 'node', args: ['/x/hermes-mcp.mjs'], apiUrl: 'http://127.0.0.1:4832' },
    })
    const info = mgr.start(project)
    expect(seen.at(-1)?.hermes).toEqual({ command: 'node', args: ['/x/hermes-mcp.mjs'], apiUrl: 'http://127.0.0.1:4832', projectId: project.id, engine: 'claude' })
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('start sem deps.hermes não passa hermes à factory', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)
    expect(seen.at(-1)?.hermes).toBeUndefined()
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('start sem opts persiste permission_mode=bypassPermissions (default)', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    expect(info.permissionMode).toBe('bypassPermissions')
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.permission_mode).toBe('bypassPermissions')
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('start com model:"sonnet" persiste model e repassa à factory', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project, { model: 'sonnet' })
    expect(seen.at(-1)?.model).toBe('sonnet')
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.model).toBe('sonnet')
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('start sem model persiste model NULL', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.model == null).toBe(true)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('revive de row com model preserva o model na factory', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    db.prepare(
      `INSERT INTO sessions (local_id, claude_session_id, project_id, status, model) VALUES ('orfa-model','sid-model',?, 'idle', 'haiku')`,
    ).run(project.id)
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    mgr.revive('orfa-model')
    expect(seen.at(-1)?.model).toBe('haiku')
    await waitUntil(() => mgr.get('orfa-model')?.status === 'idle')
    await mgr.stop('orfa-model')
  })

  it('revive de row com permission_mode=default passa permissionMode:default à factory (continueLatest false)', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    db.prepare(
      `INSERT INTO sessions (local_id, claude_session_id, project_id, status, permission_mode) VALUES ('orfa-noperm','sid-noperm',?, 'idle', 'default')`,
    ).run(project.id)
    const mgr = createSessionManager({ db, sessionFactory: spyFactory, broadcast: (m) => broadcasts.push(m) })
    mgr.revive('orfa-noperm')
    expect(seen.at(-1)?.permissionMode).toBe('default')
    expect(seen.at(-1)?.continueLatest).toBeFalsy()
    await waitUntil(() => mgr.get('orfa-noperm')?.status === 'idle')
    await mgr.stop('orfa-noperm')
  })

  it('revive repassa hermes (com projectId) à factory quando deps.hermes está configurado', async () => {
    const seen: SessionOptions[] = []
    const spyFactory = (opts: SessionOptions) => {
      seen.push(opts)
      return fakeFactory(opts)
    }
    db.prepare(
      `INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('orfa-hermes','sid-hermes',?, 'idle')`,
    ).run(project.id)
    const mgr = createSessionManager({
      db,
      sessionFactory: spyFactory,
      broadcast: (m) => broadcasts.push(m),
      hermes: { command: 'node', args: ['/x/hermes-mcp.mjs'], apiUrl: 'http://127.0.0.1:4832' },
    })
    mgr.revive('orfa-hermes')
    expect(seen.at(-1)?.hermes).toEqual({ command: 'node', args: ['/x/hermes-mcp.mjs'], apiUrl: 'http://127.0.0.1:4832', projectId: project.id, engine: 'claude' })
    await waitUntil(() => mgr.get('orfa-hermes')?.status === 'idle')
    await mgr.stop('orfa-hermes')
  })

  it('broadcast de start carrega model e permissionMode (pill não mente)', async () => {
    const mgr = makeManager()
    const info = mgr.start(project, { permissionMode: 'plan' })
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const withFields = broadcasts.filter((b: any) => b.type === 'session_status' && b.localId === info.localId && b.permissionMode !== undefined)
    expect(withFields.length).toBeGreaterThan(0)
    expect((withFields[withFields.length - 1] as any).permissionMode).toBe('plan')
    await mgr.stop(info.localId)
  })

  it('broadcast de status dead inclui detail diagnóstico', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'crash')
    await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
    const deadMsg = broadcasts.filter((b: any) => b.type === 'session_status' && b.status === 'dead').at(-1) as any
    expect(deadMsg).toBeTruthy()
    expect(typeof deadMsg.detail).toBe('string')
    expect(deadMsg.detail.length).toBeGreaterThan(0)
  })

  describe('openInTerminal', () => {
    function makeManagerWithLauncher() {
      const launches: any[] = []
      let lastOnExit: (() => void) | undefined
      const terminalLauncher = (opts: any) => {
        launches.push(opts)
        lastOnExit = opts.onExit
        return 'fake-token'
      }
      const mgr = createSessionManager({
        db,
        sessionFactory: fakeFactory,
        broadcast: (m) => broadcasts.push(m),
        terminalLauncher,
      })
      return { mgr, launches, triggerExit: () => lastOnExit?.() }
    }

    it('para sessão idle: para o processo headless, marca in_terminal, chama o launcher e faz broadcast', async () => {
      const { mgr, launches } = makeManagerWithLauncher()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      const engineSessionId = mgr.get(info.localId)?.engineSessionId
      expect(engineSessionId).toBeTruthy()

      const result = await mgr.openInTerminal(info.localId)

      expect(result.status).toBe('in_terminal')
      expect(result.token).toBe('fake-token')
      expect(launches[0].localId).toBe(info.localId)
      expect(launches[0].file).toBeTruthy()
      expect(mgr.get(info.localId)?.status).toBe('in_terminal')
      const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
      expect(row.status).toBe('in_terminal')

      expect(launches).toHaveLength(1)
      expect(launches[0].cwd).toBe(project.path)
      // Toda sessão agora nasce com --dangerously-skip-permissions (Task 1); o
      // terminal interativo replica a mesma flag sempre — a engine.terminalCommand
      // do Claude monta exatamente esses args (resume + skip permissions).
      expect(launches[0].args).toEqual(['--resume', engineSessionId, '--dangerously-skip-permissions'])

      expect(
        broadcasts.some((b: any) => b.type === 'session_status' && b.localId === info.localId && b.status === 'in_terminal'),
      ).toBe(true)
    })

    it('quando o launcher chama onExit, status vira stopped e broadcast é emitido', async () => {
      const { mgr, triggerExit } = makeManagerWithLauncher()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      await mgr.openInTerminal(info.localId)
      broadcasts.length = 0

      triggerExit()

      expect(mgr.get(info.localId)?.status).toBe('stopped')
      const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
      expect(row.status).toBe('stopped')
      expect(
        broadcasts.some((b: any) => b.type === 'session_status' && b.localId === info.localId && b.status === 'stopped'),
      ).toBe(true)
    })

    it('se o launcher lança, a sessão volta para stopped (não fica presa em in_terminal)', async () => {
      const boom = () => {
        throw new Error('spawn falhou')
      }
      const mgr = createSessionManager({
        db,
        sessionFactory: fakeFactory,
        broadcast: (m) => broadcasts.push(m),
        terminalLauncher: boom,
      })
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      await expect(mgr.openInTerminal(info.localId)).rejects.toThrow(/spawn falhou/)
      expect(mgr.get(info.localId)?.status).toBe('stopped')
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(info.localId) as any
      expect(row.status).toBe('stopped')
      expect(
        broadcasts.some((b: any) => b.type === 'session_status' && b.localId === info.localId && b.status === 'stopped'),
      ).toBe(true)
    })

    it('sem claude_session_id: abre uma sessão NOVA no terminal (fresh, sem --resume)', async () => {
      const { mgr, launches } = makeManagerWithLauncher()
      db.prepare(
        `INSERT INTO sessions (local_id, project_id, status) VALUES ('sem-conversa', ?, 'stopped')`,
      ).run(project.id)
      await mgr.openInTerminal('sem-conversa')
      // engine default 'claude' → terminalCommand sem resumeSessionId = fresh (sem --resume)
      expect(launches).toHaveLength(1)
      expect(launches[0].args).toEqual(['--dangerously-skip-permissions'])
    })

    it('Codex sem claude_session_id no banco: retoma o último thread da pasta (rollout) em vez de abrir fresh', async () => {
      const codexHome = mkdtempSync(join(tmpdir(), 'codexhome-'))
      const prev = process.env.CODEX_HOME
      process.env.CODEX_HOME = codexHome
      try {
        const uuid = '019f5c1c-1cf7-75b0-9cbc-cecf17c3a8db'
        const dir = join(codexHome, 'sessions', '2026', '07', '13')
        mkdirSync(dir, { recursive: true })
        // Rollout do Codex cujo cwd bate com o projeto (like uma conversa anterior
        // cujo thread_id nunca foi gravado no banco — servidor antigo/crash).
        writeFileSync(
          join(dir, `rollout-2026-07-13T12-00-00-${uuid}.jsonl`),
          JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: project.path } }) + '\n',
        )
        const { mgr, launches } = makeManagerWithLauncher()
        db.prepare(
          `INSERT INTO sessions (local_id, project_id, status, engine) VALUES ('cx-noid', ?, 'stopped', 'codex')`,
        ).run(project.id)

        await mgr.openInTerminal('cx-noid')

        // Retomou o thread do rollout (não abriu fresh)
        expect(launches).toHaveLength(1)
        expect(launches[0].args).toEqual(['resume', uuid, '--dangerously-bypass-approvals-and-sandbox'])
        // E persistiu o id recuperado para as próximas aberturas
        const row = db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get('cx-noid') as any
        expect(row.claude_session_id).toBe(uuid)
      } finally {
        if (prev === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = prev
      }
    })

    it('lança erro se a sessão não existe', async () => {
      const { mgr } = makeManagerWithLauncher()
      await expect(mgr.openInTerminal('nao-existe')).rejects.toThrow(/não existe/)
    })

    it('send em sessão in_terminal lança erro (input bloqueado)', async () => {
      const { mgr } = makeManagerWithLauncher()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      await mgr.openInTerminal(info.localId)
      expect(() => mgr.send(info.localId, 'oi')).toThrow(/não está ativa/)
    })

    it('openInTerminal em sessão já in_terminal lança erro (evita duplo terminal)', async () => {
      const { mgr } = makeManagerWithLauncher()
      db.prepare(
        `INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('t1','sid-1',?, 'in_terminal')`,
      ).run(project.id)
      await expect(mgr.openInTerminal('t1')).rejects.toThrow(/já está aberta no terminal/)
    })

    it('openInTerminal rejeita session id inválido (defesa argv)', async () => {
      const { mgr } = makeManagerWithLauncher()
      db.prepare(
        `INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('t4','-x; rm',?, 'stopped')`,
      ).run(project.id)
      await expect(mgr.openInTerminal('t4')).rejects.toThrow(/inválido/)
    })
  })

  it('revive de sessão in_terminal é bloqueado', () => {
    // in_terminal criada DEPOIS da construção do manager (simula uma sessão viva
    // na execução atual — o boot normaliza só as órfãs de execuções anteriores).
    const mgr = makeManager()
    db.prepare(
      `INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('t2','sid-2',?, 'in_terminal')`,
    ).run(project.id)
    expect(() => mgr.revive('t2')).toThrow()
  })

  it('start é bloqueado quando o projeto tem sessão in_terminal', () => {
    const mgr = makeManager()
    db.prepare(
      `INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('t3','sid-3',?, 'in_terminal')`,
    ).run(project.id)
    expect(() => mgr.start(project)).toThrow(/aberta no terminal/)
  })

  describe('askAgent', () => {
    it('sem sessão ativa no projeto alvo, rejeita', async () => {
      const mgr = makeManager()
      await expect(mgr.askAgent(project.id, 'Outro Projeto', 'oi?')).rejects.toThrow(/has no active session/)
    })

    it('sessão alvo idle: envia a pergunta e resolve com o resultText da resposta', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')

      const answer = await mgr.askAgent(project.id, 'Projeto Origem', 'qual a boa?')

      expect(answer).toMatch(/eco: \[Question from agent of Projeto Origem\]: qual a boa\?/)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })

    it('sessão alvo ocupada (working): rejeita sem enviar', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      mgr.send(info.localId, 'demora um pouco')
      // status agora é 'working' (fake responde rápido, mas checamos síncrono após o send)
      await expect(mgr.askAgent(project.id, 'X', 'pergunta?')).rejects.toThrow(/busy/)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })

    it('sessão alvo morre antes de responder: rejeita', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      const p = mgr.askAgent(project.id, 'X', 'crash')
      await expect(p).rejects.toThrow()
      await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
    })

    it('timeout: rejeita se a resposta não chega a tempo', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      // o fake demora 300ms para responder a "devagar"; com timeoutMs=50 o
      // askAgent deve rejeitar por timeout antes do eco chegar.
      const p = mgr.askAgent(project.id, 'X', 'devagar', 50)
      await expect(p).rejects.toThrow(/timed out/)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })
  })

  describe('dispatchTask', () => {
    it('sem sessão ativa no projeto alvo: onComplete("failed", ...) é chamado sincronamente', () => {
      const mgr = makeManager()
      const calls: [string, string][] = []
      mgr.dispatchTask(project.id, 'Origem', 'faça algo', (status, result) => calls.push([status, result]))
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe('failed')
      expect(calls[0][1]).toMatch(/has no active session/)
    })

    it('sessão alvo idle: envia a tarefa e chama onComplete("completed", resultText) quando o alvo responde', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')

      const calls: [string, string][] = []
      mgr.dispatchTask(project.id, 'Origem', 'qual a boa?', (status, result) => calls.push([status, result]))
      // dispatchTask não bloqueia: nada chamado ainda de imediato (a resposta é async)
      expect(calls).toHaveLength(0)

      await waitUntil(() => calls.length > 0)
      expect(calls[0][0]).toBe('completed')
      expect(calls[0][1]).toMatch(/eco: \[Task from Origem\]: qual a boa\?/)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })

    it('sessão alvo ocupada (working): onComplete("failed", ...) é chamado sincronamente sem enviar', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      mgr.send(info.localId, 'demora um pouco')

      const calls: [string, string][] = []
      mgr.dispatchTask(project.id, 'X', 'tarefa?', (status, result) => calls.push([status, result]))
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe('failed')
      expect(calls[0][1]).toMatch(/busy/)

      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })

    it('sessão alvo morre antes de responder: onComplete("failed", ...) é chamado e os listeners são removidos', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')

      const calls: [string, string][] = []
      mgr.dispatchTask(project.id, 'X', 'crash', (status, result) => calls.push([status, result]))
      await waitUntil(() => calls.length > 0)
      expect(calls[0][0]).toBe('failed')
      await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
      // não deve haver double-call se o processo já morreu (listener hygiene)
      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toHaveLength(1)
    })

    it('timeout: onComplete("failed", "timed out") e listeners removidos (sem double-call)', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')

      const calls: [string, string][] = []
      mgr.dispatchTask(project.id, 'X', 'devagar', (status, result) => calls.push([status, result]), 50)
      await waitUntil(() => calls.length > 0)
      expect(calls[0][0]).toBe('failed')
      expect(calls[0][1]).toMatch(/timed out/)

      // o fake ainda responde 250ms depois (300ms total); garante que o onComplete
      // não é chamado de novo (listener foi removido no timeout).
      await new Promise((r) => setTimeout(r, 300))
      expect(calls).toHaveLength(1)

      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })
  })

  describe('onSessionAvailable hook (fila)', () => {
    it('dispara ao ficar idle após o init', async () => {
      const calls: number[] = []
      const mgr = createSessionManager({
        db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m),
        onSessionAvailable: (projectId) => calls.push(projectId),
      })
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      await waitUntil(() => calls.includes(project.id))
      await mgr.stop(info.localId)
    })

    it('dispara ao virar needs_attention após uma resposta (não dispara em working)', async () => {
      const calls: string[] = []
      const mgr = createSessionManager({
        db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m),
        onSessionAvailable: (projectId) => calls.push(`available:${projectId}`),
      })
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      calls.length = 0
      mgr.send(info.localId, 'oi')
      // logo após o send, status é 'working' — não deve disparar o hook
      expect(calls).toHaveLength(0)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await waitUntil(() => calls.includes(`available:${project.id}`))
      await mgr.stop(info.localId)
    })

    it('hasFreeSession: true quando idle/needs_attention, false quando working ou sem sessão', async () => {
      const mgr = makeManager()
      expect(mgr.hasFreeSession(project.id)).toBe(false)
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      expect(mgr.hasFreeSession(project.id)).toBe(true)
      mgr.send(info.localId, 'demora um pouco')
      expect(mgr.hasFreeSession(project.id)).toBe(false)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      expect(mgr.hasFreeSession(project.id)).toBe(true)
      await mgr.stop(info.localId)
    })
  })

  it('prune no arranque mantém só as N sessões terminais mais recentes por projeto', () => {
    // insere 4 sessões stopped para o mesmo projeto
    for (const [lid, up] of [['old-1', '1'], ['old-2', '2'], ['old-3', '3'], ['old-4', '4']]) {
      db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, updated_at) VALUES (?, ?, ?, 'stopped', datetime('now','+' || ? || ' seconds'))`).run(lid, 'sid-' + lid, project.id, up)
    }
    // cria o manager com keep=2 → deve sobrar só old-4 e old-3
    createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {}, keepSessionsPerProject: 2 })
    const rows = db.prepare(`SELECT local_id FROM sessions WHERE project_id=? ORDER BY local_id`).all(project.id) as any[]
    const ids = rows.map((r) => r.local_id)
    expect(ids).toContain('old-4')
    expect(ids).toContain('old-3')
    expect(ids).not.toContain('old-1')
    expect(ids).not.toContain('old-2')
  })


  it('normaliza sessões in_terminal órfãs para stopped no arranque (evita dead-end pós-restart)', () => {
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('it-1','sid-it',?, 'in_terminal')`).run(project.id)
    createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const row = db.prepare(`SELECT status FROM sessions WHERE local_id='it-1'`).get() as any
    expect(row.status).toBe('stopped')
  })

  describe('setSessionOptions (hot-swap)', () => {
    it('sessão viva: aplica no processo e persiste model + permission_mode', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      const out = await mgr.setSessionOptions(info.localId, { model: 'haiku', permissionMode: 'plan' })
      expect(out.model).toBe('haiku')
      expect(out.permissionMode).toBe('plan')
      const row = db.prepare('SELECT model, permission_mode FROM sessions WHERE local_id=?').get(info.localId) as any
      expect(row.model).toBe('haiku'); expect(row.permission_mode).toBe('plan')
      await mgr.stop(info.localId)
    })

    it('sessão parada: só persiste (não lança)', async () => {
      const mgr = makeManager()
      db.prepare(`INSERT INTO sessions (local_id, project_id, status) VALUES ('s-parada', ?, 'stopped')`).run(project.id)
      const out = await mgr.setSessionOptions('s-parada', { permissionMode: 'auto' })
      expect(out.permissionMode).toBe('auto')
    })

    it('start persiste o permissionMode escolhido', async () => {
      const mgr = makeManager()
      const info = mgr.start(project, { permissionMode: 'acceptEdits' })
      const row = db.prepare('SELECT permission_mode FROM sessions WHERE local_id=?').get(info.localId) as any
      expect(row.permission_mode).toBe('acceptEdits')
      await mgr.stop(info.localId)
    })

    it('sessão viva ocupada (working): lança e não aplica/persiste', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      mgr.send(info.localId, 'demora um pouco')
      await expect(mgr.setSessionOptions(info.localId, { model: 'haiku' })).rejects.toThrow(/trabalhando/)
      await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
      await mgr.stop(info.localId)
    })

    it('sessão inexistente: lança', async () => {
      const mgr = makeManager()
      await expect(mgr.setSessionOptions('nao-existe', { model: 'haiku' })).rejects.toThrow(/não existe/)
    })

    it('broadcast de session_status carrega model e permissionMode', async () => {
      const mgr = makeManager()
      const info = mgr.start(project)
      await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
      await mgr.setSessionOptions(info.localId, { model: 'opus', permissionMode: 'default' })
      const last = broadcasts.filter((b: any) => b.type === 'session_status' && b.localId === info.localId).at(-1) as any
      expect(last.model).toBe('opus')
      expect(last.permissionMode).toBe('default')
      await mgr.stop(info.localId)
    })
  })

})

describe('revive preserva a intenção de --continue', () => {
  const capturing = () => {
    const captured: SessionOptions[] = []
    const factory = (opts: SessionOptions) => {
      captured.push(opts)
      return new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
    }
    return { captured, factory }
  }

  it('sessão sem claude_session_id nascida com continue revive com continueLatest', async () => {
    const { captured, factory } = capturing()
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: () => {} })
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest) VALUES ('cont-1', ?, 'stopped', 1)`,
    ).run(project.id)
    mgr.revive('cont-1')
    expect(captured[0].resumeSessionId).toBeUndefined()
    expect(captured[0].continueLatest).toBe(true)
    await mgr.stop('cont-1')
  })

  it('sessão sem claude_session_id nascida SEM continue revive sem continueLatest', async () => {
    const { captured, factory } = capturing()
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: () => {} })
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest) VALUES ('cont-0', ?, 'stopped', 0)`,
    ).run(project.id)
    mgr.revive('cont-0')
    expect(captured[0].continueLatest).toBe(false)
    await mgr.stop('cont-0')
  })

  it('sessão COM claude_session_id revive com resume (continue irrelevante)', async () => {
    const { captured, factory } = capturing()
    const mgr = createSessionManager({ db, sessionFactory: factory, broadcast: () => {} })
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, claude_session_id, continue_latest) VALUES ('res-1', ?, 'stopped', 'sid-x', 1)`,
    ).run(project.id)
    mgr.revive('res-1')
    expect(captured[0].resumeSessionId).toBe('sid-x')
    expect(captured[0].continueLatest).toBeUndefined()
    await mgr.stop('res-1')
  })
})

describe('persistência de model/effort', () => {
  class StubSession extends (require('node:events').EventEmitter as any) {
    status = 'idle'
    sessionId?: string
    lastStderr = ''
    effortApplied?: string
    start() {}
    send() {}
    markRead() {}
    interrupt() { return Promise.resolve() }
    setModel() { return Promise.resolve() }
    setPermissionMode() { return Promise.resolve() }
    setEffort(e: string) { this.effortApplied = e; return Promise.resolve() }
    stop() { return Promise.resolve() }
  }

  it('effort persiste MESMO com a sessão working (o /effort vira mensagem e põe a sessão em working um instante antes do PATCH)', async () => {
    const stub = new StubSession()
    const mgr = createSessionManager({ db, broadcast: (m) => broadcasts.push(m), sessionFactory: () => stub as never })
    const info = mgr.start(project)
    stub.status = 'working'
    const updated = await mgr.setSessionOptions(info.localId, { effort: 'xhigh' })
    expect(updated.effort).toBe('xhigh')
    const row = db.prepare('SELECT effort FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.effort).toBe('xhigh')
    expect(stub.effortApplied).toBe('xhigh') // campo p/ próximo turno (no-op no Claude)
  })

  it('model/permissionMode durante working continuam recusados (hot-swap no meio do turno)', async () => {
    const stub = new StubSession()
    const mgr = createSessionManager({ db, broadcast: () => {}, sessionFactory: () => stub as never })
    const info = mgr.start(project)
    stub.status = 'working'
    await expect(mgr.setSessionOptions(info.localId, { model: 'opus' })).rejects.toThrow(/trabalhando/)
  })
})
