import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, chmodSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createUsageIndexStore, type UsageIndexStore } from '../src/usage-index/store.js'
import { createUsageIndexer } from '../src/usage-index/indexer.js'

// Históricos falsos escritos pelo teste num diretório temporário; o texto é fictício.

let dir: string
let claudeDir: string
let codexDir: string
let db: Db
let store: UsageIndexStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-indexer-'))
  claudeDir = join(dir, 'claude', 'projects')
  codexDir = join(dir, 'codex', 'sessions')
  db = openDb(':memory:')
  store = createUsageIndexStore(db)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const claudeLine = (id: string, input: number, opts: { requestId?: string; text?: string } = {}): string =>
  JSON.stringify({
    parentUuid: null,
    cwd: '/p/a',
    sessionId: 's1',
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: opts.text ?? 'texto fictício' }],
      usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    requestId: opts.requestId ?? `req_${id}`,
    type: 'assistant',
    timestamp: '2026-11-20T05:42:10.123Z',
  }) + '\n'

const userLine = (text: string): string =>
  JSON.stringify({ type: 'user', cwd: '/p/a', message: { role: 'user', content: text }, timestamp: '2026-11-20T05:40:00.000Z' }) + '\n'

const turnContext = (cwd = '/p/x', model = 'gpt-5-codex'): string =>
  JSON.stringify({ timestamp: '2026-11-20T06:00:00.000Z', type: 'turn_context', payload: { cwd, model } }) + '\n'

// input conta como input_tokens − cached_input_tokens
const tokenCount = (input: number, total: number): string =>
  JSON.stringify({
    timestamp: '2026-11-20T06:01:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0, total_tokens: input },
      },
    },
  }) + '\n'

const soma = (engine?: 'claude' | 'codex'): number =>
  (engine
    ? db.prepare('SELECT COALESCE(SUM(input), 0) AS n FROM usage_hourly WHERE engine = ?').get(engine) as { n: number }
    : db.prepare('SELECT COALESCE(SUM(input), 0) AS n FROM usage_hourly').get() as { n: number }).n

const immediate = (): Promise<void> => new Promise((r) => setImmediate(r))

const indexer = (over: Partial<Parameters<typeof createUsageIndexer>[0]> = {}) =>
  createUsageIndexer({ store, claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, log: () => {}, ...over })

