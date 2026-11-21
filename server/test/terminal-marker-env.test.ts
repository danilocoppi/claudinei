import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Captura o `env` (e os args) de todo `spawn`, devolvendo um filho falso que
// não roda nada. O resto do child_process fica o verdadeiro.
const spawns: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawn = (file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    spawns.push({ file, args, env: opts?.env ?? process.env })
    const child: any = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 424242
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal: string = 'SIGTERM') => {
      if (child.signalCode !== null) return true
      child.signalCode = signal
      setImmediate(() => { child.emit('exit', null, signal); child.emit('close', null, signal) })
      return true
    }
    // Fechar o stdin encerra o filho, como faria a CLI de verdade.
    child.stdin.on('finish', () => child.kill('SIGTERM'))
    return child
  }
  return { ...real, spawn, default: { ...real, spawn } }
})

const { ClaudeSession } = await import('../src/claude/session.js')
const { claudeEngine } = await import('../src/engine/claude-engine.js')
const { CodexSession } = await import('../src/engine/codex/codex-session.js')
const { KimiSession } = await import('../src/engine/kimi/kimi-session.js')
const { OpenCodeSession } = await import('../src/engine/opencode/opencode-session.js')
const { openDb } = await import('../src/db.js')
const { createProjectsService } = await import('../src/projects.js')
const { createSessionManager } = await import('../src/claude/manager.js')
const { createSideService } = await import('../src/branch/side.js')
await import('../src/engine/index.js')
type EngineSession = import('../src/engine/types.js').EngineSession
type EngineSessionOptions = import('../src/engine/types.js').EngineSessionOptions
type SessionStatus = import('../src/claude/session.js').SessionStatus

const ENV_KEYS = ['CLAUDINEI_TERMINAL', 'CLAUDE_CONFIG_DIR', 'CLAUDINEI_KIMI_HOMES', 'CODEX_HOME'] as const
let envAntes: Record<string, string | undefined>
let tmp: string
const vivas: Array<{ stop(): Promise<void> }> = []

beforeEach(() => {
  envAntes = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'marker-env-'))
  // Nunca os dados reais: tudo sob o tmp.
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
  process.env.CLAUDINEI_KIMI_HOMES = join(tmp, 'kimi-homes')
  process.env.CODEX_HOME = join(tmp, 'codex')
  // O serviço tem um marcador próprio: nenhuma CLI pode herdá-lo.
  process.env.CLAUDINEI_TERMINAL = '1:fora'
  spawns.length = 0
})

afterEach(async () => {
  await Promise.all(vivas.splice(0).map((s) => s.stop().catch(() => {})))
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** Sobe a sessão do motor e devolve o env do spawn. */
function spawnDe(engine: string, marker: string | undefined) {
  const base = { projectPath: tmp, ...(marker !== undefined ? { terminalMarker: marker } : {}) }
  switch (engine) {
    case 'claude': {
      const s = claudeEngine.createSession({ ...base, bin: 'claude-falso' })
      vivas.push(s); s.start(); break
    }
    case 'codex': {
      // Com conversa para retomar, o app-server sobe já no start().
      const s = new CodexSession({ ...base, resumeSessionId: 'thread-1', binOverride: 'codex-falso' })
      vivas.push(s); s.start(); break
    }
    case 'kimi': {
      const s = new KimiSession({ ...base, dataRoot: join(tmp, 'kimi-root'), binOverride: 'kimi-falso' })
      vivas.push(s); s.start(); s.send('oi'); break
    }
    case 'opencode': {
      const s = new OpenCodeSession({ ...base, binOverride: 'opencode-falso' })
      vivas.push(s); s.start(); s.send('oi'); break
    }
  }
  expect(spawns).toHaveLength(1)
  return spawns[0]
}

describe('marcador CLAUDINEI_TERMINAL no spawn dos motores', () => {
  it.each(['claude', 'codex', 'kimi', 'opencode'])('%s: com o marcador, o env leva o do terminal', (engine) => {
    const { env } = spawnDe(engine, `7:${engine}`)
    expect(env.CLAUDINEI_TERMINAL).toBe(`7:${engine}`)
    // O resto do env de cada motor não muda.
    expect(env.PKG_EXECPATH).toBe('')
  })

  it.each(['claude', 'codex', 'kimi', 'opencode'])('%s: sem o marcador, o do serviço não vaza', (engine) => {
    const { env } = spawnDe(engine, undefined)
    expect('CLAUDINEI_TERMINAL' in env).toBe(false)
  })

  it('codex: o marcador também vai no shell_environment_policy do app-server', () => {
    const { args } = spawnDe('codex', '7:codex')
    expect(args).toContain('shell_environment_policy.set.CLAUDINEI_TERMINAL="7:codex"')
  })

  it('claude: a sessão crua também aceita o marcador', () => {
    const s = new ClaudeSession({ projectPath: tmp, claudeBin: 'claude-falso', terminalMarker: '9:claude' })
    vivas.push(s); s.start()
    expect(spawns[0].env.CLAUDINEI_TERMINAL).toBe('9:claude')
  })
})

/** Sessão falsa: só grava as opções com que nasceu. */
class Fake extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  lastStderr = ''
  constructor(readonly opts: EngineSessionOptions) { super() }
  set(s: SessionStatus) { if (this.status !== s) { this.status = s; this.emit('status', s) } }
  start(): void { this.set('idle') }
  send(): void { this.set('working') }
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.set('stopped') }
}

