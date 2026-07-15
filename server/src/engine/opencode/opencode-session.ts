import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { EngineSession, EngineSessionOptions } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { buildRunArgs, buildResumeArgs, hermesConfigEnv } from './opencode-args.js'
import { createOpenCodeTurnParser } from './opencode-parser.js'

/** Sessão OpenCode turn-based: 1 processo `opencode run`/`run -s` por turno. */
export class OpenCodeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  // stdin é 'ignore' (prompt vai por argv, não stdin) → sem Writable.
  private proc?: ChildProcessByStdio<null, Readable, Readable>
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

  start(): void { this.setStatus('idle') } // turn-based: nada spawna aqui

  send(text: string): void {
    if (this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if (this.status === 'working') throw new Error('turno em andamento')
    const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_OPENCODE_BIN ?? 'opencode'
    const turnOpts = { model: this.model, effort: this.effort, prompt: text }
    const base = this.sessionId
      ? buildResumeArgs(this.sessionId, turnOpts)
      : buildRunArgs({ ...turnOpts, title: text.slice(0, 40) })
    const args = this.opts.extraArgsOverride ? [...this.opts.extraArgsOverride, ...base] : base
    // O MCP hermes (colaboração entre agentes) é injetado via OPENCODE_CONFIG_CONTENT
    // no env — o `opencode run` não tem flag inline de MCP; a env é MESCLADA com a
    // config do usuário (não substitui). Só entra se a sessão recebeu `hermes`.
    const env = { ...process.env, PKG_EXECPATH: '', ...hermesConfigEnv(this.opts.hermes) }
    this.proc = spawn(bin, args, { cwd: this.opts.projectPath, stdio: ['ignore', 'pipe', 'pipe'], env })
    this.setStatus('working')
    let sawOutput = false
    const parser = createOpenCodeTurnParser((evt) => {
      if (evt.kind === 'init') { this.sessionId = evt.sessionId }
      if (evt.kind === 'assistant' || evt.kind === 'user') sawOutput = true
      this.emit('event', evt)
    }, this.model)
    this.proc.stdout.on('data', (d) => parser.feed(d))
    this.proc.stderr.on('data', (d) => { const s = d.toString(); this.stderrTail.push(s); if (this.stderrTail.length > 20) this.stderrTail.shift(); this.emit('stderr', s) })
    this.proc.on('close', (code) => {
      this.proc = undefined
      // Fim do turno: sintetiza o result (resultText/tokens acumulados).
      // parser.finish().isError só é true se uma linha `type:error` foi vista no
      // stream — um crash real (exit != 0 sem JSON de erro) não marca isError, por
      // isso `healthy` também exige output observado de verdade (sawOutput/tokens).
      const result = parser.finish()
      const healthy = result.kind === 'result' && !result.isError && (sawOutput || !!result.tokens)
      if (this.stopping) { this.setStatus('stopped'); return }
      if (this.interrupting) { this.interrupting = false; this.setStatus('idle'); return }
      if (code !== 0 && !healthy) {
        // Turno terminou mal. Se o parser JÁ capturou um erro explícito (linha
        // `type:error`), propaga o result dele — a mensagem real é mais útil que a
        // genérica. Só num crash SILENCIOSO (exit != 0 sem JSON de erro) sintetiza
        // um result de erro a partir do stderr: NÃO propaga o "sucesso vazio" do
        // parser.finish(), senão assinantes genéricos de 'event' (ex.: hermes
        // askAgent/dispatchTask) resolveriam no 1º kind==='result' vendo "completed"
        // vazio em vez de falha.
        const errResult =
          result.kind === 'result' && result.isError
            ? result
            : {
                kind: 'result' as const,
                subtype: 'error',
                isError: true,
                resultText: this.lastStderr || `opencode terminou com código ${code}`,
                costUsd: 0,
                tokens: result.kind === 'result' ? result.tokens : undefined,
                raw: {},
              }
        this.emit('event', errResult)
        this.setStatus('dead')
        this.emit('exit', code)
        return
      }
      // Turno de fato concluído com sucesso.
      this.emit('event', result)
      this.setStatus('needs_attention')
      this.emit('exit', code)
    })
    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = CLI não instalada: alimenta o stderrTail ANTES do close, para o
      // result de erro sintetizado (e o detail do dead) explicarem a causa real.
      if (err.code === 'ENOENT') {
        const msg = `\`${bin}\` não encontrado no PATH — instale a CLI do OpenCode (npm install -g opencode-ai) ou configure CLAUDINEI_OPENCODE_BIN`
        this.stderrTail.push(msg)
        this.emit('stderr', msg)
      }
      this.setStatus('dead')
    })
  }

  markRead(): void { if (this.status === 'needs_attention') this.setStatus('idle') }

  interrupt(): Promise<void> {
    if (this.status === 'working' && this.proc) {
      this.interrupting = true
      const p = this.proc
      p.kill('SIGTERM')
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } }, 3000)
      p.once('close', () => clearTimeout(t))
    }
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> { this.model = model || undefined; return Promise.resolve() }
  setEffort(effort: string): Promise<void> { this.effort = effort || undefined; return Promise.resolve() }
  setPermissionMode(_m: string): Promise<void> { return Promise.resolve() } // full-access fixo

  async stop(): Promise<void> {
    this.stopping = true
    if (this.proc) {
      const p = this.proc; p.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* */ } resolve() }, 5000)
        p.once('close', () => { clearTimeout(t); resolve() })
      })
    } else { this.setStatus('stopped') }
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) { this.status = s; this.emit('status', s) }
  }
}
