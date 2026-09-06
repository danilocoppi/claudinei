import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Rejeição explícita: difere de timeout/desconexão, quando a entrega é incerta. */
export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

/** JSON-RPC por stdio. O processo pertence a UMA sessão; morrer rejeita todos os pedidos. */
export class CodexRpc {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private exited: Promise<void>

  constructor(opts: {
    bin: string; args: string[]; cwd: string
    notification: (method: string, params: any) => void
    failure: (err: Error) => void
    stderr: (text: string) => void
  }) {
    const p = this.proc = spawn(opts.bin, opts.args, {
      cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PKG_EXECPATH: '' },
    })
    this.exited = new Promise((resolve) => p.once('close', resolve))
    const fail = (err: Error) => {
      if (this.closed) return
      this.closed = true
      this.rejectPending(err)
      opts.failure(err)
      void this.stop()
    }
    p.on('error', (err: NodeJS.ErrnoException) => fail(new Error(err.code === 'ENOENT'
      ? `\`${opts.bin}\` não encontrado no PATH — instale a CLI do Codex (npm install -g @openai/codex)` : err.message)))
    p.on('close', (code) => fail(new Error(`codex app-server encerrou (${code})`)))
    p.stdin.on('error', fail)
    p.stderr.on('data', (d) => opts.stderr(d.toString()))
    let buffer = ''
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (chunk: string) => {
      if (this.closed) return
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.length > 16 * 1024 * 1024) { fail(new Error('codex: frame excede 16 MB')); return }
        let msg: any
        try { msg = JSON.parse(line) } catch { continue }
        if (!msg || typeof msg !== 'object') continue
        if (msg.method) {
          if (msg.id !== undefined) {
            // Nunca deixa um pedido interativo pendurado. O chat ainda não oferece
            // os formulários do Codex; o agente recebe erro e pode perguntar em prosa.
            this.write({ id: msg.id, error: { code: -32601, message: 'Interactive request unavailable in this chat. Ask the user in a message.' } })
          } else opts.notification(msg.method, msg.params)
        } else {
          const pending = this.pending.get(msg.id)
          if (!pending) continue
          this.pending.delete(msg.id); clearTimeout(pending.timer)
          if (msg.error) pending.reject(new CodexRpcError(msg.error.message ?? 'codex RPC error', msg.error.code))
          else pending.resolve(msg.result)
        }
      }
      if (buffer.length > 16 * 1024 * 1024) fail(new Error('codex: frame incompleto excede 16 MB'))
    })
  }

  private write(msg: object): void {
    if (this.closed) throw new Error('codex app-server desconectado')
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  request(method: string, params: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex: timeout em ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (err) { this.pending.delete(id); clearTimeout(timer); reject(err) }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'claudinei', version: '1.0.0' } })
    this.write({ method: 'initialized', params: {} })
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  async stop(): Promise<void> {
    this.closed = true
    this.rejectPending(new Error('codex app-server encerrado'))
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    this.proc.stdin.end(); this.proc.kill('SIGTERM')
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 3000)
    await this.exited
    clearTimeout(timer)
  }
}
