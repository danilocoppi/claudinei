import { randomBytes } from 'node:crypto'
import type { PtyFactory, PtyProcess } from './pty.js'
import { createActivityTracker, type TerminalActivity } from './activity.js'

const BUFFER_LIMIT = 256 * 1024

export interface OpenOpts {
  cwd: string
  file: string
  args: string[]
  onExit: () => void
  /** Heurística de atividade do TUI (working/waiting/idle) lida do fluxo do PTY. */
  onActivity?: (activity: TerminalActivity) => void
}

interface Socketish {
  send(data: string): void
  readyState: number
}

interface PtyEntry {
  proc: PtyProcess
  buffer: string
  token: string
  clients: Set<Socketish>
  exited: boolean
  /** Resolvidos quando o exit REAL do PTY chega (após o status ser persistido). */
  exitWaiters: Array<() => void>
}

export function createTerminalManager(deps: { ptyFactory: PtyFactory }) {
  const entries = new Map<string, PtyEntry>()

  const append = (entry: PtyEntry, data: string) => {
    entry.buffer += data
    if (entry.buffer.length > BUFFER_LIMIT) {
      entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_LIMIT)
    }
  }
  const fanout = (entry: PtyEntry, data: string) => {
    for (const c of entry.clients) if (c.readyState === 1) c.send(data)
  }

  return {
    open(localId: string, opts: OpenOpts): string {
      const existing = entries.get(localId)
      if (existing && !existing.exited) {
        existing.token = randomBytes(24).toString('hex')
        return existing.token
      }
      const proc = deps.ptyFactory(opts.file, opts.args, { cwd: opts.cwd, cols: 80, rows: 24 })
      const entry: PtyEntry = { proc, buffer: '', token: randomBytes(24).toString('hex'), clients: new Set(), exited: false, exitWaiters: [] }
      entries.set(localId, entry)
      const tracker = opts.onActivity ? createActivityTracker(opts.onActivity) : null
      proc.onData((data) => { append(entry, data); fanout(entry, data); tracker?.feed(data) })
      proc.onExit(() => {
        tracker?.dispose()
        entry.exited = true
        fanout(entry, '\r\n— sessão encerrada —\r\n')
        if (entries.get(localId) === entry) entries.delete(localId)
        opts.onExit()
        // depois do onExit (status já persistido): libera quem espera o fim real
        entry.exitWaiters.splice(0).forEach((w) => w())
      })
      return entry.token
    },

    attach(localId: string, socket: Socketish, token: string): boolean {
      const entry = entries.get(localId)
      if (!entry || entry.exited || entry.token !== token) return false
      entry.clients.add(socket)
      if (entry.buffer && socket.readyState === 1) socket.send(entry.buffer)
      return true
    },

    detach(localId: string, socket: Socketish): void {
      entries.get(localId)?.clients.delete(socket)
    },

    write(localId: string, data: string): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) entry.proc.write(data)
    },

    resize(localId: string, cols: number, rows: number): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) entry.proc.resize(cols, rows)
    },

    close(localId: string): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) {
        entry.exited = true
        entry.proc.kill()
      }
    },

    /**
     * Fecha o PTY e resolve só quando o exit REAL chegar (com o status da sessão
     * já persistido pelo onExit) — permite que um revive logo em seguida não
     * esbarre em 'in_terminal'. Timeout de segurança para PTY que não morre.
     */
    closeAndWait(localId: string, timeoutMs = 3000): Promise<void> {
      const entry = entries.get(localId)
      if (!entry) return Promise.resolve()
      const wait = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        entry.exitWaiters.push(() => { clearTimeout(timer); resolve() })
      })
      if (!entry.exited) {
        entry.exited = true
        entry.proc.kill()
      }
      return wait
    },

    has(localId: string): boolean {
      const e = entries.get(localId)
      return !!e && !e.exited
    },

    refreshToken(localId: string): string | null {
      const entry = entries.get(localId)
      if (!entry || entry.exited) return null
      entry.token = randomBytes(24).toString('hex')
      return entry.token
    },
  }
}

export type TerminalManager = ReturnType<typeof createTerminalManager>
