// O Parar de um servidor local. Logo antes do sinal relê o início do processo
// (contra PID reaproveitado) e o marcador: se mudou, não é mais o mesmo e nada
// é sinalizado. Nunca atinge o Claudinei (ele, os ancestrais, o grupo dele, as
// CLIs e as ferramentas diretas delas). SIGTERM ao grupo só se todos os
// membros tiverem o mesmo marcador; senão só ao PID. SIGKILL depois de
// `graceMs` se ainda for o mesmo processo. Só `fs` e `process.kill`.
import { listPids, readMarker, readStat } from './proc.js'
import { ownedByClaudinei, selfAndAncestors } from './scan.js'

export class NotSameProcessError extends Error {
  readonly code = 'not_same_process'
  constructor() { super('o processo já não é o mesmo') }
}

/** Sem marcador (achado pela pasta, ou `environ` ilegível): não se para o que não se confere. */
export class NoMarkerError extends Error {
  readonly code = 'no_marker'
  constructor() { super('o processo não tem o marcador do terminal') }
}

/** O alvo é o próprio Claudinei, do grupo dele, uma CLI ou uma ferramenta direta dela. */
export class ProtectedProcessError extends Error {
  readonly code = 'protected_process'
  constructor() { super('o processo é do próprio Claudinei') }
}

/** Intervalo da conferência "já morreu?" durante a espera. */
const POLL_MS = 100

export interface StopServerOptions {
  procRoot?: string
  selfPid?: number
  pid: number
  startTime: string
  /** O marcador do terminal (`terminalMarker`), que o processo tem de ter, exato. */
  marker: string
  kill?: (pid: number, sig: NodeJS.Signals) => void
  graceMs?: number
}

const errCode = (err: unknown) => (err as { code?: unknown } | null)?.code

export async function stopServer(o: StopServerOptions): Promise<{ target: 'group' | 'pid' }> {
  const procRoot = o.procRoot ?? '/proc'
  const selfPid = o.selfPid ?? process.pid
  const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig) })
  const graceMs = o.graceMs ?? 5000

  // A reconferência, logo antes do sinal.
  const st = readStat(procRoot, o.pid)
  if (!st || st.state === 'Z' || st.startTime !== o.startTime) throw new NotSameProcessError()
  const marker = readMarker(procRoot, o.pid)
  if (marker === null || !o.marker) throw new NoMarkerError()
  if (marker !== o.marker) throw new NotSameProcessError()

  const ancestors = selfAndAncestors(procRoot, selfPid)
  if (ownedByClaudinei(procRoot, selfPid, ancestors, o.pid, st)) throw new ProtectedProcessError()
  const self = readStat(procRoot, selfPid)
  if (self && st.pgrp === self.pgrp) throw new ProtectedProcessError()

  // O grupo: todos com o mesmo marcador e nenhum do Claudinei (uma CLI líder do
  // grupo, por exemplo, ficaria junto no sinal). Senão, só o PID.
  let target: 'group' | 'pid' = 'pid'
  if (st.pgrp > 1) {
    let all = true
    for (const pid of listPids(procRoot)) {
      const m = readStat(procRoot, pid)
      if (!m || m.pgrp !== st.pgrp) continue
      if (ancestors.has(pid) || m.ppid === selfPid || readMarker(procRoot, pid) !== o.marker) { all = false; break }
    }
    if (all) target = 'group'
  }
  const signalTo = target === 'group' ? -st.pgrp : o.pid

  try {
    kill(signalTo, 'SIGTERM')
  } catch (err) {
    // Morreu entre a conferência e o sinal: parado está.
    if (errCode(err) === 'ESRCH') return { target }
    throw err
  }

  const sameAlive = () => {
    const now = readStat(procRoot, o.pid)
    return now !== null && now.state !== 'Z' && now.startTime === o.startTime ? now : null
  }
  for (let waited = 0; waited < graceMs;) {
    const step = Math.min(POLL_MS, graceMs - waited)
    await new Promise((r) => setTimeout(r, step))
    waited += step
    if (!sameAlive()) return { target }
  }
  const still = sameAlive()
  if (still) {
    // Se o processo saiu do grupo no meio, o grupo pode não ser mais o dele: só o PID.
    const to = target === 'group' && still.pgrp !== st.pgrp ? o.pid : signalTo
    try { kill(to, 'SIGKILL') } catch (err) { if (errCode(err) !== 'ESRCH') throw err }
  }
  return { target }
}
