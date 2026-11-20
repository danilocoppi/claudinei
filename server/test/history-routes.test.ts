import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { HISTORY_EVENT_LIMIT } from '../src/routes/sessions.js'
import { lastEventsOf, type HistoryPage, type PositionedEvent } from '../src/history-page.js'

/**
 * Rota de histórico em páginas: `{ events, before, atStart }`. Os eventos são
 * os ÚLTIMOS `limit` antes de `before`, cada um com o byte da sua linha; a
 * página anterior pede `before` igual ao que a resposta devolveu.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const TMPs: string[] = []
const novoDir = (nome: string) => {
  const d = mkdtempSync(join(tmpdir(), nome))
  TMPs.push(d)
  return d
}
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  for (const d of TMPs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
})

const linha = (i: number) =>
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"msg-${i}"}]}}`

let db: Db
let app: Awaited<ReturnType<typeof buildApp>>
let projectId: number
let transcriptDir: string

beforeEach(async () => {
  const cfgDir = novoDir('cfg-')
  const projPath = novoDir('tm-')
  transcriptDir = join(cfgDir, 'projects', projPath.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(transcriptDir, { recursive: true })
  // claudeEngine lê o config dir direto do process.env.
  process.env.CLAUDE_CONFIG_DIR = cfgDir
  db = openDb(':memory:')
  // Manager antes das rows: a varredura de órfãs do boot não pode vê-las.
  const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({ CLAUDE_CONFIG_DIR: cfgDir }), db, manager: mgr })
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', path: projPath } })).json().id
})
afterEach(async () => { await app.close() })

/** Grava o transcript `sid.jsonl` com `n` linhas e devolve o byte de início de cada uma. */
function transcript(sid: string, n: number): number[] {
  const inicios: number[] = []
  let pos = 0
  const linhas = Array.from({ length: n }, (_, i) => linha(i))
  for (const l of linhas) { inicios.push(pos); pos += Buffer.byteLength(l + '\n') }
  writeFileSync(join(transcriptDir, `${sid}.jsonl`), linhas.join('\n') + '\n')
  return inicios
}

const sessaoCom = (localId: string, sid: string | null, continueLatest = 0) =>
  db.prepare(
    `INSERT INTO sessions (local_id, project_id, status, continue_latest, claude_session_id) VALUES (?, ?, 'stopped', ?, ?)`,
  ).run(localId, projectId, continueLatest, sid)

const textoDe = (e: { message?: { content?: Array<{ text?: string }> } }) => e.message?.content?.[0]?.text

