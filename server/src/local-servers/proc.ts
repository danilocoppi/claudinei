// Leitura do `/proc` para os servidores locais. Só `fs`, nenhum comando
// externo. Toda função recebe `procRoot` (o teste aponta para uma pasta falsa)
// e nunca lança: o que não se lê (processo que morreu no meio, `environ` de
// outro usuário) vira `null` ou lista vazia.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TERMINAL_MARKER_VAR } from './marker.js'

/** Estado TCP_LISTEN em `/proc/net/tcp`. */
const LISTEN = '0A'

const readText = (path: string): string | null => {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** IPv4 de `/proc/net/tcp`: 8 dígitos hex, na ordem da máquina (little-endian). */
function ipv4(hex: string): string {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16)).reverse()
  return bytes.join('.')
}

/** IPv6 de `/proc/net/tcp6`: 4 palavras de 32 bits, cada uma little-endian. */
function ipv6(hex: string): string {
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) bytes.push(...hex.slice(w * 8, w * 8 + 8).match(/../g)!.map((h) => parseInt(h, 16)).reverse())
  // IPv4 mapeado (::ffff:a.b.c.d).
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // Comprime a maior sequência de zeros (duas ou mais palavras) em `::`.
  let best = -1, bestLen = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > bestLen) { best = i; bestLen = j - i }
    i = j
  }
  if (bestLen < 2) return groups.join(':')
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`
}

/** Os sockets TCP em LISTEN, do `tcp` e do `tcp6`, nessa ordem. */
export function listeningSockets(procRoot: string): Array<{ inode: string; port: number; host: string }> {
  const out: Array<{ inode: string; port: number; host: string }> = []
  for (const file of ['net/tcp', 'net/tcp6']) {
    const text = readText(join(procRoot, file))
    if (!text) continue
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || f[3] !== LISTEN) continue
      const [hexHost, hexPort] = f[1].split(':')
      const port = parseInt(hexPort, 16)
      const inode = f[9]
      if (!hexHost || !Number.isFinite(port) || !/^\d+$/.test(inode) || inode === '0') continue
      const host = hexHost.length === 8 ? ipv4(hexHost) : hexHost.length === 32 ? ipv6(hexHost) : null
      if (host === null) continue
      out.push({ inode, port, host })
    }
  }
  return out
}

/** Os PIDs do /proc, em ordem crescente. */
export function listPids(procRoot: string): number[] {
  let names: string[]
  try { names = readdirSync(procRoot) } catch { return [] }
  return names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
}

/**
 * inode → PID, pelos links `socket:[inode]` de `/proc/<pid>/fd`. Um socket
 * herdado por vários processos (fork) fica com o de menor PID. Com `wanted`,
 * ignora os demais inodes; com `pids`, só lê o `fd/` desses (ler o `fd/` de
 * todos os processos da máquina é a parte cara da varredura).
 */
export function socketOwners(procRoot: string, wanted?: ReadonlySet<string>, pids?: readonly number[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const pid of pids ? [...pids].sort((a, b) => a - b) : listPids(procRoot)) {
    const fdDir = join(procRoot, String(pid), 'fd')
    let fds: string[]
    try { fds = readdirSync(fdDir) } catch { continue }
    for (const fd of fds) {
      let link: string
      try { link = readlinkSync(join(fdDir, fd)) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (!m || (wanted && !wanted.has(m[1])) || out.has(m[1])) continue
      out.set(m[1], pid)
    }
  }
  return out
}

export interface ProcStat { ppid: number; pgrp: number; startTime: string; comm: string; state: string }

/**
 * `/proc/<pid>/stat`. O comm vem entre parênteses e pode ter espaço e `)`:
 * corta no ÚLTIMO `)`. `startTime` (22º campo, em tiques desde o boot) muda
 * quando o PID é reaproveitado.
 */
export function readStat(procRoot: string, pid: number): ProcStat | null {
  const text = readText(join(procRoot, String(pid), 'stat'))
  if (!text) return null
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const comm = text.slice(open + 1, close)
  // Depois do comm: estado (3º campo), ppid, pgrp, …, starttime (22º).
  const rest = text.slice(close + 1).trim().split(/\s+/)
  const state = rest[0]
  const ppid = Number(rest[1])
  const pgrp = Number(rest[2])
  const startTime = rest[19]
  if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || !startTime || !/^\d+$/.test(startTime)) return null
  return { ppid, pgrp, startTime, comm, state }
}

/** O valor de `CLAUDINEI_TERMINAL` no `environ` do processo, ou `null` (sem ele ou ilegível). */
export function readMarker(procRoot: string, pid: number): string | null {
  const text = readText(join(procRoot, String(pid), 'environ'))
  if (text === null) return null
  const prefix = `${TERMINAL_MARKER_VAR}=`
  // O getenv devolve a primeira ocorrência.
  const entry = text.split('\0').find((e) => e.startsWith(prefix))
  return entry === undefined ? null : entry.slice(prefix.length)
}

export function readCmdline(procRoot: string, pid: number): string[] {
  const text = readText(join(procRoot, String(pid), 'cmdline'))
  if (!text) return []
  const args = text.split('\0')
  while (args.length && args[args.length - 1] === '') args.pop()
  return args
}

export function readCwd(procRoot: string, pid: number): string | null {
  try { return readlinkSync(join(procRoot, String(pid), 'cwd')) } catch { return null }
}

/** Interpretadores: o nome que interessa é o do script (ou do módulo), não o deles. */
const INTERPRETER = /^(node|nodejs|bun|deno|python[\d.]*|pypy[\d.]*|ruby|php|perl|sh|bash|dash|zsh|tsx|ts-node)$/
/** Subcomandos que vêm antes do script (`bun run x`, `deno run x`). */
const SUBCOMMAND = new Set(['run'])
const SCRIPT_EXT = /\.(?:[cm]?js|[cm]?ts|py|rb|php|pl)$/

/**
 * O nome curto do servidor na lista: `['node', '/x/.bin/vite']` → `vite`;
 * `['python3', '-m', 'http.server', '8000']` → `http.server`; senão o
 * basename do argv0, ou o comm.
 */
export function processLabel(cmdline: string[], comm: string): string {
  const argv0 = cmdline[0] ? basename(cmdline[0]) : ''
  if (!argv0) return comm
  if (INTERPRETER.test(argv0)) {
    for (let i = 1; i < cmdline.length; i++) {
      const a = cmdline[i]
      if (a === '-m' && cmdline[i + 1]) return cmdline[i + 1]
      if (a.startsWith('-') || (i === 1 && SUBCOMMAND.has(a))) continue
      return basename(a).replace(SCRIPT_EXT, '') || argv0
    }
  }
  return argv0
}
