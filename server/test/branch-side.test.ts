import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import type { SessionStatus } from '../src/claude/session.js'
import type { AgentEvent, Engine, EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { cutFor, type CutPoint, type ExecLike } from '../src/branch/cut.js'
import type { Handoff } from '../src/branch/handoff.js'
import { claudeBranchArgs, kimiSideHome } from '../src/branch/engine-args.js'
import { createSideService, SIDE_EVENTS_MAX_BYTES, type SideMain } from '../src/branch/side.js'
import { cleanupSideTrace, listSideThreads, recordSideThread, sideThreadIds } from '../src/branch/side-threads.js'
import { foreignThreadIds } from '../src/project-threads.js'
import { historyConversationId } from '../src/routes/sessions.js'
import { transcriptPath } from '../src/history.js'
import '../src/engine/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLAUDE_FIX = join(__dirname, 'fixtures', 'branch', 'claude-transcript.jsonl')
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
const U = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`
const PACOTE = '[Claudinei: context handoff]: PACOTE'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Sessão falsa da lateral: grava as opções e os envios; o teste manda nos eventos e no status. */
class SideFake extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  lastStderr = ''
  sends: string[] = []
  stopped = false
  interrupted = 0
  constructor(readonly engine: string, readonly opts: EngineSessionOptions) { super() }
  set(s: SessionStatus) { if (this.status !== s) { this.status = s; this.emit('status', s) } }
  ev(e: AgentEvent) { this.emit('event', e) }
  start(): void { this.set('idle') }
  send(text: string): void {
    if (this.status === 'dead' || this.status === 'stopped') throw new Error('sessão encerrada')
    this.sends.push(text)
    this.set('working')
  }
  markRead(): void {}
  async interrupt(): Promise<void> { this.interrupted++ }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; this.set('stopped') }
}

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDINEI_KIMI_HOMES', 'CODEX_HOME', 'CLAUDINEI_OPENCODE_BIN'] as const
let envAntes: Record<string, string | undefined>
let tmp: string
let cfg: string
let db: Db
let project: Project
let broadcasts: any[]
let fakes: SideFake[]
let mainState: SideMain | null
let runs: Array<[string, string[]]>
const run: ExecLike = async (file, args) => { runs.push([file, args]); return { stdout: '' } }

beforeEach(() => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'branch-side-'))
  cfg = join(tmp, 'claude')
  // Nunca os dados reais: tudo sob o tmp.
  process.env.CLAUDE_CONFIG_DIR = cfg
  process.env.CLAUDINEI_KIMI_HOMES = join(tmp, 'kimi-homes')
  process.env.CODEX_HOME = join(tmp, 'codex')
  process.env.CLAUDINEI_OPENCODE_BIN = join(tmp, 'nao-existe-opencode')
  db = openDb(':memory:')
  mkdirSync(join(tmp, 'projeto'))
  project = createProjectsService(db).create({ name: 'P1', path: join(tmp, 'projeto') })
  broadcasts = []
  fakes = []
  runs = []
  mainState = { localId: 'main-1', status: 'idle', engineSessionId: 'src-1', model: 'modelo-x', effort: 'high' }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

const corte = (over: Partial<CutPoint> = {}): CutPoint => ({ cut: 'turn-2', at: '2026-11-20T10:05:11.000Z', previewBefore: 500, ...over })
const pacote = (text = PACOTE): Handoff => ({ text, messages: 2, tokens: 10 })

function service(over: Partial<Parameters<typeof createSideService>[0]> = {}) {
  return createSideService({
    db,
    broadcast: (m) => broadcasts.push(m),
    main: () => mainState,
    projectPath: (id) => (id === project.id ? project.path : null),
    makeSession: (engine, opts) => { const s = new SideFake(engine, opts); fakes.push(s); return s },
    cutFor: async () => corte(),
    collect: async () => pacote(),
    cleanup: { claudeConfigDir: cfg, run },
    ...over,
  })
}

const sideStates = () => broadcasts.filter((b) => b.type === 'side_state')
const flush = () => new Promise((r) => setTimeout(r, 0))
const waitUntil = async (cond: () => boolean, ms = 3000) => {
  const inicio = Date.now()
  while (!cond()) {
    if (Date.now() - inicio > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('conversa lateral', () => {
  it('/side abre com fork nativo, ephemeral, readOnly, sem hermes, modelo e esforço da principal', async () => {
    const svc = service()
    const info = await svc.open(project.id, 'codex', 'pergunta', undefined)
    expect(fakes).toHaveLength(1)
    const o = fakes[0].opts
    expect(o.projectPath).toBe(project.path)
    expect(o.forkFrom).toEqual({ sourceId: 'src-1', cut: 'turn-2' })
    expect(o.ephemeral).toBe(true)
    expect(o.readOnly).toBe(true)
    expect(o.hermes).toBeUndefined()
    expect(o.permissionMode).toBeUndefined()
    expect(o.model).toBe('modelo-x')
    expect(o.effort).toBe('high')
    expect(fakes[0].sends).toEqual(['pergunta'])
    expect(info).toMatchObject({ projectId: project.id, engine: 'codex', mode: 'native', files: 'read_only', cutAt: '2026-11-20T10:05:11.000Z', question: 'pergunta' })
    expect(sideStates().at(-1)).toMatchObject({ projectId: project.id, engine: 'codex', side: { id: info.id } })
    // O eco mostra a pergunta na coluna.
    const snap = svc.snapshot(project.id, 'codex')!
    expect(snap.side.id).toBe(info.id)
    expect(snap.events.map((e: any) => e.message?.content?.[0]?.text)).toEqual(['pergunta'])
    // Codex efêmero não deixa nada para limpar.
    expect(listSideThreads(db)).toEqual([])

    // Claude: id escolhido, anotado para a limpeza; aviso de arquivos por motor.
    const c = await svc.open(project.id, 'claude', null)
    expect(fakes[1].opts.sessionId).toMatch(UUID_RE)
    expect(fakes[1].opts.hermes).toBeUndefined()
    expect(fakes[1].opts.permissionMode).toBeUndefined()
    expect(c.files).toBe('no_edit_tools')
    expect(fakes[1].sends).toEqual([])
    expect(listSideThreads(db)).toEqual([{ id: c.id, projectId: project.id, engine: 'claude', threadId: fakes[1].opts.sessionId }])
  })

  it('sem modelo nem esforço na principal: a lateral usa o padrão', async () => {
    mainState = { ...mainState!, model: null, effort: null }
    await service().open(project.id, 'codex', null)
    expect(fakes[0].opts.model).toBeUndefined()
    expect(fakes[0].opts.effort).toBeUndefined()
  })

  it('claude ocioso: sem --resume-session-at; trabalhando: com o uuid do último turno fechado', async () => {
    const destino = transcriptPath(cfg, project.path, CLAUDE_ID)
    mkdirSync(dirname(destino), { recursive: true })
    copyFileSync(CLAUDE_FIX, destino)
    mainState = { ...mainState!, engineSessionId: CLAUDE_ID }
    const svc = service({ cutFor })

    const ocioso = await svc.open(project.id, 'claude', null)
    expect(fakes[0].opts.forkFrom).toEqual({ sourceId: CLAUDE_ID })
    const argsOcioso = claudeBranchArgs([], fakes[0].opts)
    expect(argsOcioso).not.toContain('--resume-session-at')
    expect(argsOcioso).toEqual(expect.arrayContaining(['--resume', CLAUDE_ID, '--fork-session', '--no-session-persistence']))
    expect(ocioso.cutAt).toBe('2026-11-20T10:05:11.000Z')
    await svc.close(project.id, 'claude')

    mainState = { ...mainState!, status: 'working', turnStartedAt: Date.parse('2026-11-20T10:05:00.000Z') }
    const trabalhando = await svc.open(project.id, 'claude', 'e aí?')
    expect(fakes[1].opts.forkFrom).toEqual({ sourceId: CLAUDE_ID, cut: U(3) })
    const args = claudeBranchArgs([], fakes[1].opts)
    expect(args.slice(args.indexOf('--resume-session-at'), args.indexOf('--resume-session-at') + 2)).toEqual(['--resume-session-at', U(3)])
    expect(trabalhando.cutAt).toBe('2026-11-20T10:00:06.000Z')
  })

  it('dois open simultâneos: o segundo recebe side_exists', async () => {
    let solta!: () => void
    const espera = new Promise<void>((r) => { solta = r })
    let chamadas = 0
    const svc = service({ cutFor: async () => { chamadas++; await espera; return corte() } })
    const a = svc.open(project.id, 'codex', 'um', undefined)
    const b = svc.open(project.id, 'codex', 'dois', undefined)
    solta()
    const [ra, rb] = await Promise.allSettled([a, b])
    expect(ra.status).toBe('fulfilled')
    expect(rb.status).toBe('rejected')
    expect((rb as PromiseRejectedResult).reason.code).toBe('side_exists')
    expect(chamadas).toBe(1)
    expect(fakes).toHaveLength(1)
    // O replace também não atropela uma abertura em curso.
    const svc2 = service({ cutFor: async () => { await new Promise((r) => setTimeout(r, 5)); return corte() } })
    const c = svc2.open(project.id, 'claude', null)
    await expect(svc2.open(project.id, 'claude', null, { replace: true })).rejects.toMatchObject({ code: 'side_exists' })
    await c
  })

  it('replace fecha a antiga e abre a nova', async () => {
    const svc = service()
    const velha = await svc.open(project.id, 'claude', 'um')
    await expect(svc.open(project.id, 'claude', 'dois')).rejects.toMatchObject({ code: 'side_exists' })
    const nova = await svc.open(project.id, 'claude', 'dois', { replace: true })
    expect(nova.id).not.toBe(velha.id)
    expect(fakes[0].stopped).toBe(true)
    expect(fakes[1].sends).toEqual(['dois'])
    expect(svc.snapshot(project.id, 'claude')!.side.id).toBe(nova.id)
    expect(listSideThreads(db).map((r) => r.id)).toEqual([nova.id])
    expect(sideStates().at(-1).side.id).toBe(nova.id)
  })

  it('sem engineSessionId: no_conversation', async () => {
    mainState = { ...mainState!, engineSessionId: null }
    const svc = service()
    await expect(svc.open(project.id, 'codex', 'oi')).rejects.toMatchObject({ code: 'no_conversation' })
    mainState = null
    await expect(svc.open(project.id, 'codex', 'oi')).rejects.toMatchObject({ code: 'no_conversation' })
    expect(fakes).toHaveLength(0)
    expect(svc.snapshot(project.id, 'codex')).toBeNull()
    // A chave volta a ficar livre.
    mainState = { localId: 'm', status: 'idle', engineSessionId: 'src-1', model: null, effort: null }
    await expect(svc.open(project.id, 'codex', 'oi')).resolves.toMatchObject({ engine: 'codex' })
  })

  it('claude trabalhando no primeiro turno: no_conversation', async () => {
    const destino = transcriptPath(cfg, project.path, CLAUDE_ID)
    mkdirSync(dirname(destino), { recursive: true })
    copyFileSync(CLAUDE_FIX, destino)
    // O turno em curso começou antes de toda entrada do transcript: nada fechado.
    mainState = { ...mainState!, engineSessionId: CLAUDE_ID, status: 'working', turnStartedAt: Date.parse('2026-11-20T09:00:00.000Z') }
    const svc = service({ cutFor })
    await expect(svc.open(project.id, 'claude', 'oi')).rejects.toMatchObject({ code: 'no_conversation' })
    // Trabalhando sem o início do turno também.
    mainState = { ...mainState!, turnStartedAt: undefined }
    await expect(svc.open(project.id, 'claude', 'oi')).rejects.toMatchObject({ code: 'no_conversation' })
    expect(fakes).toHaveLength(0)
    expect(listSideThreads(db)).toEqual([])
  })

  it('kimi: primeira mensagem é o pacote + "=== request ===" + pergunta, num envio só', async () => {
    const coletas: any[] = []
    const svc = service({ collect: async (_e, path, id, opts) => { coletas.push([path, id, opts]); return pacote() } })
    const info = await svc.open(project.id, 'kimi', 'pergunta')
    expect(fakes[0].sends).toEqual([`${PACOTE}\n\n=== request ===\npergunta`])
    expect(fakes[0].opts.forkFrom).toBeUndefined()
    expect(fakes[0].opts.dataRoot).toBe(kimiSideHome(info.id))
    expect(fakes[0].opts.dataRoot!.startsWith(join(tmp, 'kimi-homes'))).toBe(true)
    expect(coletas).toEqual([[project.path, 'src-1', { working: false }]])
    expect(info).toMatchObject({ mode: 'seed', files: 'can_write' })
    // O eco é só a pergunta, nunca o pacote.
    const textos = svc.snapshot(project.id, 'kimi')!.events.map((e: any) => e.message?.content?.[0]?.text)
    expect(textos).toEqual(['pergunta'])
    expect(listSideThreads(db)).toEqual([{ id: info.id, projectId: project.id, engine: 'kimi', threadId: null }])

    // Sem pergunta: o pacote espera a primeira mensagem, e só ela.
    await svc.close(project.id, 'kimi')
    await svc.open(project.id, 'kimi', null)
    expect(fakes[1].sends).toEqual([])
    svc.send(project.id, 'kimi', 'primeira')
    fakes[1].set('idle')
    svc.send(project.id, 'kimi', 'segunda')
    expect(fakes[1].sends).toEqual([`${PACOTE}\n\n=== request ===\nprimeira`, 'segunda'])
  })

  it('kimi sem mensagens para copiar: no_conversation', async () => {
    const svc = service({ collect: async () => null })
    await expect(svc.open(project.id, 'kimi', 'oi')).rejects.toMatchObject({ code: 'no_conversation' })
    expect(listSideThreads(db)).toEqual([])
  })

  it('opencode com a principal trabalhando: seed', async () => {
    const coletas: any[] = []
    let cortes = 0
    mainState = { ...mainState!, engineSessionId: 'ses_SRC', status: 'working' }
    const svc = service({
      cutFor: async () => { cortes++; return corte({ cut: 'msg_LAST', at: null }) },
      collect: async (_e, _p, _id, opts) => { coletas.push(opts); return pacote() },
    })
    const info = await svc.open(project.id, 'opencode', 'pergunta')
    expect(info.mode).toBe('seed')
    expect(cortes).toBe(0)
    // Sem `before` junto do `working`.
    expect(coletas).toEqual([{ working: true }])
    expect(fakes[0].opts.forkFrom).toBeUndefined()
    expect(fakes[0].sends).toEqual([`${PACOTE}\n\n=== request ===\npergunta`])
    await svc.close(project.id, 'opencode')

    // Ociosa: cópia nativa, sem corte (o --fork copia tudo).
    mainState = { ...mainState!, status: 'idle' }
    const nativa = await svc.open(project.id, 'opencode', 'pergunta')
    expect(nativa.mode).toBe('native')
    expect(fakes[1].opts.forkFrom).toEqual({ sourceId: 'ses_SRC' })
    expect(fakes[1].sends).toEqual(['pergunta'])
    await svc.close(project.id, 'opencode')

    // Ociosa sem última mensagem (conversa vazia, export que falhou): no_conversation.
    const vazia = service({ cutFor: async () => corte({ cut: null, at: null }) })
    await expect(vazia.open(project.id, 'opencode', 'x')).rejects.toMatchObject({ code: 'no_conversation' })
  })

  it('opencode: pacote acima do limite vira erro do turno na coluna, sem recriar', async () => {
    // O OpenCode recusa o prompt grande com um result de erro, sem sair de idle.
    class Grande extends SideFake {
      send(text: string): void {
        this.sends.push(text)
        this.ev({ kind: 'result', subtype: 'error', isError: true, resultText: 'mensagem grande demais', costUsd: 0, raw: {} })
      }
    }
    mainState = { ...mainState!, engineSessionId: 'ses_SRC', status: 'working' }
    const svc = service({ makeSession: (engine, opts) => { const s = new Grande(engine, opts); fakes.push(s); return s } })
    await svc.open(project.id, 'opencode', 'pergunta')
    await flush()
    const snap = svc.snapshot(project.id, 'opencode')!
    expect(fakes).toHaveLength(1)
    expect(snap.side.status).toBe('idle')
    // O eco da pergunta vem antes do erro.
    expect(snap.events.map((e) => e.kind)).toEqual(['user', 'result'])
    expect(snap.events[1]).toMatchObject({ isError: true, resultText: 'mensagem grande demais' })
  })

  it('cópia recusada: recria em seed e reenvia a pergunta uma vez', async () => {
    const coletas: any[] = []
    const svc = service({ collect: async (_e, _p, _id, opts) => { coletas.push(opts); return pacote() } })
    const info = await svc.open(project.id, 'claude', 'pergunta')
    const primeiro = fakes[0]
    primeiro.lastStderr = 'No message found with message.uuid of: x'
    primeiro.set('dead') // antes do init
    await waitUntil(() => fakes.length === 2 && fakes[1].sends.length > 0)
    const segundo = fakes[1]
    expect(segundo.opts.forkFrom).toBeUndefined()
    expect(segundo.opts.sessionId).toBe(primeiro.opts.sessionId) // o mesmo id: uma anotação só para limpar
    expect(segundo.opts.readOnly).toBe(true)
    expect(segundo.opts.ephemeral).toBe(true)
    expect(segundo.opts.hermes).toBeUndefined()
    expect(segundo.opts.permissionMode).toBeUndefined()
    expect(coletas).toEqual([{ working: false, before: 500 }])
    expect(segundo.sends).toEqual([`${PACOTE}\n\n=== request ===\npergunta`])
    expect(svc.snapshot(project.id, 'claude')!.side).toMatchObject({ id: info.id, mode: 'seed' })
    // A pergunta não aparece duas vezes na coluna.
    const ecos = svc.snapshot(project.id, 'claude')!.events.filter((e) => e.kind === 'user')
    expect(ecos).toHaveLength(1)

    // Morre de novo antes do init: dead, com o erro na coluna, sem terceira tentativa.
    segundo.lastStderr = 'falhou de novo'
    segundo.set('dead')
    await flush()
    expect(fakes).toHaveLength(2)
    const snap = svc.snapshot(project.id, 'claude')!
    expect(snap.side.status).toBe('dead')
    expect(snap.events.at(-1)).toMatchObject({ kind: 'result', isError: true, resultText: 'falhou de novo' })
    expect(sideStates().at(-1).side.status).toBe('dead')
  })

  it('cópia recusada sem pergunta: o pacote espera a primeira mensagem', async () => {
    const svc = service()
    await svc.open(project.id, 'claude', null)
    fakes[0].set('dead')
    await waitUntil(() => fakes.length === 2)
    expect(fakes[1].sends).toEqual([])
    svc.send(project.id, 'claude', 'agora')
    expect(fakes[1].sends).toEqual([`${PACOTE}\n\n=== request ===\nagora`])
  })

  it('codex: cópia recusada vai a dead com o erro na coluna, sem recriar em seed', async () => {
    // Recriado em seed, o Codex abriria conversa persistente na pasta (o rollout
    // vazaria para a principal): a lateral morre com o erro visível.
    let coletas = 0
    const svc = service({ collect: async () => { coletas++; return pacote() } })
    await svc.open(project.id, 'codex', 'pergunta')
    fakes[0].lastStderr = 'thread/fork recusado'
    fakes[0].set('dead') // antes do init
    await flush()
    await flush()
    expect(fakes).toHaveLength(1)
    expect(coletas).toBe(0)
    const snap = svc.snapshot(project.id, 'codex')!
    expect(snap.side).toMatchObject({ status: 'dead', mode: 'native' })
    expect(snap.events.at(-1)).toMatchObject({ kind: 'result', isError: true, resultText: 'thread/fork recusado' })
    expect(sideStates().at(-1).side.status).toBe('dead')
    expect(listSideThreads(db)).toEqual([])
    await svc.close(project.id, 'codex')
    expect(runs).toEqual([])
  })

  it('fim de turno na lateral volta a idle (a lateral não tem "não lida")', async () => {
    const svc = service()
    await svc.open(project.id, 'claude', 'pergunta')
    fakes[0].ev({ kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} })
    fakes[0].set('needs_attention')
    expect(svc.snapshot(project.id, 'claude')!.side.status).toBe('idle')
    expect(sideStates().at(-1).side.status).toBe('idle')
    expect(sideStates().some((b) => b.side?.status === 'needs_attention')).toBe(false)
  })

  it('morte depois do init não recria', async () => {
    const svc = service()
    await svc.open(project.id, 'claude', 'pergunta')
    fakes[0].ev({ kind: 'init', sessionId: fakes[0].opts.sessionId!, model: 'm', slashCommands: [], raw: {} })
    fakes[0].set('dead')
    await flush()
    expect(fakes).toHaveLength(1)
    expect(svc.snapshot(project.id, 'claude')!.side.status).toBe('dead')
  })

  it('nada em sessions nem em project_threads depois de abrir, conversar e fechar', async () => {
    const conta = () => ({
      sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n,
      threads: (db.prepare('SELECT COUNT(*) AS n FROM project_threads').get() as any).n,
    })
    const antes = conta()
    mainState = { ...mainState!, engineSessionId: 'ses_SRC' }
    const svc = service({ cutFor: async () => corte({ cut: 'msg_LAST', at: null }) })
    for (const engine of ['claude', 'codex', 'opencode', 'kimi']) {
      await svc.open(project.id, engine, 'oi')
      const s = fakes.at(-1)!
      s.ev({ kind: 'init', sessionId: engine === 'opencode' ? 'ses_SIDE' : 'conv-lateral', model: 'm', slashCommands: [], raw: {} })
      s.ev({ kind: 'result', subtype: 'success', isError: false, resultText: 'resposta', costUsd: 0, raw: {} })
      s.set('idle')
      svc.send(project.id, engine, 'mais uma')
      await svc.close(project.id, engine)
    }
    expect(conta()).toEqual(antes)
    expect(listSideThreads(db)).toEqual([])
  })

  it('opencode: init com o id da principal não vira id da lateral nem leva ao delete da origem', async () => {
    mainState = { ...mainState!, engineSessionId: 'ses_MAIN' }
    const svc = service({ cutFor: async () => corte({ cut: 'msg_LAST', at: null }) })
    await svc.open(project.id, 'opencode', 'oi')
    // O `run --fork` anunciou primeiro o id da origem.
    fakes[0].ev({ kind: 'init', sessionId: 'ses_MAIN', model: 'm', slashCommands: [], raw: {} })
    expect(sideThreadIds(db, 'opencode').size).toBe(0)
    await svc.close(project.id, 'opencode')
    expect(runs).toEqual([])

    // O id certo, depois do da origem, é aceito; o da origem nunca.
    await svc.open(project.id, 'opencode', 'oi')
    fakes[1].ev({ kind: 'init', sessionId: 'ses_MAIN', model: 'm', slashCommands: [], raw: {} })
    fakes[1].ev({ kind: 'init', sessionId: 'ses_SIDE', model: 'm', slashCommands: [], raw: {} })
    fakes[1].ev({ kind: 'init', sessionId: 'ses_MAIN', model: 'm', slashCommands: [], raw: {} })
    expect(sideThreadIds(db, 'opencode')).toEqual(new Set(['ses_SIDE']))
    await svc.close(project.id, 'opencode')
    expect(runs).toEqual([[expect.any(String), ['session', 'delete', 'ses_SIDE']]])
  })

  it('fechar e bootCleanup não apagam id que seja conversa de terminal (sessions ou project_threads)', async () => {
    const claudeMain = '77777777-7777-4777-8777-777777777777'
    mkdirSync(join(tmp, 'projeto-2'))
    const outroProjeto = createProjectsService(db).create({ name: 'P2', path: join(tmp, 'projeto-2') })
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, claude_session_id) VALUES ('m1', ?, 'claude', 'stopped', ?)`)
      .run(project.id, claudeMain)
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'opencode', 'ses_PROT', 1)`).run(outroProjeto.id)
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'kimi', 'kimi-prot', 1)`).run(outroProjeto.id)
    mkdirSync(join(cfg, 'security'), { recursive: true })
    writeFileSync(join(cfg, 'security', `security_warnings_state_${claudeMain}.json`), '{}')
    mkdirSync(join(cfg, 'session-env', claudeMain), { recursive: true })
    mkdirSync(join(kimiSideHome('kimi-prot'), 'sessions'), { recursive: true })
    recordSideThread(db, { id: 'c1', projectId: project.id, engine: 'claude', threadId: claudeMain })
    recordSideThread(db, { id: 'o1', projectId: project.id, engine: 'opencode', threadId: 'ses_PROT' })
    recordSideThread(db, { id: 'kimi-prot', projectId: project.id, engine: 'kimi', threadId: null })

    await service().bootCleanup()

    expect(runs).toEqual([])
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${claudeMain}.json`))).toBe(true)
    expect(existsSync(join(cfg, 'session-env', claudeMain))).toBe(true)
    expect(existsSync(kimiSideHome('kimi-prot'))).toBe(true)

    // No fechamento também: a lateral do OpenCode cujo init trouxe o id de outro terminal.
    mainState = { ...mainState!, engineSessionId: 'ses_MAIN' }
    const svc = service({ cutFor: async () => corte({ cut: 'msg_LAST', at: null }) })
    await svc.open(project.id, 'opencode', 'oi')
    fakes[0].ev({ kind: 'init', sessionId: 'ses_PROT', model: 'm', slashCommands: [], raw: {} })
    await svc.close(project.id, 'opencode')
    expect(runs).toEqual([])
  })

  it('foreignThreadIds e a prévia ignoram o id da lateral do OpenCode enquanto ela existe', async () => {
    mainState = { ...mainState!, engineSessionId: 'ses_MAIN' }
    const svc = service({ cutFor: async () => corte({ cut: 'msg_LAST', at: null }) })
    await svc.open(project.id, 'opencode', 'oi')
    // O id da cópia chega no init do primeiro turno.
    fakes[0].ev({ kind: 'init', sessionId: 'ses_SIDE', model: 'm', slashCommands: [], raw: {} })
    expect(sideThreadIds(db, 'opencode')).toEqual(new Set(['ses_SIDE']))
    expect(foreignThreadIds(db, project.id, 'opencode').has('ses_SIDE')).toBe(true)
    expect(foreignThreadIds(db, project.id, 'claude').has('ses_SIDE')).toBe(false)

    // A prévia de um terminal sem conversa própria (continue_latest) numa pasta só dele.
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, continue_latest) VALUES ('l1', ?, 'opencode', 'starting', 1)`).run(project.id)
    const excluidos: Array<ReadonlySet<string> | undefined> = []
    const engine = {
      id: 'opencode',
      latestConversationId: (_p: string, exclude?: ReadonlySet<string>) => {
        excluidos.push(exclude)
        return exclude?.has('ses_SIDE') ? 'ses_MAIN' : 'ses_SIDE' // a lateral é a mais recente da pasta
      },
    } as unknown as Engine
    const info = { localId: 'l1', projectId: project.id, engine: 'opencode', engineSessionId: null }
    expect(historyConversationId(db, info, project.path, engine, { refresh: true })).toBe('ses_MAIN')

    await svc.close(project.id, 'opencode')
    expect(runs).toEqual([[expect.any(String), ['session', 'delete', 'ses_SIDE']]])
    expect(sideThreadIds(db, 'opencode').size).toBe(0)
    expect(foreignThreadIds(db, project.id, 'opencode').has('ses_SIDE')).toBe(false)
  })

  it('fechar mata, limpa os rastros do Claude e remove a linha de side_threads', async () => {
    const svc = service()
    const info = await svc.open(project.id, 'claude', 'oi')
    const tid = fakes[0].opts.sessionId!
    const outro = '33333333-3333-4333-8333-333333333333'
    // Os rastros dos hooks do usuário, da lateral e de OUTRA conversa.
    mkdirSync(join(cfg, 'security'), { recursive: true })
    for (const id of [tid, outro]) {
      writeFileSync(join(cfg, 'security', `security_warnings_state_${id}.json`), '{}')
      writeFileSync(join(cfg, 'security', `security_warnings_state_${id}.lock`), '')
      mkdirSync(join(cfg, 'session-env', id), { recursive: true })
    }
    await svc.close(project.id, 'claude')
    expect(fakes[0].stopped).toBe(true)
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${tid}.json`))).toBe(false)
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${tid}.lock`))).toBe(false)
    expect(existsSync(join(cfg, 'session-env', tid))).toBe(false)
    // Os da outra conversa continuam lá.
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${outro}.json`))).toBe(true)
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${outro}.lock`))).toBe(true)
    expect(existsSync(join(cfg, 'session-env', outro))).toBe(true)
    expect(listSideThreads(db)).toEqual([])
    expect(sideStates().at(-1)).toEqual({ type: 'side_state', projectId: project.id, engine: 'claude', side: null })
    expect(svc.snapshot(project.id, 'claude')).toBeNull()
    expect(() => svc.send(project.id, 'claude', 'x')).toThrow(expect.objectContaining({ code: 'side_not_found' }))
    await expect(svc.interrupt(project.id, 'claude')).rejects.toMatchObject({ code: 'side_not_found' })
    // Fechar de novo não faz nada.
    await svc.close(project.id, 'claude')
    expect(info.id).toBeTruthy()
  })

  it('fechar o Kimi apaga só o data root da lateral', async () => {
    const svc = service()
    const info = await svc.open(project.id, 'kimi', 'oi')
    const home = kimiSideHome(info.id)
    const vizinho = join(tmp, 'kimi-homes', 'abc123')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(vizinho, { recursive: true })
    await svc.close(project.id, 'kimi')
    expect(existsSync(home)).toBe(false)
    expect(existsSync(vizinho)).toBe(true)
  })

  it('interrupt e send vão só à lateral', async () => {
    const svc = service()
    await svc.open(project.id, 'codex', null)
    await svc.interrupt(project.id, 'codex')
    expect(fakes[0].interrupted).toBe(1)
    svc.send(project.id, 'codex', 'oi')
    expect(fakes[0].sends).toEqual(['oi'])
    expect(svc.snapshot(project.id, 'codex')!.side.question).toBe('oi')
  })

  it('onSessionEnded fecha a lateral', async () => {
    const svc = service()
    await svc.open(project.id, 'claude', 'oi')
    await svc.open(project.id, 'codex', 'oi')
    svc.onSessionEnded(project.id, 'claude')
    // A limpeza (rm dos rastros) roda depois: espera a anotação sair.
    await waitUntil(() => listSideThreads(db).length === 0)
    expect(fakes[0].stopped).toBe(true)
    expect(fakes[1].stopped).toBe(false)
    expect(svc.snapshot(project.id, 'claude')).toBeNull()
    expect(svc.snapshot(project.id, 'codex')).not.toBeNull()
    expect(listSideThreads(db)).toEqual([])
    // Sem lateral, nada acontece.
    expect(() => svc.onSessionEnded(project.id, 'kimi')).not.toThrow()
  })

  it('o gancho do manager fecha a lateral quando a principal encerra', async () => {
    let svc!: ReturnType<typeof service>
    class Main extends SideFake {}
    const mgr = createSessionManager({
      db, broadcast: () => {},
      sessionFactory: (opts) => new Main('claude', opts),
      onSessionEnded: (projectId, engine) => svc.onSessionEnded(projectId, engine),
    })
    const m = mgr.start(project, { engine: 'codex' })
    svc = service()
    await svc.open(project.id, 'codex', 'oi')
    await mgr.stop(m.localId)
    await waitUntil(() => fakes[0].stopped)
    expect(svc.snapshot(project.id, 'codex')).toBeNull()
  })

  it('dispose só para os processos; a subida limpa', async () => {
    const svc = service()
    await svc.open(project.id, 'claude', 'oi')
    await svc.dispose()
    expect(fakes[0].stopped).toBe(true)
    expect(listSideThreads(db)).toHaveLength(1)
    expect(sideStates().at(-1).side).not.toBeNull()
    await service().bootCleanup()
    expect(listSideThreads(db)).toEqual([])
  })

  it('bootCleanup apaga o que sobrou de uma queda', async () => {
    const claudeId = '44444444-4444-4444-8444-444444444444'
    const outro = '55555555-5555-4555-8555-555555555555'
    mkdirSync(join(cfg, 'security'), { recursive: true })
    for (const id of [claudeId, outro]) {
      writeFileSync(join(cfg, 'security', `security_warnings_state_${id}.json`), '{}')
      mkdirSync(join(cfg, 'session-env', id), { recursive: true })
    }
    const kimiSide = 'kimi-lateral-1'
    mkdirSync(join(kimiSideHome(kimiSide), 'sessions'), { recursive: true })
    const kimiVizinho = join(tmp, 'kimi-homes', 'side-outra')
    mkdirSync(kimiVizinho, { recursive: true })
    recordSideThread(db, { id: 'c1', projectId: project.id, engine: 'claude', threadId: claudeId })
    recordSideThread(db, { id: 'o1', projectId: project.id, engine: 'opencode', threadId: 'ses_ORFA' })
    recordSideThread(db, { id: 'o2', projectId: project.id, engine: 'opencode', threadId: null })
    recordSideThread(db, { id: kimiSide, projectId: project.id, engine: 'kimi', threadId: null })
    recordSideThread(db, { id: 'x1', projectId: project.id, engine: 'codex', threadId: 'thr' })

    await service().bootCleanup()

    expect(existsSync(join(cfg, 'security', `security_warnings_state_${claudeId}.json`))).toBe(false)
    expect(existsSync(join(cfg, 'session-env', claudeId))).toBe(false)
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${outro}.json`))).toBe(true)
    expect(existsSync(join(cfg, 'session-env', outro))).toBe(true)
    expect(runs).toEqual([[expect.any(String), ['session', 'delete', 'ses_ORFA']]])
    expect(existsSync(kimiSideHome(kimiSide))).toBe(false)
    expect(existsSync(kimiVizinho)).toBe(true)
    expect(listSideThreads(db)).toEqual([])
  })

  it('eventos acima de 2 MB descartam os mais antigos', async () => {
    const svc = service()
    await svc.open(project.id, 'codex', null)
    const grande = (i: number): AgentEvent => ({ kind: 'system', subtype: `s${i}`, raw: { pad: 'x'.repeat(256 * 1024) } })
    for (let i = 0; i < 12; i++) fakes[0].ev(grande(i))
    // Os `stream` são publicados mas não guardados.
    fakes[0].ev({ kind: 'stream', text: 'parcial', raw: {} })
    const evs = svc.snapshot(project.id, 'codex')!.events
    const total = evs.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0)
    expect(total).toBeLessThanOrEqual(SIDE_EVENTS_MAX_BYTES)
    expect(evs.length).toBeLessThan(12)
    expect(evs.at(-1)).toMatchObject({ subtype: 's11' })
    expect(evs.some((e) => e.kind === 'stream')).toBe(false)
    expect((evs[0] as any).subtype).toBe(`s${12 - evs.length}`)
    expect(broadcasts.filter((b) => b.type === 'side_event')).toHaveLength(13)
    expect(broadcasts.find((b) => b.type === 'side_event')).toMatchObject({ projectId: project.id, engine: 'codex', sideId: expect.any(String) })
  })

  it('erro de limite na lateral não chama nada do manager', async () => {
    const chamadas: string[] = []
    const all: any[] = []
    class Main extends SideFake {}
    const mgr = createSessionManager({
      db,
      broadcast: (m) => all.push(m),
      sessionFactory: (opts) => new Main('claude', opts),
      onUsageLimit: () => { chamadas.push('onUsageLimit') },
      onTurnResult: () => { chamadas.push('onTurnResult') },
      onNeedsOperator: () => { chamadas.push('onNeedsOperator') },
      onSessionDied: () => { chamadas.push('onSessionDied') },
      onSessionAvailable: () => { chamadas.push('onSessionAvailable') },
      onSessionEnded: () => { chamadas.push('onSessionEnded') },
      onOperatorMessage: () => { chamadas.push('onOperatorMessage') },
    })
    const m = mgr.start(project, { engine: 'claude' })
    await flush()
    chamadas.length = 0
    all.length = 0
    const svc = createSideService({
      db, broadcast: (msg) => all.push(msg),
      main: (projectId, engine) => {
        const info = mgr.list().find((s) => s.projectId === projectId && s.engine === engine)
        return info ? { ...info, turnStartedAt: mgr.turnStartedAt(info.localId) } : null
      },
      projectPath: () => project.path,
      makeSession: (engine, opts) => { const s = new SideFake(engine, opts); fakes.push(s); return s },
      cutFor: async () => corte({ cut: U(6) }),
      collect: async () => pacote(),
      cleanup: { claudeConfigDir: cfg, run },
    })
    db.prepare(`UPDATE sessions SET claude_session_id='src-1' WHERE local_id=?`).run(m.localId)
    await svc.open(project.id, 'claude', 'oi')
    const s = fakes[0]
    s.ev({ kind: 'init', sessionId: s.opts.sessionId!, model: 'm', slashCommands: [], raw: {} })
    s.ev({ kind: 'raw', raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 123 } } })
    s.ev({ kind: 'result', subtype: 'error', isError: true, resultText: "You've hit your limit · resets 3pm", costUsd: 0, raw: {} })
    s.set('needs_attention')
    s.set('dead')
    await flush()
    expect(chamadas).toEqual([])
    expect(all.every((b) => b.type === 'side_state' || b.type === 'side_event')).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM terminal_state').get() as any).n).toBe(0)
    expect(mgr.get(m.localId)?.status).toBe('idle')
    // O erro fica na coluna.
    expect(svc.snapshot(project.id, 'claude')!.events.some((e) => e.kind === 'result' && e.isError)).toBe(true)
    await mgr.stop(m.localId)
  })
})

describe('cleanupSideTrace: só apaga o que é da lateral', () => {
  it('ids inválidos ou vazios não apagam nada', async () => {
    mkdirSync(join(cfg, 'session-env'), { recursive: true })
    mkdirSync(join(cfg, 'security'), { recursive: true })
    writeFileSync(join(cfg, 'security', 'security_warnings_state_.json'), '{}')
    const kimiRoot = join(tmp, 'kimi-homes')
    mkdirSync(join(kimiRoot, 'side-'), { recursive: true })
    for (const threadId of ['', '..', '../x', 'a/b', 'nao-e-uuid', '/']) {
      await cleanupSideTrace({ id: 'x', engine: 'claude', threadId }, { claudeConfigDir: cfg, run })
    }
    for (const threadId of ['', '..', '../x', 'a/b', '-rf', 'ses_a/b', 'ses_..']) {
      await cleanupSideTrace({ id: 'x', engine: 'opencode', threadId }, { claudeConfigDir: cfg, run })
    }
    for (const id of ['', '..', '../x', 'a/b', '.', 'x.y']) {
      await cleanupSideTrace({ id, engine: 'kimi', threadId: null }, { run })
    }
    expect(runs).toEqual([])
    expect(existsSync(join(cfg, 'session-env'))).toBe(true)
    expect(existsSync(join(cfg, 'security', 'security_warnings_state_.json'))).toBe(true)
    expect(existsSync(kimiRoot)).toBe(true)
    expect(existsSync(join(kimiRoot, 'side-'))).toBe(true)
  })

  it('config dir ou raiz do Kimi relativos não apagam nada', async () => {
    const id = '66666666-6666-4666-8666-666666666666'
    // Os caminhos relativos existem de fato, sob um cwd temporário.
    const cwdAntes = process.cwd()
    const cwd = mkdtempSync(join(tmpdir(), 'branch-side-cwd-'))
    process.chdir(cwd)
    try {
      mkdirSync(join('relativo', 'security'), { recursive: true })
      writeFileSync(join('relativo', 'security', `security_warnings_state_${id}.json`), '{}')
      writeFileSync(join('relativo', 'security', `security_warnings_state_${id}.lock`), '')
      mkdirSync(join('relativo', 'session-env', id), { recursive: true })
      mkdirSync(join('side-abc', 'sessions'), { recursive: true })
      await expect(cleanupSideTrace({ id: 'x', engine: 'claude', threadId: id }, { claudeConfigDir: 'relativo' })).resolves.toBeUndefined()
      process.env.CLAUDINEI_KIMI_HOMES = ''
      await expect(cleanupSideTrace({ id: 'abc', engine: 'kimi', threadId: null })).resolves.toBeUndefined()
      expect(existsSync(join(cwd, 'relativo', 'security', `security_warnings_state_${id}.json`))).toBe(true)
      expect(existsSync(join(cwd, 'relativo', 'security', `security_warnings_state_${id}.lock`))).toBe(true)
      expect(existsSync(join(cwd, 'relativo', 'session-env', id))).toBe(true)
      expect(existsSync(join(cwd, 'side-abc', 'sessions'))).toBe(true)
    } finally {
      process.chdir(cwdAntes)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('id protegido não chama o run nem apaga arquivos', async () => {
    const id = '88888888-8888-4888-8888-888888888888'
    mkdirSync(join(cfg, 'security'), { recursive: true })
    writeFileSync(join(cfg, 'security', `security_warnings_state_${id}.json`), '{}')
    mkdirSync(join(cfg, 'session-env', id), { recursive: true })
    mkdirSync(join(kimiSideHome('kimi-x'), 'sessions'), { recursive: true })
    const protegidos = new Set([id, 'ses_PROT', 'kimi-x'])
    const isProtected = (x: string) => protegidos.has(x)
    await cleanupSideTrace({ id: 'c', engine: 'claude', threadId: id }, { claudeConfigDir: cfg, run, isProtected })
    await cleanupSideTrace({ id: 'o', engine: 'opencode', threadId: 'ses_PROT' }, { run, isProtected })
    await cleanupSideTrace({ id: 'kimi-x', engine: 'kimi', threadId: null }, { run, isProtected })
    expect(runs).toEqual([])
    expect(existsSync(join(cfg, 'security', `security_warnings_state_${id}.json`))).toBe(true)
    expect(existsSync(join(cfg, 'session-env', id))).toBe(true)
    expect(existsSync(kimiSideHome('kimi-x'))).toBe(true)
  })

  it('codex: nada', async () => {
    await cleanupSideTrace({ id: 'x', engine: 'codex', threadId: 'thr' }, { claudeConfigDir: cfg, run })
    expect(runs).toEqual([])
  })
})
