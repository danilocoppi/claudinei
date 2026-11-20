import { constants as bufferConstants } from 'node:buffer'
import { promises as fsp, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createCodexParser, readClaudeLine, type CodexParser } from './readers.js'
import type { FileState, UsageEngine, UsageIndexStore, UsageRow } from './store.js'

export interface IndexStatus { running: boolean; filesDone: number; filesTotal: number; lastPassAt: string | null }

export interface UsageIndexerDeps {
  store: UsageIndexStore
  claudeProjectsDir: string
  codexSessionsDir: string
  sliceBytes?: number
  sliceMs?: number
  yieldNow?: () => Promise<void>
  log?: (msg: string) => void
}

export interface UsageIndexer {
  runPass(): Promise<void>
  start(intervalMs?: number): void
  stop(): Promise<void>
  status(): IndexStatus
}

const CHUNK = 1024 * 1024
const NEWLINE = 10

// Os mesmos filtros baratos dos leitores, aplicados nos bytes: uma linha que não
// os contém nem chega a virar string (as linhas de ferramenta podem ter megabytes).
const CLAUDE_MARK = Buffer.from('"type":"assistant"')
const CODEX_MARKS = [Buffer.from('"turn_context"'), Buffer.from('"token_count"')]

interface Target { path: string; engine: UsageEngine }
interface Pass { aborted: boolean }
type Hit = { key?: string; row: UsageRow }

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'erro'
}

/**
 * Falha do banco do índice. Ela derruba a passada (o `start` registra e tenta de novo no
 * próximo relógio), porque se repetiria em todos os arquivos. Qualquer outro erro dentro de
 * um arquivo (sistema de arquivos, decodificação, leitor) só pula aquele arquivo.
 */
class StoreFailure extends Error {
  constructor(readonly original: unknown) {
    super('falha no banco do índice de uso')
  }
}

function inStore<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new StoreFailure(e)
  }
}

/**
 * Indexador incremental dos históricos JSONL do Claude e do Codex.
 * Lê só o que cresceu desde a última passada, em fatias de `sliceBytes` ou `sliceMs`
 * (o orçamento vale para a passada inteira, somando arquivos), grava cada fatia de um
 * arquivo num único `commitSlice` e cede o laço de eventos entre as fatias.
 */
