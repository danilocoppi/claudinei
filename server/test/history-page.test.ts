import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLinesBefore, readPositionedTail, type PositionedLine } from '../src/tail.js'
import { readPage } from '../src/history-page.js'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { codexEngine } from '../src/engine/codex/codex-engine.js'
import { kimiEngine } from '../src/engine/kimi/kimi-engine.js'
import { kimiHomeFor } from '../src/engine/kimi/kimi-home.js'
import type { AgentEvent, Engine } from '../src/engine/types.js'

// Conta as varreduras de diretório: a página do Codex não pode repetir a busca
// do rollout em ~/.codex/sessions a cada pedido (ela é síncrona).
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, readdirSync: vi.fn(real.readdirSync) }
})

/**
 * Histórico em páginas: cada evento leva o byte de início da sua linha no
 * arquivo da engine, e a página seguinte pede "o que vem antes do byte X". O
 * arquivo só cresce no fim, então essa posição não muda com o tempo — é a
 * identidade estável da mensagem na tela.
 */

const TMPs: string[] = []
const novoDir = (nome: string) => {
  const d = mkdtempSync(join(tmpdir(), nome))
  TMPs.push(d)
  return d
}
const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDINEI_KIMI_HOMES'] as const
const envAntes = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const d of TMPs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const k of ENV) {
    if (envAntes[k] === undefined) delete process.env[k]
    else process.env[k] = envAntes[k]
  }
})

/** Grava as linhas (cada uma terminada em \n) e devolve o arquivo e o byte de início de cada uma. */
function gravar(linhas: string[], dir = novoDir('page-')): { file: string; inicios: number[] } {
  const file = join(dir, 'dados.jsonl')
  const inicios: number[] = []
  let pos = 0
  for (const l of linhas) { inicios.push(pos); pos += Buffer.byteLength(l + '\n') }
  writeFileSync(file, linhas.map((l) => l + '\n').join(''))
  return { file, inicios }
}

/** Remove o `pos` para comparar com o que o readHistory devolve. */
const semPos = (evts: Array<AgentEvent & { pos: number }>) => evts.map(({ pos: _pos, ...e }) => e)

