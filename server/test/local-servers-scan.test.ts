import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeProc, type FakeProcRoot } from './fake-proc.js'
import { listeningSockets, processLabel, readCmdline, readCwd, readMarker, readStat, socketOwners } from '../src/local-servers/proc.js'
import { createServerScanner } from '../src/local-servers/scan.js'

// O `readdirSync` de verdade, com cada pasta lida anotada: prova que a
// varredura não lê o `fd/` de quem não tem o marcador.
const fsLog = vi.hoisted(() => ({ readdirs: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readdirSync = ((path: Parameters<typeof fs.readdirSync>[0], ...rest: unknown[]) => {
    fsLog.readdirs.push(String(path))
    return (fs.readdirSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.readdirSync
  return { ...fs, default: { ...fs, readdirSync }, readdirSync }
})

const SELF = 100
const SERVICE_PORT = 9105
const mark = (m: string) => ({ CLAUDINEI_TERMINAL: m, PATH: '/usr/bin' })

let fp: FakeProcRoot
let project: string

beforeEach(() => {
  fp = fakeProc()
  project = mkdtempSync(join(tmpdir(), 'ls-projeto-'))
  // O Claudinei (100), o pai dele (50) e o init (1).
  fp.proc({ pid: 1, ppid: 0, comm: 'systemd' })
  fp.proc({ pid: 50, ppid: 1, comm: 'bash' })
  fp.proc({ pid: SELF, ppid: 50, pgrp: 90, comm: 'node' })
})

afterEach(() => {
  fp.cleanup()
  rmSync(project, { recursive: true, force: true })
})

const scanner = (extra: Partial<Parameters<typeof createServerScanner>[0]> = {}) =>
  createServerScanner({ procRoot: fp.root, selfPid: SELF, servicePort: SERVICE_PORT, ...extra })

describe('leitura do /proc', () => {
  it('lê só os sockets em LISTEN, do tcp e do tcp6, com host legível', () => {
    fp.proc({ pid: 300, ppid: 1 })
    const a = fp.listen(300, 5173)
    const b = fp.listen(300, 5173, { v6: true })
    const c = fp.listen(300, 8080, { v6: true, host: '00000000000000000000000001000000' })
    fp.connected(300, 3000)
    expect(listeningSockets(fp.root)).toEqual([
      { inode: a, port: 5173, host: '127.0.0.1' },
      { inode: b, port: 5173, host: '::' },
      { inode: c, port: 8080, host: '::1' },
    ])
    // Sem filtro vem também o socket da conexão; com `wanted`, só os pedidos.
    expect(socketOwners(fp.root).size).toBe(4)
    expect(socketOwners(fp.root, new Set([a, b, c]))).toEqual(new Map([[a, 300], [b, 300], [c, 300]]))
  })

  it('nada ilegível lança: /proc vazio, pid inexistente', () => {
    const vazio = mkdtempSync(join(tmpdir(), 'ls-vazio-'))
    try {
      expect(listeningSockets(vazio)).toEqual([])
      expect(socketOwners(vazio).size).toBe(0)
      expect(readStat(vazio, 1)).toBeNull()
      expect(readMarker(vazio, 1)).toBeNull()
      expect(readCmdline(vazio, 1)).toEqual([])
      expect(readCwd(vazio, 1)).toBeNull()
    } finally { rmSync(vazio, { recursive: true, force: true }) }
  })

  it('comm com espaço e parênteses ("(a) b)") é lido certo', () => {
    fp.proc({ pid: 300, ppid: 1, pgrp: 77, comm: '(a) b)', startTime: '4242', cmdline: [], env: mark('4:claude') })
    expect(readStat(fp.root, 300)).toEqual({ ppid: 1, pgrp: 77, startTime: '4242', comm: '(a) b)', state: 'S' })
    fp.listen(300, 5173)
    const [s] = scanner().forTerminal(4, 'claude', project)
    expect(s).toMatchObject({ pid: 300, label: '(a) b)', startTime: '4242' })
  })

  it('o /proc de verdade lê o próprio processo (só leitura)', () => {
    const st = readStat('/proc', process.pid)
    expect(st?.ppid).toBe(process.ppid)
    expect(st?.startTime).toMatch(/^\d+$/)
    expect(Array.isArray(listeningSockets('/proc'))).toBe(true)
  })
})

describe('processLabel', () => {
  it('nos dois exemplos', () => {
    expect(processLabel(['node', '/x/.bin/vite'], 'node')).toBe('vite')
    expect(processLabel(['python3', '-m', 'http.server', '8000'], 'python3')).toBe('http.server')
  })

  it('fora de interpretador: basename do argv0; sem cmdline: o comm', () => {
    expect(processLabel(['/usr/sbin/nginx', '-g', 'daemon off;'], 'nginx')).toBe('nginx')
    expect(processLabel(['node', '--inspect', '/app/server.js'], 'node')).toBe('server')
    expect(processLabel([], 'next-server')).toBe('next-server')
  })
})

describe('varredura dos servidores do terminal', () => {
  it("marcador exato: '4:claude' não pega '42:claude'", () => {
    fp.proc({ pid: 300, ppid: 1, env: mark('42:claude') })
    fp.listen(300, 5173)
    fp.proc({ pid: 301, ppid: 1, env: mark('4:claude') })
    fp.listen(301, 3000)
    fp.proc({ pid: 302, ppid: 1, env: mark('4:claude-x') })
    fp.listen(302, 3001)
    const s = scanner()
    expect(s.forTerminal(4, 'claude', project).map((x) => x.pid)).toEqual([301])
    expect(s.forTerminal(42, 'claude', project).map((x) => x.pid)).toEqual([300])
    expect(s.forTerminal(4, 'codex', project)).toEqual([])
  })

  /**
   * As árvores reais desta máquina (lidas do /proc em 21/11/2026):
   * - o Bash do Claude: `claude → /bin/bash -c …` (o shell é líder do próprio grupo);
   * - os MCP do operador: `claude → npm exec statewright mcp → sh -c statewright → node`,
   *   escutando em 127.0.0.1:47615–47621, no grupo da CLI.
   * `cliPgrp` é o grupo da CLI: o do Claudinei (90) nas conversas, o dela no pty.
   */
  const claudeTree = (cliPgrp: number) => {
    fp.proc({ pid: 200, ppid: SELF, pgrp: cliPgrp, comm: 'claude', cmdline: ['claude', '-p'], env: mark('4:claude') })
    // MCP: npm exec → sh → node, todos no grupo da CLI.
    fp.proc({ pid: 210, ppid: 200, pgrp: cliPgrp, comm: 'npm exec statew', cmdline: ['npm exec statewright mcp'], env: mark('4:claude') })
    fp.proc({ pid: 211, ppid: 210, pgrp: cliPgrp, comm: 'sh', cmdline: ['sh', '-c', "'statewright' mcp"], env: mark('4:claude') })
    fp.proc({ pid: 212, ppid: 211, pgrp: cliPgrp, comm: 'node-MainThread', cmdline: ['node', '/usr/local/bin/statewright', 'mcp'], env: mark('4:claude') })
    fp.listen(212, 47615)
    // O Bash do Claude (220, líder do grupo 220) sobe o vite (230).
    fp.proc({ pid: 220, ppid: 200, pgrp: 220, comm: 'bash', cmdline: ['/bin/bash', '-c', 'npm run dev'], env: mark('4:claude') })
    fp.proc({ pid: 230, ppid: 220, pgrp: 220, comm: 'node', cmdline: ['node', '/p/node_modules/.bin/vite'], startTime: '5555', env: mark('4:claude') })
    fp.listen(230, 5173)
  }

  for (const [caso, cliPgrp] of [['grupo do Claudinei (conversa)', 90], ['grupo da CLI (pty)', 200]] as const) {
    it(`MCP (CLI → npm exec → sh → node) fica fora; o servidor do Bash entra — ${caso}`, () => {
      claudeTree(cliPgrp)
      // A CLI escuta ela mesma também: fora.
      fp.listen(200, 7000)
      expect(scanner().forTerminal(4, 'claude', project)).toEqual([
        { pid: 230, port: 5173, host: '127.0.0.1', label: 'vite', startTime: '5555', marker: 'exact' },
      ])
    })
  }

  it('CLI → bash → sh → npm → node entra (o shell do agente decide, não o npm abaixo dele)', () => {
    claudeTree(90)
    fp.proc({ pid: 240, ppid: 220, pgrp: 220, comm: 'sh', env: mark('4:claude') })
    fp.proc({ pid: 241, ppid: 240, pgrp: 220, comm: 'npm run dev', cmdline: ['npm run dev'], env: mark('4:claude') })
    fp.proc({ pid: 242, ppid: 241, pgrp: 220, comm: 'node', cmdline: ['node', '/p/server.js'], env: mark('4:claude') })
    fp.listen(242, 3000)
    // O próprio shell do agente escutando (`bash -c 'exec 3<>/dev/tcp…'` à parte): é do agente, entra.
    fp.listen(220, 4000)
    expect(scanner().forTerminal(4, 'claude', project).map((x) => [x.pid, x.port])).toEqual([[242, 3000], [220, 4000], [230, 5173]])
  })

  it('shell de login (`-bash`) pelo argv0, com o comm de outro nome, também é do agente', () => {
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, comm: 'claude', env: mark('4:claude') })
    fp.proc({ pid: 220, ppid: 200, pgrp: 220, comm: 'sandbox', cmdline: ['-bash'], env: mark('4:claude') })
    fp.proc({ pid: 230, ppid: 220, pgrp: 220, env: mark('4:claude') })
    fp.listen(230, 5173)
    expect(scanner().forTerminal(4, 'claude', project).map((x) => x.pid)).toEqual([230])
  })

  it('outras ferramentas da CLI (node, uvx, python direto) ficam fora', () => {
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, comm: 'claude', env: mark('4:claude') })
    fp.proc({ pid: 210, ppid: 200, pgrp: 200, comm: 'node', cmdline: ['node', '/x/lsp.js'], env: mark('4:claude') })
    fp.listen(210, 6001)
    fp.proc({ pid: 211, ppid: 200, pgrp: 200, comm: 'uvx', cmdline: ['uvx', 'mcp-x'], env: mark('4:claude') })
    fp.proc({ pid: 212, ppid: 211, pgrp: 200, comm: 'python3', cmdline: ['python3', '-m', 'mcp_x'], env: mark('4:claude') })
    fp.listen(212, 6002)
    expect(scanner().forTerminal(4, 'claude', project)).toEqual([])
  })

  it('Codex do npm (node → codex nativo): o shell abaixo do binário entra; o MCP dele fica fora', () => {
    // `codex` é um script node que abre o binário nativo de mesmo nome.
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, comm: 'node-MainThread', cmdline: ['node', '/usr/local/bin/codex', 'app-server'], env: mark('4:codex') })
    fp.proc({ pid: 201, ppid: 200, pgrp: 200, comm: 'codex', cmdline: ['/x/vendor/codex/codex', 'app-server'], env: mark('4:codex') })
    fp.listen(201, 7001)
    fp.proc({ pid: 220, ppid: 201, pgrp: 220, comm: 'bash', cmdline: ['/bin/bash', '-lc', 'npm run dev'], env: mark('4:codex') })
    fp.proc({ pid: 230, ppid: 220, pgrp: 220, env: mark('4:codex') })
    fp.listen(230, 5173)
    fp.proc({ pid: 210, ppid: 201, pgrp: 200, comm: 'npm exec statew', cmdline: ['npm exec statewright mcp'], env: mark('4:codex') })
    fp.proc({ pid: 211, ppid: 210, pgrp: 200, comm: 'sh', env: mark('4:codex') })
    fp.proc({ pid: 212, ppid: 211, pgrp: 200, comm: 'node', cmdline: ['node', '/usr/local/bin/statewright', 'mcp'], env: mark('4:codex') })
    fp.listen(212, 47616)
    expect(scanner().forTerminal(4, 'codex', project).map((x) => [x.pid, x.port])).toEqual([[230, 5173]])
  })

  it('readotado (ppid 1), ciclo e ancestral ilegível: não acha a CLI e entra', () => {
    // `nohup … &`: readotado pelo init.
    fp.proc({ pid: 240, ppid: 1, comm: 'python3', cmdline: ['python3', '-m', 'http.server', '8000'], env: mark('4:claude') })
    fp.listen(240, 8000, { host: '00000000' })
    // Ciclo de ppid (o /proc mudou no meio da subida).
    fp.proc({ pid: 250, ppid: 251, env: mark('4:claude') })
    fp.proc({ pid: 251, ppid: 250, env: mark('4:claude') })
    fp.listen(250, 8001)
    // Pai que já não existe no /proc.
    fp.proc({ pid: 260, ppid: 999, env: mark('4:claude') })
    fp.listen(260, 8002)
    expect(scanner().forTerminal(4, 'claude', project)).toEqual([
      { pid: 240, port: 8000, host: '0.0.0.0', label: 'http.server', startTime: '1000', marker: 'exact' },
      { pid: 250, port: 8001, host: '127.0.0.1', label: 'node', startTime: '1000', marker: 'exact' },
      { pid: 260, port: 8002, host: '127.0.0.1', label: 'node', startTime: '1000', marker: 'exact' },
    ])
  })

  it('só lê o fd/ de quem tem o marcador', () => {
    claudeTree(90)
    // Sem marcador, com porta: o fd/ dele não é lido.
    fp.proc({ pid: 300, ppid: 1, env: { PATH: '/usr/bin' } })
    fp.listen(300, 9000)
    // environ ilegível também não.
    fp.proc({ pid: 301, ppid: 1, env: null })
    fp.listen(301, 9001)
    fsLog.readdirs.length = 0
    expect(scanner().forTerminal(4, 'claude', project).map((x) => x.pid)).toEqual([230])
    const fdDirs = fsLog.readdirs.filter((d) => d.endsWith('/fd')).map((d) => Number(d.split('/').at(-2))).sort((a, b) => a - b)
    expect(fdDirs).toEqual([200, 210, 211, 212, 220, 230])
    // Ninguém com o marcador: nem um fd/.
    const outro = scanner()
    fsLog.readdirs.length = 0
    for (const pid of [200, 210, 211, 212, 220, 230]) fp.kill(pid)
    expect(outro.forTerminal(4, 'claude', project)).toEqual([])
    expect(fsLog.readdirs.filter((d) => d.endsWith('/fd'))).toEqual([])
  })

  it('selfPid, ancestrais e porta do serviço ficam fora', () => {
    // O Claudinei de dev aberto de dentro de um terminal: ele e os pais têm o marcador.
    fp.proc({ pid: 1, ppid: 0, comm: 'systemd', env: mark('4:claude') })
    fp.proc({ pid: 50, ppid: 1, comm: 'bash', env: mark('4:claude') })
    fp.proc({ pid: SELF, ppid: 50, pgrp: 90, comm: 'node', env: mark('4:claude') })
    fp.listen(SELF, 9200)
    fp.listen(50, 9201)
    fp.listen(1, 9202)
    // O Chromium do serviço: filho direto do Claudinei.
    fp.proc({ pid: 250, ppid: SELF, comm: 'chrome-headless', env: mark('4:claude') })
    fp.listen(250, 9203)
    // Alguém com o marcador escutando na porta do serviço.
    fp.proc({ pid: 260, ppid: 1, env: mark('4:claude') })
    fp.listen(260, SERVICE_PORT)
    fp.proc({ pid: 261, ppid: 1, env: mark('4:claude') })
    fp.listen(261, 5173)
    expect(scanner().forTerminal(4, 'claude', project).map((x) => [x.pid, x.port])).toEqual([[261, 5173]])
  })

  it("processo sem marcador fica fora; com o motor em ENGINES_FILTERING_ENV e cwd dentro da pasta entra como 'cwd'", () => {
    const sub = join(project, 'web')
    mkdirSync(sub)
    const vizinha = `${project}-outra`
    mkdirSync(vizinha)
    try {
      fp.proc({ pid: 300, ppid: 1, env: { PATH: '/usr/bin' }, cwd: sub })
      fp.listen(300, 5173)
      fp.proc({ pid: 301, ppid: 1, env: { PATH: '/usr/bin' }, cwd: vizinha })
      fp.listen(301, 5174)
      // Com marcador de outro terminal e cwd dentro: não é "sem marcador".
      fp.proc({ pid: 302, ppid: 1, env: mark('9:kimi'), cwd: project })
      fp.listen(302, 5175)
      expect(scanner().forTerminal(4, 'claude', project)).toEqual([])
      expect(scanner().forTerminal(4, 'kimi', project)).toEqual([])
      const s = scanner({ filteringEngines: new Set(['kimi']) })
      expect(s.forTerminal(4, 'kimi', project)).toEqual([
        { pid: 300, port: 5173, host: '127.0.0.1', label: 'node', startTime: '1000', marker: 'cwd' },
      ])
      expect(s.forTerminal(4, 'claude', project)).toEqual([])
    } finally { rmSync(vizinha, { recursive: true, force: true }) }
  })

  it('plano B: pasta pedida pela primeira vez refaz a varredura; sem marcador fora dela, o fd/ não é lido', () => {
    const outra = mkdtempSync(join(tmpdir(), 'ls-projeto-b-'))
    try {
      let t = 1_000_000
      const s = scanner({ filteringEngines: new Set(['kimi']), now: () => t })
      fp.proc({ pid: 300, ppid: 1, env: { PATH: '/usr/bin' }, cwd: project })
      fp.listen(300, 5173)
      fp.proc({ pid: 301, ppid: 1, env: { PATH: '/usr/bin' }, cwd: outra })
      fp.listen(301, 5174)
      fp.proc({ pid: 302, ppid: 1, env: { PATH: '/usr/bin' }, cwd: '/' })
      fp.listen(302, 5175)
      fsLog.readdirs.length = 0
      expect(s.forTerminal(4, 'kimi', project).map((x) => x.pid)).toEqual([300])
      expect(fsLog.readdirs.filter((d) => d.endsWith('/fd'))).toEqual([join(fp.root, '300', 'fd')])
      // Dentro dos 2 s, outra pasta: a varredura guardada não olhou para ela.
      t += 10
      expect(s.forTerminal(5, 'kimi', outra).map((x) => x.pid)).toEqual([301])
      // A primeira continua servida pela mesma varredura.
      expect(s.forTerminal(4, 'kimi', project).map((x) => x.pid)).toEqual([300])
    } finally { rmSync(outra, { recursive: true, force: true }) }
  })

  it('environ ilegível (arquivo ausente) não quebra a varredura', () => {
    fp.proc({ pid: 300, ppid: 1, env: null })
    fp.listen(300, 5173)
    fp.proc({ pid: 301, ppid: 1, env: mark('4:claude') })
    fp.listen(301, 3000)
    // Um socket cujo dono não está mais no /proc também não quebra.
    fp.proc({ pid: 302, ppid: 1, env: mark('4:claude') })
    fp.listen(302, 3001)
    fp.kill(302)
    expect(scanner().forTerminal(4, 'claude', project).map((x) => x.pid)).toEqual([301])
  })

  it('a segunda chamada em menos de 2 s não relê /proc; depois de 2 s relê', () => {
    let t = 1_000_000
    const s = scanner({ now: () => t })
    fp.proc({ pid: 300, ppid: 1, env: mark('4:claude') })
    fp.listen(300, 5173)
    expect(s.forTerminal(4, 'claude', project).map((x) => x.port)).toEqual([5173])
    fp.proc({ pid: 301, ppid: 1, env: mark('5:codex') })
    fp.listen(301, 3000)
    t += 1999
    // A mesma varredura serve a outra chave: o 301 ainda não existe para ela.
    expect(s.forTerminal(5, 'codex', project)).toEqual([])
    expect(s.forTerminal(4, 'claude', project).map((x) => x.port)).toEqual([5173])
    t += 1
    expect(s.forTerminal(5, 'codex', project).map((x) => x.port)).toEqual([3000])
    // invalidate força a releitura.
    fp.kill(300)
    expect(s.forTerminal(4, 'claude', project)).toHaveLength(1)
    s.invalidate()
    expect(s.forTerminal(4, 'claude', project)).toEqual([])
  })

  it("tcp6 '::' com a mesma porta não duplica a entrada do mesmo pid", () => {
    fp.proc({ pid: 300, ppid: 1, env: mark('4:claude') })
    fp.listen(300, 5173, { host: '00000000' })
    fp.listen(300, 5173, { v6: true })
    fp.listen(300, 24678, { v6: true })
    expect(scanner().forTerminal(4, 'claude', project).map((x) => [x.port, x.host])).toEqual([[5173, '0.0.0.0'], [24678, '::']])
  })
})
