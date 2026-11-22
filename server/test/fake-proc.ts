// Um `/proc` de mentira numa pasta temporária, com o formato do verdadeiro:
// `net/tcp` e `net/tcp6` (linhas reais, estado `0A` = LISTEN), `<pid>/fd/N`
// como link para `socket:[inode]`, `<pid>/stat`, `<pid>/environ` (separado por
// NUL), `<pid>/cmdline` e `<pid>/cwd` (link para uma pasta). Os testes dos
// servidores locais leem só daqui; nenhum processo de verdade é tocado.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeProcess {
  pid: number
  ppid: number
  pgrp?: number
  startTime?: string
  comm?: string
  /** Ambiente do processo; `null` = sem `environ` (ilegível, como o de outro usuário). */
  env?: Record<string, string> | null
  cmdline?: string[]
  cwd?: string
  state?: string
}

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const hexPort = (port: number) => port.toString(16).toUpperCase().padStart(4, '0')

export function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), 'fake-proc-'))
  mkdirSync(join(root, 'net'))
  const tcp: string[] = []
  const tcp6: string[] = []
  let nextInode = 50000
  const fdCount = new Map<number, number>()

  const writeNet = () => {
    writeFileSync(join(root, 'net/tcp'), HEADER + tcp.join(''))
    writeFileSync(join(root, 'net/tcp6'), HEADER + tcp6.join(''))
  }
  writeNet()

  const writeStat = (p: FakeProcess) => {
    const pgrp = p.pgrp ?? p.pid
    const start = p.startTime ?? '1000'
    // Campos depois do comm: estado, ppid, pgrp, sessão, … e o 22º (starttime).
    writeFileSync(join(root, String(p.pid), 'stat'),
      `${p.pid} (${p.comm ?? 'node'}) ${p.state ?? 'S'} ${p.ppid} ${pgrp} ${pgrp} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000000 200 18446744073709551615\n`)
  }

  return {
    root,

    /** Cria (ou recria) o processo. */
    proc(p: FakeProcess): void {
      const dir = join(root, String(p.pid))
      mkdirSync(join(dir, 'fd'), { recursive: true })
      writeStat(p)
      if (p.env !== null) {
        const env = p.env ?? {}
        writeFileSync(join(dir, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''))
      } else {
        rmSync(join(dir, 'environ'), { force: true })
      }
      const cmd = p.cmdline ?? [p.comm ?? 'node']
      writeFileSync(join(dir, 'cmdline'), cmd.length ? cmd.join('\0') + '\0' : '')
      rmSync(join(dir, 'cwd'), { force: true })
      if (p.cwd) symlinkSync(p.cwd, join(dir, 'cwd'))
    },

    /** Reescreve só o `stat` (ex.: outro início, outro grupo, zumbi). */
    stat(p: FakeProcess): void { writeStat(p) },

    /** O processo escuta na porta: abre o fd e a linha do tcp (ou tcp6). Devolve o inode. */
    listen(pid: number, port: number, opts: { v6?: boolean; host?: string } = {}): string {
      const inode = String(nextInode++)
      const n = fdCount.get(pid) ?? 3
      fdCount.set(pid, n + 1)
      symlinkSync(`socket:[${inode}]`, join(root, String(pid), 'fd', String(n)))
      const sl = (opts.v6 ? tcp6 : tcp).length
      if (opts.v6) {
        const host = opts.host ?? '00000000000000000000000000000000'
        tcp6.push(`  ${sl}: ${host}:${hexPort(port)} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`)
      } else {
        const host = opts.host ?? '0100007F'
        tcp.push(`  ${sl}: ${host}:${hexPort(port)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`)
      }
      writeNet()
      return inode
    },

    /** Uma conexão estabelecida (estado 01): não é servidor. */
    connected(pid: number, port: number): void {
      const inode = String(nextInode++)
      const n = fdCount.get(pid) ?? 3
      fdCount.set(pid, n + 1)
      symlinkSync(`socket:[${inode}]`, join(root, String(pid), 'fd', String(n)))
      tcp.push(`  ${tcp.length}: 0100007F:${hexPort(port)} 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`)
      writeNet()
    },

    /** O processo morreu: some do /proc (as linhas do tcp ficam, sem dono). */
    kill(pid: number): void { rmSync(join(root, String(pid)), { recursive: true, force: true }) },

    cleanup(): void { rmSync(root, { recursive: true, force: true }) },
  }
}

export type FakeProcRoot = ReturnType<typeof fakeProc>
