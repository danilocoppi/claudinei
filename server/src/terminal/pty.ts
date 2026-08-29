import { spawn as ptySpawn, type IPty } from 'node-pty'
import { resolveBin } from '../engine/available.js'

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtyFactory = (
  file: string,
  /**
   * Lista de argumentos ou — só no Windows — a linha de comando CRUA.
   *
   * O node-pty aceita as duas, e a diferença importa: com lista, ele aplica o
   * quoting do compilador C (aspas internas viram `\"`), que o `cmd.exe` não
   * entende — ele não conhece `\` como escape. Quem monta uma linha para o cmd
   * passa a string pronta e fica com o controle das aspas.
   */
  args: string[] | string,
  opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> },
) => PtyProcess

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  // opts.env é ADITIVO (não substitui o ambiente): a engine só sobrepõe as
  // chaves que precisa, ex.: KIMI_CODE_HOME do projeto.
  const env = { ...process.env, ...opts.env } as Record<string, string>
  // Só no Windows: o ConPTY NÃO procura no PATH — nome nu vira caminho vazio e o
  // spawn morre com "File not found: " (sem nome depois dos dois-pontos, que é o
  // sintoma). Resolvemos com o MESMO env que o processo vai receber. Em
  // Linux/macOS nada muda: o node-pty resolve pelo PATH no execvp, como sempre.
  const command = process.platform === 'win32' ? (resolveBin(file, env) ?? file) : file
  const p: IPty = ptySpawn(command, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env,
  })
  return {
    onData: (cb) => { p.onData(cb) },
    onExit: (cb) => { p.onExit(({ exitCode }) => cb({ exitCode })) },
    write: (d) => p.write(d),
    resize: (cols, rows) => p.resize(cols, rows),
    kill: (signal) => p.kill(signal),
  }
}
