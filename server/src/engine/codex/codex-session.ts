import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { EngineSession, EngineSessionOptions } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { buildExecArgs, buildResumeArgs } from './codex-args.js'
import { createCodexTurnParser } from './codex-parser.js'

/** Sessão Codex turn-based: 1 processo `codex exec`/`exec resume` por turno. */
export class CodexSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  private proc?: ChildProcessWithoutNullStreams
  private stopping = false
  private interrupting = false
  private stderrTail: string[] = []
  private model?: string
  private effort?: string

  get lastStderr(): string { return this.stderrTail.join('').trim() }

  constructor(private opts: EngineSessionOptions & { binOverride?: string }) {
    super()
    this.model = opts.model
    this.effort = opts.effort
    if (opts.resumeSessionId) this.sessionId = opts.resumeSessionId
  }

  start(): void {
    // Turn-based: nada spawna aqui. Só marca a sessão pronta.
    this.setStatus('idle')
  }

  send(text: string): void {
    if (this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if (this.status === 'working') throw new Error('turno em andamento')
    const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
    const turnOpts = { model: this.model, effort: this.effort, hermes: this.opts.hermes }
    const baseArgs = this.sessionId ? buildResumeArgs(this.sessionId, turnOpts) : buildExecArgs(turnOpts)
    const args = this.opts.extraArgsOverride ? [...this.opts.extraArgsOverride, ...baseArgs] : baseArgs
    this.proc = spawn(bin, args, { cwd: this.opts.projectPath, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PKG_EXECPATH: '' } })
    this.setStatus('working')
    let sawResult = false
    const feed = createCodexTurnParser((evt) => {
      if (evt.kind === 'init') { this.sessionId = evt.sessionId; this.emit('event', evt); return }
      if (evt.kind === 'result') sawResult = true
      this.emit('event', evt)
    }, this.model)
    this.proc.stdout.on('data', feed)
    this.proc.stderr.on('data', (d) => {
      const s = d.toString(); this.stderrTail.push(s); if (this.stderrTail.length > 20) this.stderrTail.shift(); this.emit('stderr', s)
    })
    this.proc.stdin.write(text); this.proc.stdin.end()
    this.proc.on('close', (code) => {
      this.proc = undefined
      if (this.stopping) { this.setStatus('stopped'); return }
      if (this.interrupting) { this.interrupting = false; this.setStatus('idle'); this.emit('exit', code); return }
      if (code !== 0 && !sawResult) { this.setStatus('dead'); this.emit('exit', code); return }
      this.setStatus(sawResult ? 'needs_attention' : 'idle')
      this.emit('exit', code)
    })
    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = CLI não instalada: sem isto o dead sai com stderr vazio e a UI
      // mostra só o genérico "processo encerrou inesperadamente".
      if (err.code === 'ENOENT') {
        const msg = `\`${bin}\` não encontrado no PATH — instale a CLI do Codex (npm install -g @openai/codex) ou configure CLAUDINEI_CODEX_BIN`
        this.stderrTail.push(msg)
        this.emit('stderr', msg)
      }
      this.setStatus('dead')
    })
  }

  markRead(): void { if (this.status === 'needs_attention') this.setStatus('idle') }

  interrupt(): Promise<void> {
    if (this.status === 'working' && this.proc) {
      const p = this.proc
      this.interrupting = true
      p.kill('SIGTERM')
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } }, 3000)
      p.once('close', () => clearTimeout(t))
    }
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> { this.model = model || undefined; return Promise.resolve() }
  setPermissionMode(_mode: string): Promise<void> { return Promise.resolve() } // Codex: full-access fixo
  setEffort(effort: string): Promise<void> { this.effort = effort || undefined; return Promise.resolve() }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.proc) {
      const p = this.proc
      p.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* */ } resolve() }, 5000)
        p.once('close', () => { clearTimeout(t); resolve() })
      })
    } else {
      this.setStatus('stopped')
    }
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) { this.status = s; this.emit('status', s) }
  }
}
