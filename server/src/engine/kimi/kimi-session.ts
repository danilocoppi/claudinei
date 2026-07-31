import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { EngineSession, EngineSessionOptions } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { buildTurnArgs } from './kimi-args.js'
import { createKimiTurnParser } from './kimi-parser.js'
import { ensureKimiHome } from './kimi-home.js'
import { readLastTurnTokens, type TurnTokens } from './kimi-history.js'

// O prompt vai por argv (`-p <prompt>`) e o Linux limita um argumento a 131071
// bytes (MAX_ARG_STRLEN) — mesma restrição do OpenCode. Acima disso o spawn
// falharia com E2BIG e a mensagem se perderia.
const MAX_PROMPT_BYTES = 120_000

/** Sessão Kimi turn-based: 1 processo `kimi -p` por turno. */
export class KimiSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  // stdin é 'ignore' (prompt vai por argv) → sem Writable.
  private proc?: ChildProcessByStdio<null, Readable, Readable>
  private stopping = false
  private interrupting = false
  private stderrTail: string[] = []
  private model?: string

  get lastStderr(): string { return this.stderrTail.join('').trim() }

  constructor(private opts: EngineSessionOptions & { binOverride?: string }) {
    super()
    this.model = opts.model
    if (opts.resumeSessionId) this.sessionId = opts.resumeSessionId
  }

  start(): void { this.setStatus('idle') } // turn-based: nada spawna aqui

  send(text: string): void {
    if (this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if (this.status === 'working') throw new Error('turno em andamento')
    if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
      this.emit('event', {
        kind: 'result' as const,
        subtype: 'error',
        isError: true,
        resultText: `mensagem grande demais para o Kimi (~${Math.round(MAX_PROMPT_BYTES / 1024)} KB por mensagem; o prompt vai por argv). Divida a mensagem ou use outra engine.`,
        costUsd: 0,
        raw: {},
      })
      return
    }
    const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_KIMI_BIN ?? 'kimi'
    const base = buildTurnArgs({ model: this.model, prompt: text, resumeSessionId: this.sessionId })
    const args = this.opts.extraArgsOverride ? [...this.opts.extraArgsOverride, ...base] : base
    // O MCP hermes entra pelo mcp.json do data root do projeto — a CLI não tem
    // flag de MCP por invocação (ver kimi-home.ts).
    const env = {
      ...process.env,
      PKG_EXECPATH: '',
      KIMI_CODE_HOME: ensureKimiHome(this.opts.projectPath, this.opts.hermes),
    }
    this.proc = spawn(bin, args, { cwd: this.opts.projectPath, stdio: ['ignore', 'pipe', 'pipe'], env })
    this.setStatus('working')
    let sawOutput = false
    const parser = createKimiTurnParser((evt) => {
      if (evt.kind === 'init' && evt.sessionId) this.sessionId = evt.sessionId
      if (evt.kind === 'assistant' || evt.kind === 'user') sawOutput = true
      this.emit('event', evt)
    }, this.model)
    this.proc.stdout.on('data', (d) => parser.feed(d))
    this.proc.stderr.on('data', (d) => {
      const s = d.toString(); this.stderrTail.push(s); if (this.stderrTail.length > 20) this.stderrTail.shift(); this.emit('stderr', s)
    })
    this.proc.on('close', async (code) => {
      this.proc = undefined
      if (this.stopping) { this.setStatus('stopped'); return }
      if (this.interrupting) { this.interrupting = false; this.setStatus('idle'); this.emit('exit', code); return }
      // Tokens do turno: o stdout não traz usage, mas o wire.jsonl da sessão sim.
      // Falha aqui nunca impede o result (só fica sem métrica). A sessão segue
      // 'working' durante o await, então um send() concorrente continua barrado.
      let tokens: TurnTokens | undefined
      if (this.sessionId) {
        try { tokens = await readLastTurnTokens(this.opts.projectPath, this.sessionId) } catch { tokens = undefined }
      }
      // A CLI não emite um evento de "fim de turno": o fim É o exit. Sintetiza
      // o result (sucesso ou erro) SEMPRE — sem ele, askAgent/dispatchTask
      // ficariam pendurados até o timeout esperando um kind==='result'.
      const failed = code !== 0 && !sawOutput
      this.emit('event', {
        kind: 'result' as const,
        subtype: failed ? 'error' : 'success',
        isError: failed,
        resultText: failed ? (this.lastStderr || `kimi terminou com código ${code}`) : parser.lastText(),
        costUsd: 0,
        raw: {},
        tokens,
      })
      if (failed) { this.setStatus('dead'); this.emit('exit', code); return }
      this.setStatus('needs_attention')
      this.emit('exit', code)
    })
    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        const msg = `\`${bin}\` não encontrado no PATH — instale a CLI do Kimi (npm install -g @moonshot-ai/kimi-code) ou configure CLAUDINEI_KIMI_BIN`
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
  setPermissionMode(_mode: string): Promise<void> { return Promise.resolve() } // headless: sem seletor
  setEffort(_effort: string): Promise<void> { return Promise.resolve() } // effort vem do config.toml do usuário

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
