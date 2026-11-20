import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { normalizeForSearch, searchableTexts, searchEvents, SEARCH_SLICE_BYTES } from '../src/history-search.js'
import type { PositionedEvent } from '../src/history-page.js'
import type { AgentEvent } from '../src/engine/types.js'

/**
 * Busca na conversa, no servidor: lê uma fatia de 8 MB por pedido, de trás para
 * a frente, e devolve as ocorrências com o byte da linha de cada uma. Só conta o
 * que a tela mostra; ferramentas e raciocínio só com `tools=1`.
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

// ── eventos sintéticos ──────────────────────────────────────────────────────
const assistente = (content: unknown[], raw: Record<string, unknown> = {}): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content: content as never }, raw })
const usuario = (content: unknown, extra: Partial<{ fromEngine: boolean }> = {}, raw: Record<string, unknown> = {}): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content: content as never }, raw, ...extra })
const comPos = (evts: AgentEvent[], passo = 100): PositionedEvent[] => evts.map((e, i) => ({ ...e, pos: i * passo }))

describe('normalizeForSearch', () => {
  it('normalizeForSearch iguala acento e caixa', () => {
    expect(normalizeForSearch('Reinício')).toBe(normalizeForSearch('reinicio'))
    expect(normalizeForSearch('AÇÃO Única')).toBe('acao unica')
    // Sigma final e medial viram a mesma letra: o texto e a consulta casam
    // independentemente de onde a palavra termina.
    expect(normalizeForSearch('ΟΔΟΣ')).toBe(normalizeForSearch('οδοσ'))
  })
})

describe('searchableTexts', () => {
  it('busca padrão ignora ferramentas, raciocínio e fromEngine; com tools=1 acha neles', () => {
    const fala = assistente([
      { type: 'thinking', thinking: 'pensando no deploy' },
      { type: 'text', text: 'Vou fazer o deploy' },
      { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'deploy.sh' } },
    ])
    const resultado = usuario([{ type: 'tool_result', tool_use_id: 'tu-1', content: 'deploy ok' }])
    const injetado = usuario('instrução de deploy da engine', { fromEngine: true })
    const meta = usuario([{ type: 'text', text: 'skill de deploy' }], {}, { isMeta: true })

    expect(searchableTexts(fala, false)).toEqual([{ field: 'text', text: 'Vou fazer o deploy' }])
    expect(searchableTexts(resultado, false)).toEqual([])
    expect(searchableTexts(injetado, false)).toEqual([])
    expect(searchableTexts(meta, false)).toEqual([])

    expect(searchableTexts(fala, true)).toEqual([
      { field: 'thinking', text: 'pensando no deploy' },
      { field: 'text', text: 'Vou fazer o deploy' },
      { field: 'tool_input', text: JSON.stringify({ command: 'deploy.sh' }), toolUseId: 'tu-1' },
    ])
    expect(searchableTexts(resultado, true)).toEqual([{ field: 'tool_output', text: 'deploy ok', toolUseId: 'tu-1' }])
    // Injeção da engine nunca conta, nem com ferramentas.
    expect(searchableTexts(injetado, true)).toEqual([])
    expect(searchableTexts(meta, true)).toEqual([])

    const evts = comPos([fala, resultado, injetado, meta])
    expect(searchEvents(evts, 'deploy', false).map((h) => h.field)).toEqual(['text'])
    expect(searchEvents(evts, 'deploy', true).map((h) => h.field).sort())
      .toEqual(['text', 'thinking', 'tool_input', 'tool_output'])
  })

  it('cartão de tarefa e resumo da compactação contam como texto', () => {
    const tarefa = usuario('[Task from Outro Projeto]: revisar o reinício')
    const agendamento = usuario([{ type: 'text', text: '[Agendamento: diário #3]: revisar o reinício' }])
    const claudinei = usuario('[Claudinei: resume after restart]: continue o reinicio')
    // O resumo vem marcado pela engine, mas a tela mostra — conta.
    const resumo = usuario('This session is being continued from a previous conversation. Falamos do reinício.', {}, { isCompactSummary: true })
    for (const e of [tarefa, agendamento, claudinei, resumo]) {
      const t = searchableTexts(e, false)
      expect(t).toHaveLength(1)
      expect(t[0].field).toBe('text')
    }
    expect(searchEvents(comPos([tarefa, agendamento, claudinei, resumo]), 'reinicio', false)).toHaveLength(4)
  })

  it('o que a tela esconde da mensagem do usuário não conta', () => {
    const lembrete = usuario('pergunta real<system-reminder>segredo do harness</system-reminder>')
    expect(searchableTexts(lembrete, false)).toEqual([{ field: 'text', text: 'pergunta real' }])
    expect(searchableTexts(usuario('<local-command-caveat>ruído</local-command-caveat>'), false)).toEqual([])
  })

  it('hit de tool_result traz toolUseId', () => {
    const evts = comPos([
      assistente([{ type: 'tool_use', id: 'tu-9', name: 'Read', input: { file_path: '/x' } }]),
      usuario([{ type: 'tool_result', tool_use_id: 'tu-9', content: [{ type: 'text', text: 'linha com AGULHA aqui' }] }]),
    ])
    const hits = searchEvents(evts, 'agulha', true)
    expect(hits).toEqual([{ pos: 100, toolUseId: 'tu-9', field: 'tool_output', snippet: 'linha com AGULHA aqui' }])
  })
})

describe('searchEvents', () => {
  it('da mais nova para a mais antiga, uma por ocorrência', () => {
    const evts = comPos([
      assistente([{ type: 'text', text: 'alfa um' }]),
      usuario('beta alfa, depois alfa de novo'),
      assistente([{ type: 'text', text: 'alfa três' }]),
    ])
    const hits = searchEvents(evts, 'ALFA', false)
    expect(hits.map((h) => h.pos)).toEqual([200, 100, 100, 0])
    // Dentro da mesma mensagem, também de baixo para cima.
    expect(hits[1].snippet).toBe('beta alfa, depois alfa de novo')
  })

  it('snippet de até 120 caracteres em volta da ocorrência, no texto original', () => {
    const texto = 'x'.repeat(300) + ' Reinício ' + 'y'.repeat(300)
    const [hit] = searchEvents(comPos([assistente([{ type: 'text', text: texto }])]), 'reinicio', false)
    expect(hit.snippet.length).toBeLessThanOrEqual(120)
    expect(hit.snippet).toContain('Reinício')
    // Em volta: sobra contexto dos dois lados.
    expect(hit.snippet.startsWith('x')).toBe(true)
    expect(hit.snippet.endsWith('y')).toBe(true)
  })

  it('o trecho vem do original em texto acentuado longo, e cada ocorrência leva o seu', () => {
    // Texto não-ASCII grande: as ocorrências caem em pedaços diferentes do
    // texto dobrado, inclusive em cima da emenda entre dois pedaços.
    const partes: string[] = []
    for (let i = 0; i < 60; i++) partes.push('ação concluída '.repeat(7 + (i % 5)) + `Reinício-${i} `)
    let texto = partes.join('')
    // Uma ocorrência atravessando o índice 1024.
    texto = 'ç'.repeat(1020) + 'REINÍCIO-X ' + texto
    const hits = searchEvents(comPos([assistente([{ type: 'text', text: texto }])]), 'reinicio', false)
    expect(hits).toHaveLength(61)
    // De baixo para cima: a última do texto primeiro.
    hits.slice(0, 60).forEach((h, k) => expect(h.snippet).toContain(`Reinício-${59 - k}`))
    expect(hits[60].snippet).toContain('REINÍCIO-X')
    for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(120)
  })

  it('texto decomposto: acha e o trecho não separa a letra das marcas', () => {
    const texto = ('palavra qualquer ' + 'reinício '.normalize('NFD')).repeat(30)
    const hits = searchEvents(comPos([assistente([{ type: 'text', text: texto }])]), 'Reinício', false)
    expect(hits).toHaveLength(30)
    for (const h of hits) {
      expect(h.snippet).toContain('reinício'.normalize('NFD'))
      // Nem começa com marca órfã nem termina numa letra cujas marcas ficaram de fora.
      expect(h.snippet).not.toMatch(/^\p{M}/u)
      const fim = texto.indexOf(h.snippet.slice(-12))
      expect(texto.slice(fim + 12).match(/^\p{M}/u)).toBeNull()
    }
  })

  it('consulta com caracteres especiais de regex é literal', () => {
    const evts = comPos([assistente([{ type: 'text', text: 'rode c++ (a-b) [x] ação/feita $1 ^z' }])])
    for (const q of ['c++', '(a-b)', '[x]', 'ação/feita', '$1', '^z']) {
      expect(searchEvents(evts, q, false), q).toHaveLength(1)
    }
    expect(searchEvents(evts, 'a.b', false)).toHaveLength(0)
  })

  it('não pesa no laço de eventos: 8 MB acentuados com uma ocorrência em menos de 500 ms', () => {
    const unidade = 'Teste ✓ passou em função da configuração; ação concluída com êxito. '
    let grande = ''
    while (grande.length < 8 * 1024 * 1024) grande += unidade
    grande = grande.slice(0, 4 * 1024 * 1024) + ' agulha ' + grande.slice(4 * 1024 * 1024)
    const evts = comPos([usuario([{ type: 'tool_result', tool_use_id: 'tu-1', content: grande }])])
    searchEvents(comPos([assistente([{ type: 'text', text: 'aquecimento ção' }])]), 'ção', true)
    const t0 = performance.now()
    const hits = searchEvents(evts, 'agulha', true)
    const dt = performance.now() - t0
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('agulha')
    // Medido ~105 ms (o mapa código a código de antes custava ~850 ms); a folga
    // de ~5× cobre máquina carregada sem deixar passar a volta do custo antigo.
    expect(dt).toBeLessThan(500)
  })

  // Quase-acertos: a consulta casa quase toda em quase todo lugar e só falha
  // no fim. Com o padrão que pulava marcas entre as letras, isso custava
  // O(texto × consulta): 3 a 7 s numa fatia de 8 MB, com o laço parado.
  const quaseAcerto = (unidade: string, q: string) => {
    let grande = ''
    while (grande.length < 8 * 1024 * 1024) grande += unidade
    const evts = comPos([usuario([{ type: 'tool_result', tool_use_id: 'tu-1', content: grande }])])
    const t0 = performance.now()
    const hits = searchEvents(evts, q, true)
    return { hits, dt: performance.now() - t0 }
  }

  it('quase-acerto com acento não trava: "ç"×199+"x" em 8 MB de "ç"', () => {
    const { hits, dt } = quaseAcerto('ç'.repeat(63) + '\n', 'ç'.repeat(199) + 'x')
    expect(hits).toEqual([])
    // Medido ~270 ms depois da correção (antes, ~5,9 s); folga de ~4×.
    expect(dt).toBeLessThan(1100)
  })

  it('quase-acerto com caracteres de desenho não trava: "─"×15+" fim"', () => {
    const { hits, dt } = quaseAcerto('─'.repeat(79) + '\n', '─'.repeat(15) + ' fim')
    expect(hits).toEqual([])
    // Medido ~125 ms depois da correção (antes, ~1,5 s); folga de ~5×.
    expect(dt).toBeLessThan(650)
  })

  it('quase-acerto com texto decomposto também acha quando casa', () => {
    // As marcas somem dos dois lados: "c" + cedilha combinante casa com "ç".
    const texto = 'ç'.normalize('NFD').repeat(500) + 'X fim'
    const hits = searchEvents(comPos([assistente([{ type: 'text', text: texto }])]), 'ç'.repeat(10) + 'x', false)
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('X fim')
    expect(hits[0].snippet).not.toMatch(/^\p{M}/u)
  })

  it('consulta curta demais depois de normalizar não acha nada', () => {
    expect(searchEvents(comPos([assistente([{ type: 'text', text: 'abc' }])]), '  ', false)).toEqual([])
  })
})

// ── rota ────────────────────────────────────────────────────────────────────
describe('rota de busca', () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildApp>>
  let projectId: number
  let transcriptDir: string

  beforeEach(async () => {
    const cfgDir = novoDir('cfg-')
    const projPath = novoDir('tm-')
    transcriptDir = join(cfgDir, 'projects', projPath.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(transcriptDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    db = openDb(':memory:')
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    app = await buildApp({ config: loadConfig({ CLAUDE_CONFIG_DIR: cfgDir }), db, manager: mgr })
    projectId = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P', path: projPath } })).json().id
  })
  afterEach(async () => { await app.close() })

  const sessaoCom = (localId: string, sid: string | null, continueLatest = 0) =>
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest, claude_session_id) VALUES (?, ?, 'stopped', ?, ?)`,
    ).run(localId, projectId, continueLatest, sid)

  const textoLinha = (t: string) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })

  it('fatia devolve before para continuar e atStart no fim', async () => {
    // ~20 MB: agulhas no começo, no meio e no fim; o resto é enchimento.
    const enchimento = textoLinha('palha '.repeat(160))
    const nEnch = Math.ceil((20 * 1024 * 1024) / (enchimento.length + 1))
    const file = join(transcriptDir, 'sid-grande.jsonl')
    const fd = openSync(file, 'w')
    const posDe: Record<string, number> = {}
    let pos = 0
    const escreve = (l: string) => { writeSync(fd, l + '\n'); pos += Buffer.byteLength(l + '\n') }
    const marca = (nome: string) => { posDe[nome] = pos; escreve(textoLinha(`agulha ${nome}`)) }
    marca('inicio')
    const bloco = Array.from({ length: 1000 }, () => enchimento).join('\n') + '\n'
    const blocoBytes = Buffer.byteLength(bloco)
    for (let i = 0; i < nEnch; i += 1000) {
      if (i >= nEnch / 2 && posDe.meio === undefined) marca('meio')
      writeSync(fd, bloco); pos += blocoBytes
    }
    marca('fim')
    closeSync(fd)
    expect(pos).toBeGreaterThan(2 * SEARCH_SLICE_BYTES)
    sessaoCom('s-1', 'sid-grande')

    const achados: number[] = []
    const fatias: Array<{ before: number; atStart: boolean }> = []
    let before: number | undefined
    let atStart = false
    while (!atStart) {
      const url = `/api/sessions/s-1/search?q=agulha${before === undefined ? '' : `&before=${before}`}`
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      achados.push(...body.hits.map((h: { pos: number }) => h.pos))
      fatias.push({ before: body.before, atStart: body.atStart })
      // Cada fatia avança para trás.
      if (before !== undefined) expect(body.before).toBeLessThan(before)
      before = body.before
      atStart = body.atStart
      if (fatias.length > 10) throw new Error('não chegou ao começo')
    }
    expect(fatias).toHaveLength(3)
    expect(fatias.slice(0, 2).every((f) => !f.atStart)).toBe(true)
    expect(before).toBe(0)
    expect(achados).toEqual([posDe.fim, posDe.meio, posDe.inicio])
  })

  it('q inválido, tools inválido e before inválido dão 400', async () => {
    sessaoCom('s-2', 'sid-x')
    for (const q of ['', 'q=a', 'q=%20a%20', `q=${'a'.repeat(201)}`, 'q=ok&tools=2', 'q=ok&tools=sim', 'q=ok&before=-1', 'q=ok&before=1.5', 'q=ok&before=x', 'q=ok&q=de']) {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/s-2/search?${q}` })
      expect(res.statusCode, q).toBe(400)
    }
    // Os limites vão como parâmetros: a tela traduz a mensagem (serverErrors.invalid_query).
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s-2/search?q=a' })).json())
      .toMatchObject({ code: 'invalid_query', params: { min: 2, max: 200 } })
    for (const q of ['q=ok', 'q=ok&tools=0', 'q=ok&tools=1&before=0', `q=${'a'.repeat(200)}`]) {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/s-2/search?${q}` })
      expect(res.statusCode, q).toBe(200)
    }
  })

  it('tools=1 alcança a saída da ferramenta pela rota', async () => {
    writeFileSync(join(transcriptDir, 'sid-ferr.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'arquivo-raro.txt' }] } }),
    ].join('\n') + '\n')
    sessaoCom('s-3', 'sid-ferr')
    const sem = (await app.inject({ method: 'GET', url: '/api/sessions/s-3/search?q=arquivo-raro' })).json()
    expect(sem).toEqual({ hits: [], before: 0, atStart: true })
    const com = (await app.inject({ method: 'GET', url: '/api/sessions/s-3/search?q=arquivo-raro&tools=1' })).json()
    expect(com.hits).toEqual([expect.objectContaining({ field: 'tool_output', toolUseId: 'tu-1' })])
  })

  it('prévia sem engineSessionId busca no arquivo que a prévia mostra', async () => {
    writeFileSync(join(transcriptDir, 'sid-anterior.jsonl'), textoLinha('conversa anterior com Reinício') + '\n')
    sessaoCom('s-4', null, 1)
    const r = (await app.inject({ method: 'GET', url: '/api/sessions/s-4/search?q=reinicio' })).json()
    expect(r.hits).toEqual([expect.objectContaining({ pos: 0, field: 'text' })])
    expect(r.atStart).toBe(true)
    sessaoCom('s-5', null, 0)
    expect((await app.inject({ method: 'GET', url: '/api/sessions/s-5/search?q=reinicio' })).json())
      .toEqual({ hits: [], before: 0, atStart: true })
  })

  it('erro de leitura vira 500, nunca fim da busca', async () => {
    mkdirSync(join(transcriptDir, 'sid-quebrado.jsonl'))
    sessaoCom('s-6', 'sid-quebrado')
    // O Fastify roda sem logger: o erro tem de ir ao console, senão some.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s-6/search?q=qualquer' })
    const chamadas = [...log.mock.calls]
    log.mockRestore()
    expect(chamadas).toContainEqual([expect.stringContaining('s-6'), expect.objectContaining({ code: 'EISDIR' })])
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('history_read_failed')
  })

  it('sessão inexistente: 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nada/search?q=ok' })).statusCode).toBe(404)
  })
})

describe('controle de acesso da busca', () => {
  it('sem acesso ao projeto, 403', async () => {
    const db = openDb(':memory:')
    const auth = createAuthService({ db })
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
    const app = await buildApp({ config: loadConfig({}), db, manager, auth, usage: { getLimits: async () => [] } })
    const projects = createProjectsService(db)
    const p1 = projects.create({ name: 'Alfa', path: novoDir('p1-') })
    const p2 = projects.create({ name: 'Beta', path: novoDir('p2-') })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
    const cookieOf = (res: any): Record<string, string> => {
      const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
      return c ? { [COOKIE_NAME]: c.value } : {}
    }
    const login = async (username: string) =>
      cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))
    const anaCookie = await login('ana')
    const adminCookie = await login('root')
    db.prepare(`INSERT INTO sessions (local_id, project_id, status) VALUES ('alheia', ?, 'stopped')`).run(p2.id)
    db.prepare(`INSERT INTO sessions (local_id, project_id, status) VALUES ('dela', ?, 'stopped')`).run(p1.id)

    const alheia = await app.inject({ method: 'GET', url: '/api/sessions/alheia/search?q=ok', cookies: anaCookie })
    expect(alheia.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/sessions/dela/search?q=ok', cookies: anaCookie })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/sessions/alheia/search?q=ok', cookies: adminCookie })).statusCode).toBe(200)
    // Sem login nenhum, nem chega à rota.
    expect((await app.inject({ method: 'GET', url: '/api/sessions/dela/search?q=ok' })).statusCode).toBe(401)
    await app.close()
  })
})
