import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeProc, type FakeProcRoot } from './fake-proc.js'
import { NoMarkerError, NotSameProcessError, ProtectedProcessError, stopServer } from '../src/local-servers/stop.js'

// Nenhum sinal de verdade sai daqui: o `kill` é um dublê que só anota, e o
// /proc é uma pasta temporária.
const SELF = 100
const MARK = '4:claude'
const env = (m: string | undefined): Record<string, string> => (m === undefined ? { PATH: '/usr/bin' } : { CLAUDINEI_TERMINAL: m, PATH: '/usr/bin' })

let fp: FakeProcRoot
let calls: Array<[number, NodeJS.Signals]>
let onKill: (pid: number, sig: NodeJS.Signals) => void

const kill = (pid: number, sig: NodeJS.Signals) => { calls.push([pid, sig]); onKill(pid, sig) }

beforeEach(() => {
  vi.useFakeTimers()
  fp = fakeProc()
  calls = []
  onKill = () => {}
  fp.proc({ pid: 1, ppid: 0, comm: 'systemd' })
  fp.proc({ pid: 50, ppid: 1, pgrp: 50, comm: 'bash' })
  fp.proc({ pid: SELF, ppid: 50, pgrp: 90, comm: 'node' })
  // A CLI (200), o Bash dela (220, líder do grupo 220) e o vite (230, no grupo 220).
  fp.proc({ pid: 200, ppid: SELF, pgrp: 90, comm: 'claude', env: env(MARK) })
  fp.proc({ pid: 220, ppid: 200, pgrp: 220, comm: 'bash', env: env(MARK) })
  fp.proc({ pid: 230, ppid: 220, pgrp: 220, startTime: '5555', env: env(MARK) })
})

afterEach(() => {
  vi.useRealTimers()
  fp.cleanup()
})

const stop = (o: Partial<Parameters<typeof stopServer>[0]> = {}) =>
  stopServer({ procRoot: fp.root, selfPid: SELF, pid: 230, startTime: '5555', marker: MARK, kill, ...o })

/** Roda o Parar até o fim, andando o relógio falso. */
async function settle<T>(p: Promise<T>, ms = 5000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return p
}

