import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCodeBranchArgs, kimiSideHome } from '../src/branch/engine-args.js'
import { buildRunArgs, buildResumeArgs } from '../src/engine/opencode/opencode-args.js'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'
import { KimiSession } from '../src/engine/kimi/kimi-session.js'
import { ensureKimiHome, ensureKimiHomeAt, kimiHomeFor } from '../src/engine/kimi/kimi-home.js'
import { withRequest } from '../src/branch/handoff.js'
import type { AgentEvent, ForkFrom } from '../src/engine/types.js'

/**
 * Cópia no OpenCode (`run --fork -s <origem>`, booleano, sem ponto de corte) e
 * data root próprio no Kimi (a conversa lateral). Nada de CLI real: os fakes de
 * test/*.mjs e homes do Kimi em diretórios temporários.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_OC = join(__dirname, 'fake-opencode.mjs')
const FAKE_KIMI = join(__dirname, 'fake-kimi.mjs')

const waitFor = (c: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => { if (c()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) } }, 10)
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Textos das mensagens do agente, na ordem. */
const textsOf = (evs: AgentEvent[]) => evs
  .filter((e) => e.kind === 'assistant')
  .flatMap((e) => ((e as any).message.content as any[]).filter((b) => b.type === 'text').map((b) => b.text as string))
/** O argv que o fake do OpenCode recebeu (resposta ao prompt `__args__`). */
const argsOf = (evs: AgentEvent[]): string[] => JSON.parse(textsOf(evs).find((t) => t.startsWith('['))!)
/** A sequência aparece contígua nos args. */
const hasRun = (args: string[], run: string[]) =>
  args.some((_, i) => run.every((v, j) => args[i + j] === v))

describe('openCodeBranchArgs', () => {
  it('--fork -s e --agent plan antes do "--"', () => {
    const base = buildRunArgs({ prompt: 'oi', title: 'oi', model: 'm' })
    const out = openCodeBranchArgs(base, { forkSourceId: 'ses_src', readOnly: true })
    expect(out.slice(-2)).toEqual(['--', 'oi'])
    const sep = out.length - 2
    const fork = out.indexOf('--fork')
    const plan = out.indexOf('--agent')
    expect(hasRun(out, ['--fork', '-s', 'ses_src'])).toBe(true)
    expect(hasRun(out, ['--agent', 'plan'])).toBe(true)
    expect(fork).toBeGreaterThan(-1); expect(fork).toBeLessThan(sep)
    expect(plan).toBeGreaterThan(-1); expect(plan).toBeLessThan(sep)
    // o resto dos args segue igual, na mesma ordem
    expect(out.filter((a) => !['--fork', 'ses_src', '--agent', 'plan'].includes(a) && a !== '-s')).toEqual(base)
  })

  it('sem nenhum campo devolve os args iguais e não altera o array recebido', () => {
    const base = buildResumeArgs('ses_x', { prompt: 'oi' })
    const copy = [...base]
    expect(openCodeBranchArgs(base, {})).toEqual(base)
    openCodeBranchArgs(base, { forkSourceId: 'a', readOnly: true })
    expect(base).toEqual(copy)
  })

  it('prompt igual a "--" não engana: insere antes do separador, não antes do prompt', () => {
    const out = openCodeBranchArgs(buildRunArgs({ prompt: '--' }), { readOnly: true })
    expect(out.slice(-4)).toEqual(['--agent', 'plan', '--', '--'])
  })
})