describe('readLinesBefore', () => {
  it('readLinesBefore devolve posições absolutas e descarta a linha partida', async () => {
    const { file, inicios } = gravar(['primeira', 'segunda linha', 'terceira e última'])
    // `before` no meio da 3ª: ela está cortada, então não entra.
    const r = await readLinesBefore(file, inicios[2] + 4, 1024)
    expect(r.lines).toEqual([
      { text: 'primeira', pos: inicios[0] },
      { text: 'segunda linha', pos: inicios[1] },
    ])
    expect(r.atStart).toBe(true)
    expect(r.start).toBe(0)
  })

  it('janela que não começa no byte 0 descarta a primeira linha, partida', async () => {
    const { file, inicios } = gravar(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'])
    // Janela de 15 bytes até o fim: começa no meio da 2ª linha.
    const r = await readLinesBefore(file, undefined, 15)
    expect(r.lines).toEqual([{ text: 'cccccccccc', pos: inicios[2] }])
    expect(r.start).toBe(inicios[2])
    expect(r.atStart).toBe(false)
  })

  it('páginas sucessivas cobrem o arquivo sem repetir nem pular', async () => {
    const linhas = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i, t: 'x'.repeat(i % 37) }))
    const { file, inicios } = gravar(linhas)
    const vistos: number[] = []
    let before: number | undefined
    let paginas = 0
    for (;;) {
      const p = await readPositionedTail(file, (ls: PositionedLine[]) => ls, {
        before, minItems: 200, firstChunkBytes: 512,
      })
      paginas++
      // Cada página vem em ordem crescente e termina antes da anterior.
      vistos.unshift(...p.items.map((l) => l.pos))
      for (const l of p.items) expect(l.text).toBe(linhas[inicios.indexOf(l.pos)])
      if (p.atStart) break
      expect(p.start).toBeLessThan(before ?? Infinity)
      before = p.start
      expect(paginas).toBeLessThan(100)
    }
    expect(vistos).toEqual(inicios)
    expect(paginas).toBeGreaterThan(1)
  })

  it('linha maior que a janela entra inteira (nunca uma página vazia no meio do arquivo)', async () => {
    const grande = 'x'.repeat(1000)
    const { file, inicios } = gravar(['a', grande, 'b'])
    // Janela de 10 bytes até o fim: só cabe o 'b'.
    const p1 = await readLinesBefore(file, undefined, 10)
    expect(p1.lines).toEqual([{ text: 'b', pos: inicios[2] }])
    // Antes do 'b' só há o pedaço final da linha grande: estende até o começo dela.
    const p2 = await readLinesBefore(file, p1.start, 10)
    expect(p2.lines).toEqual([{ text: grande, pos: inicios[1] }])
    expect(p2.start).toBe(inicios[1])
    expect(p2.atStart).toBe(false)
    const p3 = await readLinesBefore(file, p2.start, 10)
    expect(p3.lines).toEqual([{ text: 'a', pos: 0 }])
    expect(p3.atStart).toBe(true)
  })

  it('`before` no meio de uma linha grande, sem quebra na janela: devolve a linha completa anterior', async () => {
    const grande = 'x'.repeat(1000)
    const { file, inicios } = gravar(['a', grande, 'b'])
    const r = await readLinesBefore(file, inicios[1] + 500, 10)
    expect(r.lines).toEqual([{ text: 'a', pos: 0 }])
    expect(r.atStart).toBe(true)
  })

  it('readPositionedTail sempre avança, mesmo com o teto menor que uma linha', async () => {
    const linhas = ['curta', 'y'.repeat(300), 'outra', 'z'.repeat(500), 'fim']
    const { file, inicios } = gravar(linhas)
    const vistos: number[] = []
    let before: number | undefined
    for (let i = 0; i < 20; i++) {
      const p = await readPositionedTail(file, (ls: PositionedLine[]) => ls, {
        before, minItems: 1, maxBytes: 16, firstChunkBytes: 16,
      })
      vistos.unshift(...p.items.map((l) => l.pos))
      if (p.atStart) break
      before = p.start
    }
    expect(vistos).toEqual(inicios)
  })

  it('readPositionedTail com primeira janela 0 ainda cresce e termina', { timeout: 3000 }, async () => {
    // Janela 0 × 4 = 0 para sempre: sem um piso, o laço nunca saía.
    const { file, inicios } = gravar(Array.from({ length: 40 }, (_, i) => `linha ${i}`))
    const p = await readPositionedTail(file, (ls: PositionedLine[]) => ls, { minItems: 30, firstChunkBytes: 0 })
    expect(p.items.length).toBeGreaterThanOrEqual(30)
    expect(p.items.at(-1)?.pos).toBe(inicios.at(-1))
  })

  it('UTF-8 multibyte na borda da janela não vira lixo', async () => {
    const linhas = ['ação rápida ✓', '🎉 festa — já', 'coração ❤️ 漢字', 'fim ñ']
    const { file } = gravar(linhas)
    const tamanho = linhas.reduce((n, l) => n + Buffer.byteLength(l + '\n'), 0)
    // Toda combinação de fim e tamanho de janela: bordas caem no meio de caracteres.
    for (let before = 1; before <= tamanho; before++) {
      for (let max = 1; max <= 24; max++) {
        const r = await readLinesBefore(file, before, max)
        for (const l of r.lines) {
          expect(l.text).not.toContain('�')
          expect(linhas).toContain(l.text)
        }
      }
    }
  })

  it('arquivo que não existe → vazio e no começo, sem lançar', async () => {
    expect(await readLinesBefore('/nao/existe.jsonl', undefined, 1024)).toEqual({ lines: [], start: 0, atStart: true })
  })

  /** Erro de leitura não é "chegou ao começo": quem pagina ou busca pararia ali,
   *  e tudo antes ficaria inalcançável sem aviso. */
  it('erro de leitura que não é arquivo ausente propaga, em vez de virar atStart', async () => {
    const dir = novoDir('page-erro-') // abrir um diretório funciona; ler dá EISDIR
    await expect(readLinesBefore(dir, 10, 1024)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(readPositionedTail(dir, (ls: PositionedLine[]) => ls, { before: 10, minItems: 1 }))
      .rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('readHistoryPage por engine', () => {
  it('Claude: readHistoryPage dá pos de cada evento e o mesmo conteúdo do readHistory', async () => {
    const cfg = novoDir('page-claude-')
    process.env.CLAUDE_CONFIG_DIR = cfg
    const projeto = '/home/eu/proj'
    const dir = join(cfg, 'projects', '-home-eu-proj')
    mkdirSync(dir, { recursive: true })
    const id = '11111111-2222-3333-4444-555555555555'
    const linhas = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'olá, tudo bem?' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tudo ótimo' }] } },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1234 } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'e agora?' }] } },
    ].map((l) => JSON.stringify(l))
    const { inicios } = gravar(linhas, dir)
    // O gravar() usa dados.jsonl; o transcript precisa do id no nome.
    writeFileSync(join(dir, `${id}.jsonl`), linhas.map((l) => l + '\n').join(''))

    const page = await claudeEngine.readHistoryPage!(projeto, id, { minItems: 300 })
    expect(page.atStart).toBe(true)
    expect(page.events.map((e) => e.pos)).toEqual(inicios)
    expect(semPos(page.events)).toEqual(await claudeEngine.readHistory(projeto, id))

    // Página anterior a partir do 3º evento: só os dois primeiros.
    const antes = await claudeEngine.readHistoryPage!(projeto, id, { before: inicios[2], minItems: 300 })
    expect(antes.events.map((e) => e.pos)).toEqual(inicios.slice(0, 2))
  })

  it('Claude: transcript que não existe → página vazia no começo', async () => {
    process.env.CLAUDE_CONFIG_DIR = novoDir('page-claude-')
    expect(await claudeEngine.readHistoryPage!('/x', 'nao-existe', { minItems: 10 }))
      .toEqual({ events: [], start: 0, atStart: true })
  })

  it('Codex: compact_boundary mantém pre_tokens dentro da janela', async () => {
    const home = novoDir('page-codex-')
    process.env.CODEX_HOME = home
    const threadId = '019a0000-0000-7000-8000-00000000abcd'
    const dir = join(home, 'sessions', '2026', '11', '20')
    mkdirSync(dir, { recursive: true })
    const linhas = [
      { type: 'session_meta', payload: { id: threadId, cwd: '/p' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'faz' }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 98765 } } } },
      { type: 'compacted', payload: { message: 'resumo' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'feito' }] } },
    ].map((l) => JSON.stringify(l))
    const file = join(dir, `rollout-2026-11-20T00-00-00-${threadId}.jsonl`)
    writeFileSync(file, linhas.map((l) => l + '\n').join(''))
    const inicios: number[] = []
    linhas.reduce((pos, l) => { inicios.push(pos); return pos + Buffer.byteLength(l + '\n') }, 0)

    const page = await codexEngine.readHistoryPage!('/p', threadId, { minItems: 300 })
    expect(page.atStart).toBe(true)
    expect(page.events.map((e) => e.pos)).toEqual([inicios[1], inicios[3], inicios[4]])
    const boundary = page.events[1] as any
    expect(boundary).toMatchObject({ kind: 'system', subtype: 'compact_boundary' })
    expect(boundary.raw.compact_metadata.pre_tokens).toBe(98765)
    expect(semPos(page.events)).toEqual(await codexEngine.readHistory('/p', threadId))
  })

  it('Codex: a segunda página não varre ~/.codex/sessions de novo', async () => {
    const home = novoDir('page-codex-cache-')
    process.env.CODEX_HOME = home
    const threadId = '019a0000-0000-7000-8000-00000000cafe'
    const dir = join(home, 'sessions', '2026', '11', '20')
    mkdirSync(dir, { recursive: true })
    const linhas = Array.from({ length: 20 }, (_, i) => JSON.stringify(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `m${i}` }] } }))
    const file = join(dir, `rollout-2026-11-20T00-00-00-${threadId}.jsonl`)
    writeFileSync(file, linhas.map((l) => l + '\n').join(''))

    const varreduras = vi.mocked(readdirSync)
    varreduras.mockClear()
    const p1 = await codexEngine.readHistoryPage!('/p', threadId, { minItems: 2, firstChunkBytes: 200 })
    const depoisDaPrimeira = varreduras.mock.calls.length
    expect(depoisDaPrimeira).toBeGreaterThan(0)
    expect(p1.atStart).toBe(false)
    const p2 = await codexEngine.readHistoryPage!('/p', threadId, { before: p1.start, minItems: 2, firstChunkBytes: 200 })
    expect(varreduras.mock.calls.length, 'a segunda página varreu a árvore de novo').toBe(depoisDaPrimeira)
    expect(p2.events.length).toBeGreaterThan(0)
    expect(Math.max(...p2.events.map((e) => e.pos))).toBeLessThan(p1.start)

    // O caminho guardado sumiu (arquivo movido): volta a varrer e acha o novo.
    const outro = join(home, 'sessions', '2026', '11', '21')
    mkdirSync(outro, { recursive: true })
    const novo = join(outro, `rollout-2026-11-21T00-00-00-${threadId}.jsonl`)
    writeFileSync(novo, linhas.slice(0, 2).map((l) => l + '\n').join(''))
    rmSync(file)
    const p3 = await codexEngine.readHistoryPage!('/p', threadId, { minItems: 300 })
    expect(p3.atStart).toBe(true)
    expect(p3.events).toHaveLength(2)
  })

  it('Kimi: turn.prompt vira evento com pos', async () => {
    process.env.CLAUDINEI_KIMI_HOMES = novoDir('page-kimi-')
    const proj = '/tmp/proj-page-kimi'
    const home = kimiHomeFor(proj)
    const sessionId = 'session_page'
    const sdir = join(home, 'sessions', 'wd', sessionId)
    mkdirSync(join(sdir, 'agents', 'main'), { recursive: true })
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir: sdir, workDir: proj }) + '\n')
    const linhas = [
      { type: 'turn.prompt', origin: { kind: 'user' }, input: [{ type: 'text', text: 'oi kimi' }] },
      { type: 'context.append_message', message: { role: 'user', content: 'oi kimi <system-reminder>' } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'oi!' } } },
    ].map((l) => JSON.stringify(l))
    writeFileSync(join(sdir, 'agents', 'main', 'wire.jsonl'), linhas.map((l) => l + '\n').join(''))
    const inicios: number[] = []
    linhas.reduce((pos, l) => { inicios.push(pos); return pos + Buffer.byteLength(l + '\n') }, 0)

    const page = await kimiEngine.readHistoryPage!(proj, sessionId, { minItems: 300 })
    expect(page.atStart).toBe(true)
    expect(page.events.map((e) => e.pos)).toEqual([inicios[0], inicios[2]])
    expect(page.events[0]).toMatchObject({ kind: 'user', message: { content: [{ type: 'text', text: 'oi kimi' }] } })
    expect(semPos(page.events)).toEqual(await kimiEngine.readHistory(proj, sessionId))
  })
})

