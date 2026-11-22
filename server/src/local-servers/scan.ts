// A varredura dos servidores locais de cada terminal: quem escuta numa porta
// TCP e tem o marcador do terminal no ambiente. Uma varredura do /proc,
// guardada `ttlMs`, serve a todas as chaves (a coluna de cada terminal pede a
// sua a cada 5 s). Ficam fora o próprio Claudinei e tudo o que é dele: os
// ancestrais, a porta do serviço, as CLIs, o pty e o Chromium (filhos diretos)
// e as ferramentas da própria CLI (servidores MCP, LSP), veja `ownedByClaudinei`.
import { realpathSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { ENGINES_FILTERING_ENV, markerInstance, terminalMarker } from './marker.js'
import {
  listPids, listeningSockets, processLabel, readCmdline, readCwd, readMarker, readStat, socketOwners, type ProcStat,
} from './proc.js'

export interface LocalServer {
  pid: number
  port: number
  host: string
  label: string
  /** O início do processo (`/proc/<pid>/stat`): o Parar o devolve, contra PID reaproveitado. */
  startTime: string
  /** `exact`: marcador do terminal; `cwd`: sem marcador, achado pela pasta (só Abrir). */
  marker: 'exact' | 'cwd'
}

/** O PID do Claudinei e os seus ancestrais, subindo pelo `ppid`. */
export function selfAndAncestors(procRoot: string, selfPid: number): Set<number> {
  const out = new Set<number>()
  let pid = selfPid
  while (pid > 0 && !out.has(pid)) {
    out.add(pid)
    const st = readStat(procRoot, pid)
    if (!st) break
    pid = st.ppid
  }
  return out
}

/**
 * Shells: a ferramenta de comando do agente (o Bash do Claude roda
 * `/bin/bash -c …` como filho direto da CLI; o Codex, `bash -lc …`).
 */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'ash', 'busybox'])

/** Limite da subida pelos ancestrais: mais fundo que isso conta como "não achou a CLI". */
const MAX_DEPTH = 64

type StatOf = (pid: number) => ProcStat | null

/** O `comm` ou o argv0 (sem caminho e sem o `-` do shell de login) é um shell. */
function isShell(procRoot: string, pid: number, st: ProcStat): boolean {
  if (SHELLS.has(st.comm)) return true
  const argv0 = readCmdline(procRoot, pid)[0]
  return argv0 !== undefined && SHELLS.has(basename(argv0).replace(/^-/, ''))
}

/** O processo tem o nome `name`: no `comm`, no argv0 ou no rótulo (`node …/codex` → `codex`). */
function named(procRoot: string, pid: number, st: ProcStat, name: string): boolean {
  const cmd = readCmdline(procRoot, pid)
  return st.comm === name || (cmd[0] !== undefined && basename(cmd[0]) === name) || processLabel(cmd, st.comm) === name
}

/**
 * O caminho da CLI até o processo, `[CLI, …, pid]`, subindo pelo `ppid` até um
 * processo com `ppid === selfPid`. `null` quando não chega nela: readotado
 * (PID 1 ou um subreaper), fora da árvore do Claudinei, ciclo, ancestral
 * ilegível ou mais fundo que `MAX_DEPTH`.
 */
function pathFromCli(selfPid: number, pid: number, st: ProcStat, statOf: StatOf): Array<{ pid: number; st: ProcStat }> | null {
  const chain = [{ pid, st }]
  const seen = new Set([pid])
  let cur = chain[0]
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (cur.st.ppid === selfPid) return chain.reverse()
    const ppid = cur.st.ppid
    if (ppid <= 1 || seen.has(ppid)) return null
    const pst = statOf(ppid)
    if (!pst) return null
    seen.add(ppid)
    cur = { pid: ppid, st: pst }
    chain.push(cur)
  }
  return null
}

/**
 * O processo é do Claudinei e não se lista nem se para: ele mesmo ou um
 * ancestral; um filho direto (CLI, pty, Chromium); ou uma ferramenta da
 * própria CLI.
 *
 * Quem decide é o filho da CLI no caminho até o processo. Um shell é a
 * ferramenta de comando do agente: o que roda abaixo dele (ou o próprio
 * shell) é do agente e entra. Outro programa (npm, npx, node, python, uvx…) é
 * ferramenta da CLI: os servidores MCP do operador sobem por
 * `npm exec → sh → node` e escutam em porta (`statewright mcp`, 47615–47621);
 * o `sh` deles está abaixo do `npm`, não é o filho da CLI. Readotado (subiu
 * até o PID 1 ou um subreaper sem achar a CLI) entra.
 *
 * A CLI que se reabre conta como ela mesma: o `codex` do npm é um `node` que
 * abre o binário nativo `codex`, e o shell do agente é filho deste.
 */
export function ownedByClaudinei(
  procRoot: string, selfPid: number, ancestors: ReadonlySet<number>, pid: number, st: ProcStat,
  statOf: StatOf = (p) => readStat(procRoot, p),
): boolean {
  if (ancestors.has(pid) || st.ppid === selfPid) return true
  const path = pathFromCli(selfPid, pid, st, statOf)
  if (!path) return false
  const cli = path[0]
  const name = processLabel(readCmdline(procRoot, cli.pid), cli.st.comm)
  let i = 1
  while (i < path.length && named(procRoot, path[i].pid, path[i].st, name)) i++
  // O próprio processo é a CLI reaberta.
  if (i >= path.length) return true
  return !isShell(procRoot, path[i].pid, path[i].st)
}