// Soma os inputs das linhas completas do arquivo até o byte `offset`.
const somaAte = (path: string, offset: number): number =>
  readFileSync(path).subarray(0, offset).toString('utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((o) => o.type === 'assistant')
    .reduce((s, o) => s + o.message.usage.input_tokens, 0)

// Arquivo grande do Claude com texto multibyte e linhas de usuário longas que atravessam vários pedaços.
const arquivoGrande = (path: string): { total: number; size: number } => {
  let text = ''
  let total = 0
  for (let i = 0; i < 150; i++) {
    text += claudeLine(`msg_${i}`, i + 1, { text: `ação nº ${i} ✓ 🚀 ` + 'é'.repeat(i % 7) })
    total += i + 1
    if (i % 40 === 0) text += userLine('saída de ferramenta 🚀 ' + 'x'.repeat(5000))
  }
  write(path, text)
  return { total, size: Buffer.byteLength(text) }
}

describe('createUsageIndexer', () => {
  it('primeira passada conta Claude e Codex', async () => {
    write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10) + userLine('olá') + claudeLine('m2', 20))
    write(join(codexDir, '2026', '11', '20', 'rollout-1.jsonl'), turnContext() + tokenCount(40, 40) + tokenCount(40, 80))
    const ix = indexer()
    expect(ix.status()).toEqual({ running: false, filesDone: 0, filesTotal: 0, lastPassAt: null })
    await ix.runPass()
    expect(soma('claude')).toBe(30)
    expect(soma('codex')).toBe(80)
    const st = ix.status()
    expect(st.running).toBe(false)
    expect(st.filesTotal).toBe(2)
    expect(st.filesDone).toBe(2)
    expect(st.lastPassAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(store.fileCount()).toBe(2)
  })

  it('arquivo que cresce: só o novo é lido', async () => {
    const f = write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10) + claudeLine('m2', 20))
    const c = write(join(codexDir, '2026', '11', '20', 'rollout-1.jsonl'), turnContext() + tokenCount(40, 40))
    const ix = indexer()
    await ix.runPass()
    expect(soma()).toBe(70)
    appendFileSync(f, claudeLine('m3', 7))
    // o leitor do Codex retoma o estado salvo: a repetição do total continua ignorada
    appendFileSync(c, tokenCount(40, 40) + tokenCount(5, 45))
    await ix.runPass()
    expect(soma('claude')).toBe(37)
    expect(soma('codex')).toBe(45)
    expect(store.file(f)?.offset).toBe(statSync(f).size)
    expect(store.file(c)?.offset).toBe(statSync(c).size)
  })

  it('arquivo reescrito menor: relê do zero sem somar em dobro', async () => {
    const f = write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10) + claudeLine('m2', 20) + claudeLine('m3', 30))
    const ix = indexer()
    await ix.runPass()
    expect(soma()).toBe(60)
    writeFileSync(f, claudeLine('m1', 10))
    await ix.runPass()
    expect(soma()).toBe(10)
  })

  it('arquivo com mtime anterior ao salvo: relê do zero', async () => {
    const f = write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    const ix = indexer()
    await ix.runPass()
    // mesmo tamanho no começo, conteúdo diferente: só o reset conta o 99
    writeFileSync(f, claudeLine('m1', 99) + claudeLine('m2', 20))
    utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'))
    await ix.runPass()
    expect(soma()).toBe(119)
  })

  it('arquivo apagado: os números ficam', async () => {
    const f = write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    const ix = indexer()
    await ix.runPass()
    rmSync(f)
    await ix.runPass()
    expect(soma()).toBe(10)
    expect(ix.status().filesTotal).toBe(0)
  })

  it('linha cortada no fim espera completar', async () => {
    const primeira = claudeLine('m1', 10)
    const segunda = claudeLine('m2', 20, { text: 'ação ✓' })
    const corte = segunda.length - 15
    const f = write(join(claudeDir, 'proj-a', 's1.jsonl'), primeira + segunda.slice(0, corte))
    const ix = indexer()
    await ix.runPass()
    expect(soma()).toBe(10)
    expect(store.file(f)?.offset).toBe(Buffer.byteLength(primeira))
    appendFileSync(f, segunda.slice(corte))
    await ix.runPass()
    expect(soma()).toBe(30)
    await ix.runPass()
    expect(soma()).toBe(30)
  })

  it('mesma resposta em dois arquivos de subagente conta uma vez', async () => {
    write(join(claudeDir, 'proj-a', 's1', 'subagents', 'agent-a.jsonl'), claudeLine('m1', 10, { requestId: 'r1' }))
    write(join(claudeDir, 'proj-a', 's1', 'subagents', 'agent-b.jsonl'), claudeLine('m1', 10, { requestId: 'r1' }) + claudeLine('m2', 5))
    await indexer().runPass()
    expect(soma()).toBe(15)
  })

  it('subagents/workflows/wf_x/agent.jsonl é lido', async () => {
    write(join(claudeDir, 'proj-a', 's1', 'subagents', 'workflows', 'wf_x', 'agent.jsonl'), claudeLine('m1', 10))
    // fora de subagents/ nada sob a pasta da sessão é lido
    write(join(claudeDir, 'proj-a', 's1', 'outra', 'x.jsonl'), claudeLine('m9', 1000))
    write(join(claudeDir, 'proj-a', 's1', 'subagents', 'notas.txt'), claudeLine('m8', 1000))
    const ix = indexer()
    await ix.runPass()
    expect(soma()).toBe(10)
    expect(ix.status().filesTotal).toBe(1)
  })

  it('pasta do Codex inexistente não falha', async () => {
    write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    const ix = indexer({ codexSessionsDir: join(dir, 'nao-existe') })
    await ix.runPass()
    expect(soma('claude')).toBe(10)
    expect(ix.status().lastPassAt).not.toBeNull()
    // as duas pastas ausentes também terminam sem erro
    await indexer({ claudeProjectsDir: join(dir, 'nada'), codexSessionsDir: join(dir, 'nada2') }).runPass()
  })

  it('arquivo maior que a fatia é lido em várias fatias e cede o laço', async () => {
    const f = join(claudeDir, 'proj-a', 's1.jsonl')
    const { total, size } = arquivoGrande(f)
    expect(size).toBeGreaterThan(50_000)
    const yieldNow = vi.fn(immediate)
    const ordem: string[] = []
    setImmediate(() => ordem.push('immediate'))
    const p = indexer({ sliceBytes: 1024, yieldNow }).runPass().then(() => ordem.push('passada'))
    await p
    expect(ordem).toEqual(['immediate', 'passada'])
    expect(yieldNow.mock.calls.length).toBeGreaterThan(10)
    expect(soma()).toBe(total)
    expect(store.file(f)?.offset).toBe(size)
  })

  it('stop no meio deixa o banco coerente', async () => {
    const f = join(claudeDir, 'proj-a', 's1.jsonl')
    const { total, size } = arquivoGrande(f)
    let n = 0
    let parando: Promise<void> | undefined
    const ix = indexer({
      sliceBytes: 1024,
      yieldNow: async () => {
        if (++n === 3) parando = ix.stop()
        await immediate()
      },
    })
    await ix.runPass()
    await parando
    expect(n).toBe(3)
    const salvo = store.file(f)!
    expect(salvo.offset).toBeGreaterThan(0)
    expect(salvo.offset).toBeLessThan(size)
    expect(soma()).toBe(somaAte(f, salvo.offset))
    expect(ix.status()).toMatchObject({ running: false, lastPassAt: null })
    // uma nova passada completa chega ao total, sem dobrar
    await ix.runPass()
    expect(soma()).toBe(total)
    expect(ix.status().lastPassAt).not.toBeNull()
  })

  it('duas chamadas de runPass ao mesmo tempo fazem uma passada só', async () => {
    write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    write(join(codexDir, 'r.jsonl'), turnContext() + tokenCount(40, 40))
    const yieldNow = vi.fn(immediate)
    const ix = indexer({ yieldNow, sliceBytes: 64 })
    const a = ix.runPass()
    const b = ix.runPass()
    expect(b).toBe(a)
    await Promise.all([a, b])
    expect(soma()).toBe(50)
    const c = ix.runPass()
    expect(c).not.toBe(a)
    await c
    expect(soma()).toBe(50)
  })

  it('status mostra filesDone/filesTotal durante a passada', async () => {
    for (const s of ['s1', 's2', 's3']) write(join(claudeDir, 'proj-a', `${s}.jsonl`), claudeLine(`m_${s}`, 10).repeat(1) + userLine('x'.repeat(3000)))
    const vistos: Array<ReturnType<ReturnType<typeof indexer>['status']>> = []
    const ix = indexer({
      sliceBytes: 1024,
      yieldNow: async () => { vistos.push(ix.status()); await immediate() },
    })
    await ix.runPass()
    expect(vistos.length).toBeGreaterThan(3)
    for (const v of vistos) {
      expect(v.running).toBe(true)
      expect(v.filesTotal).toBe(3)
      expect(v.filesDone).toBeGreaterThanOrEqual(0)
      expect(v.filesDone).toBeLessThanOrEqual(3)
    }
    expect(vistos.map((v) => v.filesDone)).toEqual([...vistos.map((v) => v.filesDone)].sort())
    expect(new Set(vistos.map((v) => v.filesDone)).size).toBeGreaterThan(1)
    expect(ix.status()).toMatchObject({ running: false, filesDone: 3, filesTotal: 3 })
  })

  it('arquivo sem mudança não é reaberto; arquivo ilegível é registrado e pulado', async () => {
    // a última linha está incompleta: o offset fica antes do fim, mas sem mudança o arquivo nem é aberto
    const a = write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10) + '{"type":"assis')
    const log = vi.fn()
    const ix = indexer({ log })
    await ix.runPass()
    chmodSync(a, 0o000)
    const b = write(join(claudeDir, 'proj-a', 's2.jsonl'), claudeLine('m2', 20))
    const c = write(join(claudeDir, 'proj-a', 's3.jsonl'), claudeLine('m3', 5))
    chmodSync(b, 0o000)
    try {
      await ix.runPass()
    } finally {
      chmodSync(a, 0o644)
      chmodSync(b, 0o644)
    }
    expect(soma()).toBe(15)
    const msgs = log.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes(a))).toBe(false)
    expect(msgs.some((m) => m.includes(b) && m.includes('EACCES'))).toBe(true)
    expect(store.file(c)?.offset).toBe(statSync(c).size)
    expect(ix.status()).toMatchObject({ filesDone: 3, filesTotal: 3 })
  })

  it('start roda uma passada já, e stop para o relógio', async () => {
    write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    const ix = indexer()
    ix.start(60_000)
    await vi.waitFor(() => expect(ix.status().lastPassAt).not.toBeNull())
    await ix.stop()
    expect(soma()).toBe(10)
    expect(ix.status().running).toBe(false)
  })

  it('erro numa passada do relógio é registrado, sem rejeição solta', async () => {
    write(join(claudeDir, 'proj-a', 's1.jsonl'), claudeLine('m1', 10))
    const quebrado = { ...store, commitSlice: () => { throw new Error('banco fechado') } } as UsageIndexStore
    const log = vi.fn()
    const ix = createUsageIndexer({ store: quebrado, claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, log })
    ix.start(60_000)
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    await ix.stop()
    expect(ix.status()).toMatchObject({ running: false, lastPassAt: null })
  })
})