describe('marcador nas sessões do manager e no terminal interativo', () => {
  function montar() {
    const db = openDb(':memory:')
    const project = createProjectsService(db).create({ name: 'P1', path: tmp })
    const fakes: Fake[] = []
    const launches: any[] = []
    const mgr = createSessionManager({
      db,
      sessionFactory: (opts) => { const f = new Fake(opts); fakes.push(f); return f },
      broadcast: () => {},
      terminalLauncher: (opts) => { launches.push(opts); return 'token' },
    })
    return { db, project, fakes, launches, mgr }
  }

  it.each(['claude', 'codex'])('%s: create, revive e relaunch passam <id>:<motor>', async (engine) => {
    const { project, fakes, mgr } = montar()
    const marker = `${project.id}:${engine}`
    const info = mgr.start(project, { engine })
    expect(fakes.at(-1)!.opts.terminalMarker).toBe(marker)

    await mgr.stop(info.localId)
    mgr.revive(info.localId)
    expect(fakes).toHaveLength(2)
    expect(fakes.at(-1)!.opts.terminalMarker).toBe(marker)

    await mgr.relaunch(info.localId, { resumeSessionId: null })
    expect(fakes).toHaveLength(3)
    expect(fakes.at(-1)!.opts.terminalMarker).toBe(marker)
  })

  it('openInTerminal: o launcher recebe env.CLAUDINEI_TERMINAL do terminal', async () => {
    const { project, launches, mgr } = montar()
    const info = mgr.start(project, { engine: 'claude' })
    await mgr.openInTerminal(info.localId)
    expect(launches).toHaveLength(1)
    expect(launches[0].env.CLAUDINEI_TERMINAL).toBe(`${project.id}:claude`)
  })

  it('openInTerminal do kimi: o env da engine (KIMI_CODE_HOME) continua junto do marcador', async () => {
    const { project, launches, mgr } = montar()
    const info = mgr.start(project, { engine: 'kimi' })
    await mgr.openInTerminal(info.localId)
    expect(launches[0].env.CLAUDINEI_TERMINAL).toBe(`${project.id}:kimi`)
    expect(launches[0].env.KIMI_CODE_HOME).toBeTruthy()
  })
})

describe('marcador na conversa lateral', () => {
  it.each(['claude', 'codex', 'kimi'])('%s: side.base leva <id>:<motor>', async (engine) => {
    const db = openDb(':memory:')
    const project = createProjectsService(db).create({ name: 'P1', path: tmp })
    const made: EngineSessionOptions[] = []
    const svc = createSideService({
      db,
      broadcast: () => {},
      main: () => ({ localId: 'main-1', status: 'idle', engineSessionId: 'src-1', model: null, effort: null }),
      projectPath: (id) => (id === project.id ? project.path : null),
      makeSession: (_engine, opts) => { made.push(opts); return new Fake(opts) },
      cutFor: async () => ({ cut: 'turn-2', at: '2026-11-20T10:05:11.000Z', previewBefore: 500 }),
      collect: async () => ({ text: 'PACOTE', messages: 2, tokens: 10 }),
      cleanup: { claudeConfigDir: join(tmp, 'claude'), run: async () => ({ stdout: '' }) },
    })
    await svc.open(project.id, engine, null)
    expect(made).toHaveLength(1)
    expect(made[0].terminalMarker).toBe(`${project.id}:${engine}`)
    await svc.close(project.id, engine, { shutdown: true })
  })
})