describe('Parar um servidor local', () => {
  it('startTime diferente → NotSameProcessError e nenhum kill', async () => {
    await expect(stop({ startTime: '9999' })).rejects.toBeInstanceOf(NotSameProcessError)
    await expect(stop({ startTime: '9999' })).rejects.toMatchObject({ code: 'not_same_process', message: 'o processo já não é o mesmo' })
    // O processo nem existe mais.
    await expect(stop({ pid: 4321 })).rejects.toBeInstanceOf(NotSameProcessError)
    expect(calls).toEqual([])
  })

  it('marcador mudou → NotSameProcessError', async () => {
    fp.proc({ pid: 230, ppid: 220, pgrp: 220, startTime: '5555', env: env('42:claude') })
    await expect(stop()).rejects.toBeInstanceOf(NotSameProcessError)
    expect(calls).toEqual([])
  })

  it('grupo todo com o mesmo marcador → kill(-pgrp, SIGTERM)', async () => {
    onKill = (pid, sig) => { if (pid === -220 && sig === 'SIGTERM') { fp.kill(220); fp.kill(230) } }
    expect(await settle(stop())).toEqual({ target: 'group' })
    expect(calls).toEqual([[-220, 'SIGTERM']])
  })

  it('grupo misto → kill(pid, SIGTERM)', async () => {
    fp.proc({ pid: 231, ppid: 220, pgrp: 220, env: env(undefined) })
    onKill = (pid) => { if (pid === 230) fp.kill(230) }
    expect(await settle(stop())).toEqual({ target: 'pid' })
    expect(calls).toEqual([[230, 'SIGTERM']])
  })

  it('membro do grupo com environ ilegível também deixa o grupo de fora', async () => {
    fp.proc({ pid: 231, ppid: 220, pgrp: 220, env: null })
    onKill = (pid) => { if (pid === 230) fp.kill(230) }
    expect(await settle(stop())).toEqual({ target: 'pid' })
  })

  it('ainda vivo em 5 s com o mesmo startTime → SIGKILL ao mesmo alvo', async () => {
    const p = stop()
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toEqual([[-220, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toEqual({ target: 'group' })
    expect(calls).toEqual([[-220, 'SIGTERM'], [-220, 'SIGKILL']])
  })

  it('ainda vivo em 5 s, alvo pid → SIGKILL ao pid', async () => {
    fp.proc({ pid: 231, ppid: 220, pgrp: 220, env: env(undefined) })
    expect(await settle(stop())).toEqual({ target: 'pid' })
    expect(calls).toEqual([[230, 'SIGTERM'], [230, 'SIGKILL']])
  })

  it('morto antes de 5 s → sem SIGKILL', async () => {
    const p = stop()
    await vi.advanceTimersByTimeAsync(2000)
    fp.kill(230)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ target: 'group' })
    expect(calls).toEqual([[-220, 'SIGTERM']])
  })

  it('zumbi conta como morto; PID reaproveitado em 5 s não leva SIGKILL', async () => {
    const p = stop()
    fp.stat({ pid: 230, ppid: 220, pgrp: 220, startTime: '5555', state: 'Z' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ target: 'group' })
    // Vivo de novo, e o PID passa a outro processo no meio da espera.
    fp.proc({ pid: 230, ppid: 220, pgrp: 220, startTime: '5555', env: env(MARK) })
    const q = stop()
    await vi.advanceTimersByTimeAsync(1000)
    fp.proc({ pid: 230, ppid: 1, pgrp: 230, startTime: '7777', env: env(MARK) })
    await vi.advanceTimersByTimeAsync(5000)
    await q
    expect(calls.filter(([, s]) => s === 'SIGKILL')).toEqual([])
  })

  it('pgrp do próprio Claudinei → recusa sem kill', async () => {
    fp.proc({ pid: 230, ppid: 1, pgrp: 90, startTime: '5555', env: env(MARK) })
    await expect(stop()).rejects.toBeInstanceOf(ProtectedProcessError)
    expect(calls).toEqual([])
  })

  it('selfPid, ancestrais, a CLI e o filho direto da CLI → recusa sem kill', async () => {
    fp.proc({ pid: SELF, ppid: 50, pgrp: 90, comm: 'node', env: env(MARK) })
    fp.proc({ pid: 50, ppid: 1, pgrp: 50, comm: 'bash', env: env(MARK) })
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, comm: 'claude', env: env(MARK) })
    for (const pid of [SELF, 50, 200, 220]) {
      await expect(stop({ pid, startTime: '1000' }), String(pid)).rejects.toBeInstanceOf(ProtectedProcessError)
    }
    expect(calls).toEqual([])
  })

  it('grupo que contém a CLI → só o pid', async () => {
    // A CLI líder do próprio grupo, com o vite dentro dele.
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, comm: 'claude', env: env(MARK) })
    fp.proc({ pid: 220, ppid: 200, pgrp: 200, comm: 'bash', env: env(MARK) })
    fp.proc({ pid: 230, ppid: 220, pgrp: 200, startTime: '5555', env: env(MARK) })
    onKill = (pid) => { if (pid === 230) fp.kill(230) }
    expect(await settle(stop())).toEqual({ target: 'pid' })
    expect(calls).toEqual([[230, 'SIGTERM']])
  })

  it("marker 'cwd' (processo sem marcador) → NoMarkerError", async () => {
    fp.proc({ pid: 230, ppid: 1, pgrp: 230, startTime: '5555', env: env(undefined) })
    await expect(stop()).rejects.toBeInstanceOf(NoMarkerError)
    await expect(stop()).rejects.toMatchObject({ code: 'no_marker' })
    // environ ilegível: também sem marcador, e nada é sinalizado.
    fp.proc({ pid: 230, ppid: 1, pgrp: 230, startTime: '5555', env: null })
    await expect(stop()).rejects.toBeInstanceOf(NoMarkerError)
    expect(calls).toEqual([])
  })

  it('o processo some entre a conferência e o SIGTERM (ESRCH) → termina sem erro', async () => {
    onKill = () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }) }
    expect(await settle(stop())).toEqual({ target: 'group' })
    expect(calls).toEqual([[-220, 'SIGTERM']])
  })
})
