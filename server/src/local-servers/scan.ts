// A varredura dos servidores locais de cada terminal: quem escuta numa porta
// TCP e tem o marcador do terminal no ambiente. Uma varredura do /proc,
// guardada `ttlMs`, serve a todas as chaves (a coluna de cada terminal pede a
// sua a cada 5 s). Ficam fora o próprio Claudinei e tudo o que é dele: os
// ancestrais, a porta do serviço, as CLIs, o pty e o Chromium (filhos diretos)
// e os filhos diretos das CLIs (servidores MCP e outras ferramentas do agente).
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { ENGINES_FILTERING_ENV, terminalMarker } from './marker.js'
import {
  listeningSockets, processLabel, readCmdline, readCwd, readMarker, readStat, socketOwners, type ProcStat,
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
 * O processo é do Claudinei e não se lista nem se para: ele mesmo ou um
 * ancestral; um filho direto (CLI, pty, Chromium); ou um filho direto de uma
 * CLI (ferramenta do agente, como um servidor MCP). Os netos da CLI (o que o
 * agente sobe pelo shell) e os readotados não são.
 */
export function ownedByClaudinei(procRoot: string, selfPid: number, ancestors: ReadonlySet<number>, pid: number, st: ProcStat): boolean {
  if (ancestors.has(pid) || st.ppid === selfPid) return true
  const parent = readStat(procRoot, st.ppid)
  return parent !== null && parent.ppid === selfPid
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
  let cache: { at: number; seen: Seen[] } | null = null

  const scan = (): Seen[] => {
    const sockets = listeningSockets(procRoot).filter((s) => s.port !== o.servicePort)
    if (sockets.length === 0) return []
    const owners = socketOwners(procRoot, new Set(sockets.map((s) => s.inode)))
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
        if (!st || ownedByClaudinei(procRoot, selfPid, ancestors, pid, st)) verdict.set(pid, null)
        else {
          const marker = readMarker(procRoot, pid)
          verdict.set(pid, {
            pid, label: processLabel(readCmdline(procRoot, pid), st.comm), startTime: st.startTime, marker,
            // A pasta só serve ao plano B (motor que filtra o ambiente), e só sem marcador.
            cwd: marker === null && filtering.size > 0 ? readCwd(procRoot, pid) : null,
          })
        }
      }
      const v = verdict.get(pid)
      if (v) seen.set(`${pid}:${s.port}`, { ...v, port: s.port, host: s.host })
    }
    return [...seen.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
  }

  const current = (): Seen[] => {
    const t = now()
    if (!cache || t - cache.at >= ttlMs || t < cache.at) cache = { at: t, seen: scan() }
    return cache.seen
  }

  return {
    forTerminal(projectId, engine, projectPath) {
      const marker = terminalMarker(projectId, engine)
      const byCwd = filtering.has(engine)
      // O `cwd` do /proc é o caminho real: a pasta do projeto também, se for um link.
      let root = projectPath
      if (byCwd) { try { root = realpathSync(projectPath) } catch { /* fica o caminho cadastrado */ } }
      const out: LocalServer[] = []
      for (const s of current()) {
        const base = { pid: s.pid, port: s.port, host: s.host, label: s.label, startTime: s.startTime }
        // O marcador conta só se for exatamente o do terminal: `4:claude` ≠ `42:claude`.
        if (s.marker === marker) out.push({ ...base, marker: 'exact' })
        else if (byCwd && s.marker === null && s.cwd !== null && isInside(root, s.cwd)) out.push({ ...base, marker: 'cwd' })
      }
      return out
    },
    invalidate() { cache = null },
  }
}