describe('readPage', () => {
  it('OpenCode sem readHistoryPage: readPage numera por índice e atStart true', async () => {
    const eventos: AgentEvent[] = [
      { kind: 'user', message: { role: 'user', content: [{ type: 'text', text: 'um' }] } as never, raw: {} },
      { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'dois' }] } as never, raw: {} },
      { kind: 'user', message: { role: 'user', content: [{ type: 'text', text: 'três' }] } as never, raw: {} },
    ]
    const falsa = { id: 'opencode', readHistory: async () => eventos } as unknown as Engine
    const page = await readPage(falsa, '/p', 'ses', { minItems: 300 })
    expect(page.events.map((e) => e.pos)).toEqual([0, 1, 2])
    expect(semPos(page.events)).toEqual(eventos)
    expect(page.start).toBe(0)
    expect(page.atStart).toBe(true)
    // `before` corta pelo índice sintético, como corta pelo byte nas outras.
    const antes = await readPage(falsa, '/p', 'ses', { before: 2, minItems: 300 })
    expect(antes.events.map((e) => e.pos)).toEqual([0, 1])
  })

  it('engine com readHistoryPage: readPage delega', async () => {
    const page = { events: [], start: 42, atStart: false }
    const falsa = { id: 'x', readHistory: async () => [], readHistoryPage: async () => page } as unknown as Engine
    expect(await readPage(falsa, '/p', 'id', { minItems: 1 })).toBe(page)
  })
})
