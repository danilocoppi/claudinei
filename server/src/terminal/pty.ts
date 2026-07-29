import { spawn as ptySpawn, type IPty } from 'node-pty'

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> },
) => PtyProcess

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p: IPty = ptySpawn(file, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    // opts.env é ADITIVO (não substitui o ambiente): a engine só sobrepõe as
    // chaves que precisa, ex.: KIMI_CODE_HOME do projeto.
    env: { ...process.env, ...opts.env } as Record<string, string>,
  })
  return {
    onData: (cb) => { p.onData(cb) },
    onExit: (cb) => { p.onExit(({ exitCode }) => cb({ exitCode })) },
    write: (d) => p.write(d),
    resize: (cols, rows) => p.resize(cols, rows),
    kill: (signal) => p.kill(signal),
  }
}