describe('rota de histórico em páginas', () => {
  it('histórico sem parâmetros devolve os últimos 300 com before e atStart false num arquivo maior', async () => {
    const inicios = transcript('sid-grande', HISTORY_EVENT_LIMIT + 50)
    sessaoCom('h-1', 'sid-grande')
    const res = await app.inject({ method: 'GET', url: '/api/sessions/h-1/history' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.events).toHaveLength(HISTORY_EVENT_LIMIT)
    expect(textoDe(body.events[0])).toBe('msg-50')
    expect(textoDe(body.events.at(-1))).toBe(`msg-${HISTORY_EVENT_LIMIT + 49}`)
    expect(body.events[0].pos).toBe(inicios[50])
    expect(body.before).toBe(inicios[50])
    expect(body.atStart).toBe(false)
  })

  it('before encadeado chega ao começo com atStart true', async () => {
    const inicios = transcript('sid-cadeia', 450)
    sessaoCom('h-2', 'sid-cadeia')
    const vistos: string[] = []
    let before: number | undefined
    let atStart = false
    let pedidos = 0
    while (!atStart) {
      const url = `/api/sessions/h-2/history?limit=200${before === undefined ? '' : `&before=${before}`}`
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      vistos.unshift(...body.events.map(textoDe))
      before = body.before
      atStart = body.atStart
      if (++pedidos > 10) throw new Error('não chegou ao começo')
    }
    expect(pedidos).toBe(3)
    expect(before).toBe(inicios[0])
    // Sem repetir nem pular: todas as mensagens, na ordem do arquivo.
    expect(vistos).toEqual(Array.from({ length: 450 }, (_, i) => `msg-${i}`))
  })

  it('limit fora de 1..500 e before negativo dão 400', async () => {
    transcript('sid-val', 3)
    sessaoCom('h-3', 'sid-val')
    for (const q of ['limit=0', 'limit=501', 'limit=abc', 'limit=2.5', 'before=-1', 'before=abc', 'before=1.5', 'before=1&before=2']) {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/h-3/history?${q}` })
      expect(res.statusCode, q).toBe(400)
    }
    expect((await app.inject({ method: 'GET', url: '/api/sessions/h-3/history?limit=500&before=0' })).statusCode).toBe(200)
  })

  it('prévia sem engineSessionId usa o mesmo formato', async () => {
    const inicios = transcript('sid-anterior', 5)
    sessaoCom('h-4', null, 1)
    const res = await app.inject({ method: 'GET', url: '/api/sessions/h-4/history?limit=2' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.events.map(textoDe)).toEqual(['msg-3', 'msg-4'])
    expect(body.before).toBe(inicios[3])
    expect(body.atStart).toBe(false)
    const antes = (await app.inject({ method: 'GET', url: `/api/sessions/h-4/history?before=${body.before}` })).json()
    expect(antes.events.map(textoDe)).toEqual(['msg-0', 'msg-1', 'msg-2'])
    expect(antes.atStart).toBe(true)

    // Sem continue não há o que mostrar: página vazia, no começo.
    sessaoCom('h-5', null, 0)
    const vazio = (await app.inject({ method: 'GET', url: '/api/sessions/h-5/history' })).json()
    expect(vazio).toEqual({ events: [], before: 0, atStart: true })
  })

  it('sem transcript: página vazia no começo', async () => {
    sessaoCom('h-6', 'sid-que-nao-existe')
    const res = await app.inject({ method: 'GET', url: '/api/sessions/h-6/history' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ events: [], before: 0, atStart: true })
  })

  it('erro de leitura vira 500, nunca começo da conversa', async () => {
    // Um diretório no lugar do transcript: abre, mas a leitura falha (EISDIR).
    mkdirSync(join(transcriptDir, 'sid-quebrado.jsonl'))
    sessaoCom('h-7', 'sid-quebrado')
    const res = await app.inject({ method: 'GET', url: '/api/sessions/h-7/history' })
    expect(res.statusCode).toBe(500)
    expect(res.json().atStart).toBeUndefined()
    expect(res.json().code).toBe('history_read_failed')
  })
})

describe('corte da página nos últimos `limit` (R2: nunca parte uma linha)', () => {
  const evt = (pos: number, t: string): PositionedEvent =>
    ({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, raw: {}, pos })
  const pagina = (events: PositionedEvent[], start = 0, atStart = true): HistoryPage => ({ events, start, atStart })

  it('mantém todos os eventos que dividem o pos do primeiro mantido', () => {
    // Linha em 10 rende três eventos; o corte em 3 cairia no meio dela.
    const events = [evt(0, 'a'), evt(10, 'b1'), evt(10, 'b2'), evt(10, 'b3'), evt(20, 'c'), evt(30, 'd')]
    const r = lastEventsOf(pagina(events), 3)
    expect(r.events.map((e) => (e as any).message.content[0].text)).toEqual(['b1', 'b2', 'b3', 'c', 'd'])
    expect(r.before).toBe(10)
    expect(r.atStart).toBe(false)
  })

  it('sem corte: before é o pos do primeiro, atStart é o da janela', () => {
    const r = lastEventsOf(pagina([evt(5, 'a'), evt(9, 'b')], 0, true), 3)
    expect(r).toMatchObject({ before: 5, atStart: true })
    expect(r.events).toHaveLength(2)
    const meio = lastEventsOf(pagina([evt(50, 'a')], 40, false), 3)
    expect(meio).toMatchObject({ before: 50, atStart: false })
  })

  it('janela vazia: before é o start dela', () => {
    expect(lastEventsOf(pagina([], 1234, false), 3)).toEqual({ events: [], before: 1234, atStart: false })
  })

  it('a linha toda no corte: devolve a linha inteira mesmo acima do limite', () => {
    const events = [evt(0, 'a'), evt(7, 'x'), evt(7, 'y'), evt(7, 'z')]
    const r = lastEventsOf(pagina(events), 2)
    expect(r.events).toHaveLength(3)
    expect(r.before).toBe(7)
    expect(r.atStart).toBe(false)
  })
})