describe('kimiSideHome', () => {
  const backup = process.env.CLAUDINEI_KIMI_HOMES
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kimi-homes-')); process.env.CLAUDINEI_KIMI_HOMES = root })
  afterEach(() => {
    if (backup === undefined) delete process.env.CLAUDINEI_KIMI_HOMES; else process.env.CLAUDINEI_KIMI_HOMES = backup
    rmSync(root, { recursive: true, force: true })
  })

  it('fica em <raiz dos homes>/side-<id>', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    expect(kimiSideHome(id)).toBe(join(root, `side-${id}`))
    expect(kimiSideHome('abc_D-9')).toBe(join(root, 'side-abc_D-9'))
  })

  it('recusa id vazio, com barra, com ".." ou fora de [A-Za-z0-9_-] (o caminho vai para um rm -rf)', () => {
    for (const bad of ['', '/', '..', '../x', 'a/b', 'a/../../b', '.', 'a b', 'a\0b', 'x.y']) {
      expect(() => kimiSideHome(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('OpenCode: cópia da conversa', () => {
  const mk = (o: { forkFrom?: ForkFrom; readOnly?: boolean }) =>
    new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE_OC], ...o })
  afterEach(() => { delete process.env.OPENCODE_FAKE_HANG })

  it('OpenCode ramo, original parado: a primeira mensagem roda com --fork -s src e o sessionId vira ses_FORK_src', async () => {
    let asked = 0
    const s = mk({ forkFrom: { sourceId: 'src', seed: 'PACOTE', nativeOk: async () => { asked++; return true } } })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__args__', { echoToClients: true })
    expect(s.status).toBe('working') // na hora, antes da resposta do nativeOk
    await waitFor(() => s.status === 'needs_attention')
    expect(asked).toBe(1)
    expect(s.sessionId).toBe('ses_FORK_src')
    const args = argsOf(evs)
    expect(hasRun(args, ['--fork', '-s', 'src'])).toBe(true)
    expect(args.at(-1)).toBe('__args__') // sem o pacote: a cópia já tem a conversa
    expect(evs.filter((e) => e.kind === 'result')).toHaveLength(1)
    // o eco mostra só o texto do operador
    expect(JSON.stringify(evs.find((e) => e.kind === 'user'))).not.toContain('PACOTE')

    // depois da primeira: -s <id da cópia>, sem --fork e sem perguntar de novo
    s.markRead()
    const evs2: AgentEvent[] = []; s.on('event', (e) => evs2.push(e))
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    const args2 = argsOf(evs2)
    expect(args2).not.toContain('--fork')
    expect(hasRun(args2, ['-s', 'ses_FORK_src'])).toBe(true)
    expect(asked).toBe(1)
    expect(s.sessionId).toBe('ses_FORK_src')
  })

  it('sem nativeOk a cópia nativa vale', async () => {
    const s = mk({ forkFrom: { sourceId: 'src' } }); s.start()
    s.send('oi'); await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('ses_FORK_src')
  })

  it('OpenCode ramo, original andou: a primeira mensagem leva o pacote e o texto, sem --fork, num turno só', async () => {
    const s = mk({ forkFrom: { sourceId: 'src', seed: 'PACOTE', nativeOk: async () => false } }); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__args__'); expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    const args = argsOf(evs)
    expect(args).not.toContain('--fork')
    expect(args).not.toContain('-s')
    expect(args.at(-1)).toBe(withRequest('PACOTE', '__args__'))
    // o título da conversa nova vem do texto do operador, não do cabeçalho do pacote
    expect(args[args.indexOf('--title') + 1]).toBe('__args__')
    expect(evs.filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(s.sessionId).toBe('ses_FAKE')
  })

  it('original andou e sem seed: vai só o texto', async () => {
    const s = mk({ forkFrom: { sourceId: 'src', nativeOk: async () => false } }); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    const args = argsOf(evs)
    expect(args).not.toContain('--fork')
    expect(args.at(-1)).toBe('__args__')
  })

  it('falha do nativeOk conta como "não vale"', async () => {
    const s = mk({ forkFrom: { sourceId: 'src', seed: 'PACOTE', nativeOk: async () => { throw new Error('export falhou') } } }); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    const args = argsOf(evs)
    expect(args).not.toContain('--fork')
    expect(args.at(-1)).toBe(withRequest('PACOTE', '__args__'))
  })

  it('pacote + texto acima do limite do argv: result de erro claro, sem spawn, sessão viva', async () => {
    const s = mk({ forkFrom: { sourceId: 'src', seed: 'x'.repeat(100_000), nativeOk: async () => false } }); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('y'.repeat(30_000)); await waitFor(() => evs.some((e) => e.kind === 'result'))
    const r = evs.find((e) => e.kind === 'result') as any
    expect(r.isError).toBe(true)
    expect(r.resultText).toMatch(/grande demais/)
    await waitFor(() => s.status !== 'working')
    expect(['idle', 'needs_attention']).toContain(s.status)
    expect(s.sessionId).toBeUndefined()
  })

  it('stop() enquanto o nativeOk responde: não spawna nada depois', async () => {
    let release!: (v: boolean) => void
    const s = mk({ forkFrom: { sourceId: 'src', nativeOk: () => new Promise<boolean>((r) => { release = r }) } }); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('oi'); expect(s.status).toBe('working')
    await s.stop(); expect(s.status).toBe('stopped')
    release(true); await sleep(300)
    expect(evs.some((e) => e.kind === 'assistant' || e.kind === 'result')).toBe(false)
    expect(s.sessionId).toBeUndefined()
  })

  it('interrupt() enquanto o nativeOk responde: volta a idle e a próxima mensagem decide de novo', async () => {
    let calls = 0
    let release!: (v: boolean) => void
    const s = mk({ forkFrom: { sourceId: 'src', nativeOk: () => { calls++; return calls === 1 ? new Promise<boolean>((r) => { release = r }) : Promise.resolve(true) } } })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('um'); expect(s.status).toBe('working')
    await s.interrupt(); expect(s.status).toBe('idle')
    release(true); await sleep(300)
    expect(evs.some((e) => e.kind === 'assistant' || e.kind === 'result')).toBe(false)
    s.send('dois'); await waitFor(() => s.status === 'needs_attention')
    expect(calls).toBe(2)
    expect(s.sessionId).toBe('ses_FORK_src')
    expect(textsOf(evs)).toEqual(['echo:dois'])
  })

  it('OpenCode lateral: --agent plan em todos os turnos', async () => {
    const s = mk({ readOnly: true, forkFrom: { sourceId: 'src' } }); s.start()
    const evs1: AgentEvent[] = []; const h1 = (e: AgentEvent) => evs1.push(e); s.on('event', h1)
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    s.off('event', h1); s.markRead()
    const a1 = argsOf(evs1)
    expect(hasRun(a1, ['--agent', 'plan'])).toBe(true)
    expect(hasRun(a1, ['--fork', '-s', 'src'])).toBe(true)

    const evs2: AgentEvent[] = []; s.on('event', (e) => evs2.push(e))
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    const a2 = argsOf(evs2)
    expect(hasRun(a2, ['--agent', 'plan'])).toBe(true)
    expect(hasRun(a2, ['-s', 'ses_FORK_src'])).toBe(true)
    expect(a2.indexOf('--agent')).toBeLessThan(a2.lastIndexOf('--'))
  })

  it('sem forkFrom nem readOnly: args iguais aos de sempre', async () => {
    const s = mk({}); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__args__'); await waitFor(() => s.status === 'needs_attention')
    expect(argsOf(evs)).toEqual(buildRunArgs({ prompt: '__args__', title: '__args__' }))
    expect(s.sessionId).toBe('ses_FAKE')
  })
})

describe('Kimi: data root próprio', () => {
  const backup = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, CLAUDINEI_KIMI_HOMES: process.env.CLAUDINEI_KIMI_HOMES }
  let userHome: string
  let homesRoot: string
  beforeEach(() => {
    userHome = mkdtempSync(join(tmpdir(), 'kimi-user-'))
    homesRoot = mkdtempSync(join(tmpdir(), 'kimi-homes-'))
    process.env.KIMI_CODE_HOME = userHome
    process.env.CLAUDINEI_KIMI_HOMES = homesRoot
    mkdirSync(join(userHome, 'credentials'), { recursive: true })
    writeFileSync(join(userHome, 'config.toml'), 'default_model = "k"')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    rmSync(userHome, { recursive: true, force: true })
    rmSync(homesRoot, { recursive: true, force: true })
  })

  it('Kimi com dataRoot: KIMI_CODE_HOME é o dir dado e tem os symlinks de login', async () => {
    const dir = kimiSideHome('side1')
    const s = new KimiSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE_KIMI], dataRoot: dir })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__home__'); await waitFor(() => s.status === 'needs_attention')
    expect(textsOf(evs)).toContain(dir)
    expect(lstatSync(join(dir, 'credentials')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, 'mcp.json'))).toBe(true)
    // a lateral não recebe hermes, e o home do projeto nem é criado
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers.hermes).toBeUndefined()
    expect(existsSync(kimiHomeFor('/tmp'))).toBe(false)
  })

  it('sem dataRoot o KIMI_CODE_HOME segue sendo o home do projeto', async () => {
    const s = new KimiSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE_KIMI] })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('__home__'); await waitFor(() => s.status === 'needs_attention')
    expect(textsOf(evs)).toContain(kimiHomeFor('/tmp'))
  })

  it('ensureKimiHome segue igual para o terminal', () => {
    const hermes = { command: 'node', args: ['/x/h.mjs'], apiUrl: 'http://127.0.0.1:1', projectId: 3, serviceTokenFile: '/t', engine: 'kimi' }
    const dir = ensureKimiHome('/tmp/proj-k', hermes as any)
    expect(dir).toBe(kimiHomeFor('/tmp/proj-k'))
    expect(lstatSync(join(dir, 'credentials')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers.hermes.env.CLAUDINEI_PROJECT_ID).toBe('3')
  })

  it('ensureKimiHomeAt cria o dir dado com os mesmos symlinks e é idempotente', () => {
    const dir = join(homesRoot, 'qualquer')
    expect(ensureKimiHomeAt(dir)).toBe(dir)
    expect(ensureKimiHomeAt(dir)).toBe(dir)
    expect(lstatSync(join(dir, 'credentials')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, 'sessions'))).toBe(false)
  })
})