export function createUsageIndexer(deps: UsageIndexerDeps): UsageIndexer {
  const { store } = deps
  const sliceBytes = Math.max(1, deps.sliceBytes ?? 20 * 1024 * 1024)
  const sliceMs = deps.sliceMs ?? 200
  const yieldNow = deps.yieldNow ?? (() => new Promise<void>((r) => setImmediate(r)))
  const log = deps.log ?? ((msg: string) => console.log(msg))

  const st: IndexStatus = { running: false, filesDone: 0, filesTotal: 0, lastPassAt: null }
  let current: Promise<void> | null = null
  let currentPass: Pass | null = null
  let timer: NodeJS.Timeout | null = null
  // Arquivos gravados na passada em curso: sem nenhum, a passada rápida não vai para o log.
  let updated = 0

  // Uma falha que se repete (arquivo ou pasta sem permissão) vai para o log uma vez por
  // caminho e código enquanto o processo vive, e não a cada passada de 10 min.
  const reported = new Set<string>()
  const logOnce = (path: string, code: string, msg: string): void => {
    const key = `${path}\u0000${code}`
    if (reported.has(key)) return
    reported.add(key)
    log(msg)
  }

  // Orçamento da fatia em curso, acumulado entre arquivos.
  let usedBytes = 0
  let sliceStart = 0
  const spent = (): boolean => usedBytes >= sliceBytes || performance.now() - sliceStart >= sliceMs
  const resetBudget = (): void => { usedBytes = 0; sliceStart = performance.now() }
  /** Cede o laço e abre uma fatia nova; devolve true se a passada foi interrompida. */
  async function cede(pass: Pass): Promise<boolean> {
    await yieldNow()
    resetBudget()
    return pass.aborted
  }

  async function readDir(dir: string): Promise<Dirent[]> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (e) {
      const code = errCode(e)
      if (code !== 'ENOENT') logOnce(dir, code, `uso: pasta ignorada ${dir}: ${code}`)
      return []
    }
  }

  /** Todo `*.jsonl` sob `dir`, recursivamente; links simbólicos não são seguidos. */
  async function walk(dir: string, engine: UsageEngine, out: Target[], pass: Pass): Promise<boolean> {
    for (const ent of await readDir(dir)) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (await walk(p, engine, out, pass)) return true
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ path: p, engine })
      }
    }
    return spent() && (await cede(pass))
  }

  /** Lista os arquivos da passada; null se ela foi interrompida no meio. */
  async function discover(pass: Pass): Promise<Target[] | null> {
    const out: Target[] = []
    // Claude: <projetos>/*/*.jsonl e, na pasta de cada sessão, só subagents/ (recursivo).
    for (const proj of await readDir(deps.claudeProjectsDir)) {
      if (!proj.isDirectory()) continue
      const projDir = join(deps.claudeProjectsDir, proj.name)
      for (const ent of await readDir(projDir)) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push({ path: join(projDir, ent.name), engine: 'claude' })
        else if (ent.isDirectory() && (await walk(join(projDir, ent.name, 'subagents'), 'claude', out, pass))) return null
      }
      if (spent() && (await cede(pass))) return null
    }
    // Codex: todo *.jsonl sob a pasta de sessões.
    if (await walk(deps.codexSessionsDir, 'codex', out, pass)) return null
    return out
  }

  /** Lê o que falta de um arquivo; devolve true se a passada foi interrompida. */
  async function indexFile(t: Target, pass: Pass): Promise<boolean> {
    const info = await fsp.stat(t.path)
    if (!info.isFile()) return false
    const size = info.size
    const mtimeMs = Math.floor(info.mtimeMs)
    let saved = inStore(() => store.file(t.path))
    if (saved && saved.size === size && saved.mtimeMs === mtimeMs) return false
    // Arquivo reescrito: o que veio dele só é apagado logo antes do primeiro commit, depois
    // de abrir e ler o arquivo novo. Se ele sumir ou não abrir, os números antigos ficam.
    let resetPending = false
    if (saved && (size < saved.offset || mtimeMs < saved.mtimeMs)) {
      resetPending = true
      saved = undefined
    }
    const codex: CodexParser | null = t.engine === 'codex' ? createCodexParser(saved?.parser ?? null) : null
    let offset = saved?.offset ?? 0 // byte logo depois da última linha completa consumida
    let hits: Hit[] = []
    let touched = false // já contado em `updated` nesta passada
    const commit = (final: boolean): void => {
      // Uma fatia intermediária grava `size` = offset: se a passada parar aqui, o arquivo
      // não parece inalterado na próxima e a leitura continua do offset.
      const state: FileState = {
        path: t.path, engine: t.engine, size: final ? size : offset, mtimeMs, offset, parser: codex ? codex.state() : null,
      }
      const batch = hits
      hits = []
      if (!touched) updated++
      touched = true
      inStore(() => {
        if (resetPending) store.resetFile(t.path)
        resetPending = false
        store.commitSlice(state, batch)
      })
    }
    const handle = (line: Buffer): void => {
      // Uma linha maior que a maior string do V8 nem pode ser decodificada: fica de fora.
      if (line.length > bufferConstants.MAX_STRING_LENGTH) {
        log(`uso: linha grande demais ignorada em ${t.path} (${line.length} bytes)`)
        return
      }
      if (codex) {
        if (!CODEX_MARKS.some((m) => line.includes(m))) return
        const row = codex.feed(line.toString('utf8'))
        if (row) hits.push({ row })
      } else {
        if (!line.includes(CLAUDE_MARK)) return
        const hit = readClaudeLine(line.toString('utf8'))
        if (hit) hits.push(hit)
      }
    }

    if (offset < size || resetPending) {
      const fh = await fsp.open(t.path, 'r')
      try {
        let pos = offset
        let pending: Buffer[] = [] // pedaços de uma linha que ainda não terminou
        while (pos < size) {
          const want = Math.min(CHUNK, size - pos, Math.max(1, sliceBytes - usedBytes))
          const chunk = Buffer.allocUnsafe(want)
          const { bytesRead } = await fh.read(chunk, 0, want, pos)
          if (bytesRead === 0) break // encolheu durante a leitura: a próxima passada decide
          pos += bytesRead
          usedBytes += bytesRead
          const data = chunk.subarray(0, bytesRead)
          let start = 0
          for (let nl = data.indexOf(NEWLINE, start); nl !== -1; nl = data.indexOf(NEWLINE, start)) {
            const piece = data.subarray(start, nl)
            const line = pending.length ? Buffer.concat([...pending, piece]) : piece
            pending = []
            offset += line.length + 1
            handle(line)
            start = nl + 1
          }
          if (start < data.length) pending.push(data.subarray(start))
          if (pos < size && spent()) {
            commit(false)
            if (await cede(pass)) return true
          }
        }
      } finally {
        await fh.close()
      }
    }
    commit(true)
    return false
  }

  async function pass(p: Pass): Promise<void> {
    const t0 = performance.now()
    st.running = true
    st.filesDone = 0
    st.filesTotal = 0
    updated = 0
    resetBudget()
    try {
      const targets = await discover(p)
      if (!targets) return
      st.filesTotal = targets.length
      for (const t of targets) {
        try {
          if (await indexFile(t, p)) return
        } catch (e) {
          if (e instanceof StoreFailure) throw e.original
          // Só o caminho e o código (ou o nome) do erro: a mensagem pode trazer texto da linha.
          const code = errCode(e)
          logOnce(t.path, code, `uso: arquivo ignorado ${t.path}: ${code}`)
        }
        st.filesDone++
        if (spent() && (await cede(p))) return
      }
      st.lastPassAt = new Date().toISOString()
      // Passada sem nada novo e rápida (a de quase todo relógio de 10 min) não vai para o log.
      const ms = Math.round(performance.now() - t0)
      if (updated > 0 || ms > 1000) {
        log(`uso: passada do índice concluída (${targets.length} arquivos, ${updated} atualizados, ${ms} ms)`)
      }
    } finally {
      st.running = false
    }
  }

  /**
   * Uma passada por vez. Se a atual já foi interrompida por `stop()`, a nova espera ela
   * sair e só então começa; chamadas seguintes recebem essa mesma passada nova.
   */
  function runPass(): Promise<void> {
    if (current && currentPass && !currentPass.aborted) return current
    const p: Pass = { aborted: false }
    const run = current
      ? current.catch(() => {}).then(() => (p.aborted ? undefined : pass(p)))
      : pass(p)
    const tracked: Promise<void> = run.finally(() => {
      if (current === tracked) {
        current = null
        currentPass = null
      }
    })
    current = tracked
    currentPass = p
    return tracked
  }

  function tick(): void {
    if (current && currentPass && !currentPass.aborted) return
    runPass().catch((e) => log(`uso: passada do índice falhou: ${errCode(e)}`))
  }

  return {
    runPass,
    start(intervalMs = 600_000): void {
      if (timer) return
      timer = setInterval(tick, intervalMs)
      timer.unref()
      tick()
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer)
      timer = null
      if (!current) return
      if (currentPass) currentPass.aborted = true
      await current.catch(() => {})
    },
    status(): IndexStatus {
      return { ...st }
    },
  }
}