/** `child` é `root` ou fica dentro dele (não basta o prefixo: `/p` ≠ `/p-outra`). */
export function isInside(root: string, child: string): boolean {
  const r = resolve(root)
  const c = resolve(child)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** Um servidor visto na varredura, antes de filtrar pelo terminal. */
interface Seen {
  pid: number
  port: number
  host: string
  label: string
  startTime: string
  marker: string | null
  cwd: string | null
}

export interface ServerScannerOptions {
  procRoot?: string
  selfPid?: number
  servicePort: number
  /** Quanto a varredura vale (padrão 2 s). */
  ttlMs?: number
  now?: () => number
  /** Motores que filtram o ambiente (padrão `ENGINES_FILTERING_ENV`); o teste injeta. */
  filteringEngines?: ReadonlySet<string>
  /** O id da instância (padrão `markerInstance()`, lido a cada varredura); o teste injeta. */
  instance?: string
}

export function createServerScanner(o: ServerScannerOptions): {
  forTerminal(projectId: number, engine: string, projectPath: string): LocalServer[]
  /** Descarta a varredura guardada (depois de um Parar). */
  invalidate(): void
} {
  const procRoot = o.procRoot ?? '/proc'
  const selfPid = o.selfPid ?? process.pid
  const ttlMs = o.ttlMs ?? 2000
  const now = o.now ?? Date.now
  const filtering = o.filteringEngines ?? ENGINES_FILTERING_ENV
  const inst = () => o.instance ?? markerInstance()
  /** As pastas de projeto já pedidas por um motor do plano B (o caminho real). */
  const cwdRoots = new Set<string>()
  let cache: { at: number; seen: Seen[]; roots: ReadonlySet<string> } | null = null

  const scan = (roots: ReadonlySet<string>): Seen[] => {
    const sockets = listeningSockets(procRoot).filter((s) => s.port !== o.servicePort)
    if (sockets.length === 0) return []
    // Antes do `fd/` (a parte cara: um readlink por fd de cada processo), o
    // filtro barato: só pode entrar quem tem o marcador desta instância, de
    // qualquer terminal, ou, no plano B, quem não tem nenhum e trabalha numa
    // pasta pedida. Marcador de outra instância, ou o antigo sem id, fica fora
    // (nem pelo plano B: tem marcador, só não é desta).
    const mine = `${inst()}:`
    const markers = new Map<number, string | null>()
    const cwds = new Map<number, string>()
    for (const pid of listPids(procRoot)) {
      const marker = readMarker(procRoot, pid)
      if (marker !== null) { if (marker.startsWith(mine)) markers.set(pid, marker); continue }
      if (roots.size === 0) continue
      const cwd = readCwd(procRoot, pid)
      if (cwd !== null && [...roots].some((r) => isInside(r, cwd))) { markers.set(pid, null); cwds.set(pid, cwd) }
    }
    if (markers.size === 0) return []
    const owners = socketOwners(procRoot, new Set(sockets.map((s) => s.inode)), [...markers.keys()])
    const ancestors = selfAndAncestors(procRoot, selfPid)
    const stats = new Map<number, ProcStat | null>()
    const statOf = (pid: number) => {
      if (!stats.has(pid)) stats.set(pid, readStat(procRoot, pid))
      return stats.get(pid)!
    }
    const verdict = new Map<number, Omit<Seen, 'port' | 'host'> | null>()
    // A mesma porta em `0.0.0.0` e `::` é uma entrada só por PID (fica a do tcp, a primeira).
    const seen = new Map<string, Seen>()
    for (const s of sockets) {
      const pid = owners.get(s.inode)
      if (pid === undefined || seen.has(`${pid}:${s.port}`)) continue
      if (!verdict.has(pid)) {
        const st = statOf(pid)
        if (!st || ownedByClaudinei(procRoot, selfPid, ancestors, pid, st, statOf)) verdict.set(pid, null)
        else {
          verdict.set(pid, {
            pid, label: processLabel(readCmdline(procRoot, pid), st.comm), startTime: st.startTime,
            marker: markers.get(pid) ?? null,
            // A pasta só serve ao plano B (motor que filtra o ambiente), e só sem marcador.
            cwd: cwds.get(pid) ?? null,
          })
        }
      }
      const v = verdict.get(pid)
      if (v) seen.set(`${pid}:${s.port}`, { ...v, port: s.port, host: s.host })
    }
    return [...seen.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
  }

  /** A varredura guardada; refeita se venceu ou se `root` (plano B) é uma pasta que ela não olhou. */
  const current = (root?: string): Seen[] => {
    const t = now()
    if (root !== undefined) cwdRoots.add(root)
    if (!cache || t - cache.at >= ttlMs || t < cache.at || (root !== undefined && !cache.roots.has(root))) {
      const roots = new Set(cwdRoots)
      cache = { at: t, seen: scan(roots), roots }
    }
    return cache.seen
  }

  return {
    forTerminal(projectId, engine, projectPath) {
      const marker = terminalMarker(projectId, engine, inst())
      const byCwd = filtering.has(engine)
      // O `cwd` do /proc é o caminho real: a pasta do projeto também, se for um link.
      let root = projectPath
      if (byCwd) { try { root = realpathSync(projectPath) } catch { /* fica o caminho cadastrado */ } }
      const out: LocalServer[] = []
      for (const s of current(byCwd ? root : undefined)) {
        const base = { pid: s.pid, port: s.port, host: s.host, label: s.label, startTime: s.startTime }
        // O marcador conta só se for exatamente o do terminal nesta instância: `…:4:claude` ≠ `…:42:claude`.
        if (s.marker === marker) out.push({ ...base, marker: 'exact' })
        else if (byCwd && s.marker === null && s.cwd !== null && isInside(root, s.cwd)) out.push({ ...base, marker: 'cwd' })
      }
      return out
    },
    invalidate() { cache = null },
  }
}
