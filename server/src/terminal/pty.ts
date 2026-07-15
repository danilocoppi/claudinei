import { spawn as ptySpawn, type IPty } from 'node-pty'

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
) => PtyProcess

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p: IPty = ptySpawn(file, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: process.env as Record<string, string>,
  })
  return {
    onData: (cb) => { p.onData(cb) },
    onExit: (cb) => { p.onExit(({ exitCode }) => cb({ exitCode })) },
    write: (d) => p.write(d),
    resize: (cols, rows) => p.resize(cols, rows),
    kill: () => p.kill(),
  }
}
