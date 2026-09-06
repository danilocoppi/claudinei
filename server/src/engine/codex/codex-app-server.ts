import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

export interface CodexMetadataSnapshot {
  models?: unknown[]
  configuredModel?: string
  rateLimits?: unknown
}

/**
 * Consultas de metadados via o protocolo oficial, usando o login da própria CLI.
 * Não abre thread/turno. O processo dura só esta consulta, com teto de tempo e
 * saída; falhas de um método não descartam as respostas dos demais.
 * https://learn.chatgpt.com/docs/app-server
 */
export function readCodexMetadata(opts: {
  bin?: string; args?: string[]; timeoutMs?: number
} = {}): Promise<CodexMetadataSnapshot> {
  return new Promise((resolve) => {
    const proc = spawn(opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex', opts.args ?? ['app-server'], {
      cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, PKG_EXECPATH: '' },
    })
    const snapshot: CodexMetadataSnapshot = {}
    const pending = new Map<number, string>([[0, 'initialize']])
    let nextId = 1
    let done = false
    let buffer = ''
    let bytes = 0
    const models: unknown[] = []
    const cursors = new Set<string>()
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.stdin.end()
      proc.kill('SIGTERM')
      if (proc.exitCode === null && proc.signalCode === null) {
        killTimer = setTimeout(() => proc.kill('SIGKILL'), 1_000)
        killTimer.unref()
      }
      resolve(snapshot)
    }
    const timer = setTimeout(finish, opts.timeoutMs ?? 10_000)
    const send = (message: object) => { if (!done) proc.stdin.write(`${JSON.stringify(message)}\n`) }
    const request = (method: string, params?: object) => {
      const id = nextId++
      pending.set(id, method)
      send({ id, method, ...(params ? { params } : {}) })
    }
    proc.on('error', finish)
    proc.stdin.on('error', finish)
    proc.on('close', () => { finish(); clearTimeout(killTimer) })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (done) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > 2 * 1024 * 1024) { finish(); return }
      buffer += chunk
      let end: number
      while (!done && (end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let msg: any
        try { msg = JSON.parse(line) } catch { continue }
        if (!msg || !pending.has(msg.id) || msg.method) continue
        const method = pending.get(msg.id)
        pending.delete(msg.id)
        const r = msg.error ? undefined : msg.result
        if (method === 'initialize') {
          if (!r) { finish(); return }
          send({ method: 'initialized', params: {} })
          request('model/list', { includeHidden: false, limit: 100 })
          request('account/rateLimits/read')
          request('config/read', { includeLayers: false })
        } else if (method === 'model/list' && Array.isArray(r?.data)) {
          models.push(...r.data)
          if (typeof r.nextCursor === 'string' && r.nextCursor) {
            if (!cursors.has(r.nextCursor) && cursors.size < 20) {
              cursors.add(r.nextCursor)
              request('model/list', { includeHidden: false, limit: 100, cursor: r.nextCursor })
            }
          } else snapshot.models = models
        } else if (method === 'account/rateLimits/read' && r) {
          // Só os limites: não repassa identificadores da conta nem créditos resgatáveis.
          snapshot.rateLimits = { rateLimits: r.rateLimits, rateLimitsByLimitId: r.rateLimitsByLimitId }
        } else if (method === 'config/read' && typeof r?.config?.model === 'string') {
          snapshot.configuredModel = r.config.model
        }
        if (pending.size === 0) finish()
      }
    })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'claudinei', version: '1.0.0' } } })
  })
}
