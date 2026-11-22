// O Parar de um servidor local. Logo antes do sinal relê o início do processo
// (contra PID reaproveitado) e o marcador: se mudou, não é mais o mesmo e nada
// é sinalizado. Nunca atinge o Claudinei (ele, os ancestrais, o grupo dele, as
// CLIs e as ferramentas delas, como os servidores MCP). SIGTERM ao grupo só se todos os
// membros tiverem o mesmo marcador; senão só ao PID. SIGKILL depois de
// `graceMs` se ainda for o mesmo processo. Só `fs` e `process.kill`.
import { hasInstanceId } from './marker.js'
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

/** O alvo é o próprio Claudinei, do grupo dele, uma CLI ou uma ferramenta dela (MCP, LSP). */
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
  /**
   * O marcador do terminal (`terminalMarker`, com o id desta instância), que o
   * processo tem de ter, exato. Sem o id (o formato antigo), nada se para.
   */
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
  if (marker === null || !o.marker || !hasInstanceId(o.marker)) throw new NoMarkerError()
  if (marker !== o.marker) throw new NotSameProcessError()

  const ancestors = selfAndAncestors(procRoot, selfPid)
  if (ownedByClaudinei(procRoot, selfPid, ancestors, o.pid, st)) throw new ProtectedProcessError()
  // Sem o grupo do Claudinei não dá para garantir que o alvo não é dele: recusa.
  const self = readStat(procRoot, selfPid)
  if (!self || st.pgrp === self.pgrp) throw new ProtectedProcessError()

  /**
   * O grupo `pgrp` pode levar o sinal: o próprio PID está nele, todos os
   * membros têm o mesmo marcador e nenhum é do Claudinei (uma CLI líder do
   * grupo, como no pty, ou uma ferramenta dela ficaria junto no sinal). Relê o
   * /proc a cada chamada.
   */
  const groupIsOurs = (pgrp: number): boolean => {
    if (pgrp <= 1) return false
    let sawTarget = false
    for (const pid of listPids(procRoot)) {
      const m = readStat(procRoot, pid)
      if (!m || m.pgrp !== pgrp) continue
      if (pid === o.pid) sawTarget = true
      if (readMarker(procRoot, pid) !== o.marker) return false
      if (ownedByClaudinei(procRoot, selfPid, ancestors, pid, m)) return false
    }
    return sawTarget
  }

  const target: 'group' | 'pid' = groupIsOurs(st.pgrp) ? 'group' : 'pid'
  // No Claude, o líder do grupo é o shell da ferramenta Bash (`/bin/bash -c …`,
  // filho direto da CLI, com o marcador): o SIGTERM ao grupo o leva junto.
  // Aceito: é o shell que subiu o servidor, não a CLI, que só vê o comando
  // terminar.
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
    // A reconferência de novo, logo antes do SIGKILL. Um `exec` mantém o PID e
    // o início mas troca o ambiente: sem o marcador, não é mais o mesmo.
    if (readMarker(procRoot, o.pid) !== o.marker) throw new NotSameProcessError()
    // O grupo também: se o processo saiu dele, ou entrou alguém sem o marcador
    // ou do Claudinei, só o PID.
    const to = target === 'group' && still.pgrp === st.pgrp && groupIsOurs(st.pgrp) ? signalTo : o.pid
    try { kill(to, 'SIGKILL') } catch (err) { if (errCode(err) !== 'ESRCH') throw err }
  }
  return { target }
}
