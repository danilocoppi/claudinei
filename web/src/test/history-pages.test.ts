import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { applyEvent } from '../chat/applyEvent'
import { itemsEqual, reconcileByKey, reducePage } from '../chat/reconcile'
import { useStore } from '../store'
import { fetchHistory } from '../api'
import type { ChatItem, ClaudeEvent } from '../types'

/**
 * Chaves estáveis por posição (byte da linha no arquivo da engine), refetch do
 * fim do turno sem reconstruir a lista e páginas antigas acrescentadas no topo.
 */

const assistant = (content: object[], pos?: number, raw: unknown = {}): ClaudeEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content }, raw, ...(pos !== undefined ? { pos } : {}) }) as ClaudeEvent
const user = (content: object[] | string, pos?: number, raw: unknown = {}): ClaudeEvent =>
  ({ kind: 'user', message: { role: 'user', content }, raw, ...(pos !== undefined ? { pos } : {}) }) as ClaudeEvent
const texto = (text: string, pos?: number) => assistant([{ type: 'text', text }], pos)
const pedido = (text: string, pos?: number) => user([{ type: 'text', text }], pos)
const chamada = (id: string, pos?: number) => assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: `ls ${id}` } }], pos)
const resultado = (id: string, result: string, pos?: number) =>
  user([{ type: 'tool_result', tool_use_id: id, content: result }], pos)
const page = (events: ClaudeEvent[], before: number, atStart = false) => ({ events, before, atStart })
const keys = (items: ChatItem[]) => items.map((it) => it.key)

beforeEach(() => {
  useStore.setState({ chat: {}, historyCursor: {}, orphanResults: {}, historyLoadedFor: {}, sessions: {}, unread: {}, streaming: {} })
})

describe('chaves estáveis', () => {
  it('applyEvent dá p<pos> e p<pos>.1 a um evento com texto e tool_use', () => {
    const items = applyEvent([], assistant([
      { type: 'text', text: 'vou listar' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ], 120))
    expect(keys(items)).toEqual(['p120', 'p120.1'])
  })

  it('evento ao vivo ganha l<n> e o tool_result mantém a chave do tool_call', () => {
    let items = applyEvent([], chamada('t1'))
    items = applyEvent(items, texto('enquanto isso'))
    const [k1, k2] = keys(items)
    expect(k1).toMatch(/^l\d+$/)
    expect(k2).toMatch(/^l\d+$/)
    expect(k1).not.toBe(k2)
    items = applyEvent(items, resultado('t1', 'arquivos'))
    expect(items[0]).toMatchObject({ kind: 'tool_call', id: 't1', result: 'arquivos', key: k1 })
  })

  it('o tool_result copia só o item da chamada (os outros mantêm a identidade)', () => {
    const before = applyEvent(applyEvent([], chamada('t1', 10)), texto('depois', 20))
    const after = applyEvent(before, resultado('t1', 'ok', 30))
    expect(after[1]).toBe(before[1])
    expect(after[0]).not.toBe(before[0])
    expect(after[0].key).toBe('p10')
  })

  it('R3: a contagem é por pos, inclusive entre eventos distintos com a mesma pos, sem colisão', () => {
    // Codex: uma linha pode virar mais de um evento — todos com a mesma pos.
    const { items } = reducePage([
      pedido('oi', 0),
      assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 50),
      assistant([{ type: 'text', text: 'c' }], 50),
      assistant([{ type: 'thinking', thinking: 'hmm' }], 50),
      texto('d', 90),
    ])
    expect(keys(items)).toEqual(['p0', 'p50', 'p50.1', 'p50.2', 'p50.3', 'p90'])
    expect(new Set(keys(items)).size).toBe(items.length)
  })

  it('addLocalUserText usa a chave l<n>', () => {
    useStore.getState().addLocalUserText('a', 'pedido')
    expect(useStore.getState().chat.a[0].key).toMatch(/^l\d+$/)
  })
})

describe('reconcileByKey', () => {
  it('reconcileByKey reaproveita o mesmo objeto quando nada mudou', () => {
    const prev = reducePage([pedido('oi', 0), chamada('t1', 10), resultado('t1', 'ok', 20), texto('fim', 30)]).items
    const next = reducePage([pedido('oi', 0), chamada('t1', 10), resultado('t1', 'ok', 20), texto('fim', 30)]).items
    const { items, renamed } = reconcileByKey(prev, next)
    items.forEach((it, i) => expect(it).toBe(prev[i]))
    expect(renamed).toEqual({})
  })

  it('item com a mesma chave e conteúdo diferente vem do novo', () => {
    const prev = reducePage([chamada('t1', 10)]).items
    const next = reducePage([chamada('t1', 10), resultado('t1', 'ok', 20)]).items
    const { items } = reconcileByKey(prev, next)
    expect(items[0]).toBe(next[0])
    expect(items[0]).toMatchObject({ result: 'ok' })
  })

  it('itemsEqual compara campo a campo (e o input da ferramenta por valor)', () => {
    expect(itemsEqual({ kind: 'user_text', text: 'a', key: 'p1' }, { kind: 'user_text', text: 'a', key: 'p1' })).toBe(true)
    expect(itemsEqual({ kind: 'user_text', text: 'a', key: 'p1' }, { kind: 'user_text', text: 'a', key: 'p1', fromEngine: true })).toBe(false)
    expect(itemsEqual(
      { kind: 'tool_call', id: 't', name: 'Bash', input: { command: 'ls', n: [1, 2] }, key: 'p1' },
      { kind: 'tool_call', id: 't', name: 'Bash', input: { command: 'ls', n: [1, 2] }, key: 'p1' },
    )).toBe(true)
    expect(itemsEqual(
      { kind: 'tool_call', id: 't', name: 'Bash', input: { command: 'ls' }, key: 'p1' },
      { kind: 'tool_call', id: 't', name: 'Bash', input: { command: 'pwd' }, key: 'p1' },
    )).toBe(false)
  })

  it('itens ao vivo do fim casam com os confirmados por kind+texto e entram em renamed', () => {
    let prev = reducePage([pedido('oi', 0), texto('olá', 10)]).items
    prev = applyEvent(prev, pedido('Base directory for this skill: /x'))
    prev = applyEvent(prev, chamada('t9'))
    prev = applyEvent(prev, texto('pronto'))
    const [, , lSkill, lCall, lFim] = prev
    const next = reducePage([
      pedido('oi', 0), texto('olá', 10),
      user([{ type: 'text', text: 'Base directory for this skill: /x' }], 20, { isMeta: true }),
      chamada('t9', 30), resultado('t9', 'feito', 40), texto('pronto', 50),
    ]).items
    const { items, renamed } = reconcileByKey(prev, next)
    expect(renamed).toEqual({ [lSkill.key!]: 'p20', [lCall.key!]: 'p30', [lFim.key!]: 'p50' })
    expect(keys(items)).toEqual(['p0', 'p10', 'p20', 'p30', 'p50'])
    // A flag que o ao vivo não sabia (era o retag do mergeEngineFlags) vem do transcript.
    expect(items[2]).toMatchObject({ kind: 'user_text', fromEngine: true })
    expect(items[3]).toMatchObject({ result: 'feito' })
    expect(items[0]).toBe(prev[0])
  })
})

describe('setHistoryTail / prependHistory', () => {
  const tail1 = page([pedido('p-100', 100), chamada('t1', 110), resultado('t1', 'r1', 120), texto('a-130', 130)], 100)
  const older = page([pedido('p-0', 0), texto('a-40', 40), texto('a-80', 80)], 0, true)

  it('primeira carga define o cursor', () => {
    useStore.getState().setHistoryTail('s', tail1)
    expect(keys(useStore.getState().chat.s)).toEqual(['p100', 'p110', 'p130'])
    expect(useStore.getState().historyCursor.s).toEqual({ before: 100, atStart: false })
  })

  it('refetch do fim mantém as páginas antigas carregadas', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().prependHistory('s', older)
    const antes = st().chat.s
    expect(keys(antes)).toEqual(['p0', 'p40', 'p80', 'p100', 'p110', 'p130'])
    expect(st().historyCursor.s).toEqual({ before: 0, atStart: true })
    // turno ao vivo
    st().addLocalUserText('s', 'p-140')
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('a-150') })
    // refetch do fim: só a cauda, começando no meio do que já estava carregado
    st().setHistoryTail('s', page([chamada('t1', 110), resultado('t1', 'r1', 120), texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150)], 110))
    const depois = st().chat.s
    expect(keys(depois)).toEqual(['p0', 'p40', 'p80', 'p100', 'p110', 'p130', 'p140', 'p150'])
    // nada reconstruído: os antigos são os MESMOS objetos
    for (let i = 0; i < 6; i++) expect(depois[i]).toBe(antes[i])
    // e o cursor continua no começo da conversa
    expect(st().historyCursor.s).toEqual({ before: 0, atStart: true })
  })

  it('sessão longa: o ao vivo ganha as flags que só o transcript tem (era o mergeEngineFlags)', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().prependHistory('s', older)
    // ao vivo, sem as marcas: a skill injetada parece do operador; o erro da API não tem o prefixo
    st().applyWsMessage({ type: 'session_event', localId: 's', event: pedido('Base directory for this skill: /x') })
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('Request failed') })
    st().setHistoryTail('s', page([
      texto('a-130', 130),
      user([{ type: 'text', text: 'Base directory for this skill: /x' }], 140, { isMeta: true }),
      assistant([{ type: 'text', text: 'Request failed' }], 150, { isApiErrorMessage: true }),
    ], 130))
    const chat = st().chat.s
    expect(keys(chat)).toEqual(['p0', 'p40', 'p80', 'p100', 'p110', 'p130', 'p140', 'p150'])
    expect(chat[6]).toMatchObject({ kind: 'user_text', fromEngine: true })
    expect(chat[7]).toMatchObject({ kind: 'assistant_text', isApiError: true })
  })

  it('refetch sem interseção substitui tudo e reinicia o cursor (sem buraco)', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().prependHistory('s', older)
    st().setHistoryTail('s', page([texto('a-900', 900), texto('a-950', 950)], 900))
    expect(keys(st().chat.s)).toEqual(['p900', 'p950'])
    expect(st().historyCursor.s).toEqual({ before: 900, atStart: false })
  })

  it('mesma chave com outro conteúdo (outra conversa) não conta como interseção', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', page([pedido('velho', 0), texto('velho-50', 50)], 0, true))
    st().setHistoryTail('s', page([texto('novo-50', 50), texto('novo-90', 90)], 50))
    expect(st().chat.s.map((it) => (it as { text: string }).text)).toEqual(['novo-50', 'novo-90'])
    expect(st().historyCursor.s).toEqual({ before: 50, atStart: false })
  })

  it('a mensagem otimista que o transcript ainda não gravou sobrevive ao refetch', () => {
    const st = () => useStore.getState()
    st().addLocalUserText('s', 'primeira mensagem')
    st().setHistoryTail('s', page([], 0, true))
    expect(st().chat.s).toMatchObject([{ kind: 'user_text', text: 'primeira mensagem' }])
  })

  it('item ao vivo superado (antes do último confirmado) não fica duplicado', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().addLocalUserText('s', 'texto que o motor reescreveu')
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('resposta') })
    st().setHistoryTail('s', page([texto('a-130', 130), pedido('texto reescrito', 140), texto('resposta', 150)], 130))
    expect(st().chat.s.map((it) => (it as { text?: string }).text)).toEqual(['p-100', undefined, 'a-130', 'texto reescrito', 'resposta'])
  })

  it('prependHistory não duplica chaves', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    // página antiga que se sobrepõe ao que já está carregado
    st().prependHistory('s', page([texto('a-80', 80), pedido('p-100', 100), chamada('t1', 110)], 80))
    const ks = keys(st().chat.s)
    expect(ks).toEqual(['p80', 'p100', 'p110', 'p130'])
    expect(new Set(ks).size).toBe(ks.length)
  })

  it('página antiga com o tool_use preenche o resultado que chegou antes, órfão', () => {
    const st = () => useStore.getState()
    // a cauda começa com o resultado; a chamada ficou na página anterior
    st().setHistoryTail('s', page([resultado('t0', 'saída de t0', 100), texto('a-110', 110)], 100))
    expect(keys(st().chat.s)).toEqual(['p110'])
    st().prependHistory('s', page([pedido('p-0', 0), chamada('t0', 50)], 0, true))
    expect(st().chat.s[1]).toMatchObject({ kind: 'tool_call', id: 't0', result: 'saída de t0', isError: false, key: 'p50' })
  })

  it('refetch atualiza a chamada que ganhou resultado depois da 1ª carga', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', page([pedido('p-0', 0), chamada('t0', 50)], 0, true))
    const antigo = st().chat.s[0]
    st().setHistoryTail('s', page([chamada('t0', 50), resultado('t0', 'chegou', 60), texto('fim', 70)], 50))
    expect(st().chat.s[1]).toMatchObject({ kind: 'tool_call', id: 't0', result: 'chegou' })
    expect(st().chat.s[0]).toBe(antigo)
  })

  it('órfão cuja chamada está no prefixo preenche o prefixo', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', page([pedido('p-0', 0), chamada('t3', 50), texto('a-60', 60)], 0, true))
    const antigo = st().chat.s[0]
    st().setHistoryTail('s', page([texto('a-60', 60), resultado('t3', 'veio depois', 70), texto('fim', 80)], 60))
    expect(st().chat.s[1]).toMatchObject({ kind: 'tool_call', id: 't3', result: 'veio depois', key: 'p50' })
    expect(st().chat.s[0]).toBe(antigo)
  })

  it('reduce de 5000 eventos com tool_result fica abaixo de 200 ms', () => {
    const events: ClaudeEvent[] = []
    for (let i = 0; i < 2500; i++) {
      events.push(chamada(`t${i}`, i * 20))
      events.push(resultado(`t${i}`, `saída ${i}`, i * 20 + 10))
    }
    const t0 = performance.now()
    const { items } = reducePage(events)
    const ms = performance.now() - t0
    expect(items).toHaveLength(2500)
    expect(items[0]).toMatchObject({ result: 'saída 0' })
    expect(ms, `reduce levou ${ms.toFixed(0)} ms`).toBeLessThan(200)
  })
  /** O orçamento de 5000 é folgado; com 20000 o `map` por resultado (quadrático) estoura com sobra. */
  it('reduce de 20000 eventos com tool_result continua linear (abaixo de 200 ms)', () => {
    const events: ClaudeEvent[] = []
    for (let i = 0; i < 10000; i++) {
      events.push(chamada(`t${i}`, i * 20))
      events.push(resultado(`t${i}`, `saída ${i}`, i * 20 + 10))
    }
    const t0 = performance.now()
    const { items } = reducePage(events)
    const ms = performance.now() - t0
    expect(items).toHaveLength(10000)
    expect(ms, `reduce levou ${ms.toFixed(0)} ms`).toBeLessThan(200)
  })
})

describe('fetchHistory', () => {
  afterEach(() => vi.restoreAllMocks())
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('sem cursor pede o fim; com cursor pede a página anterior', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(ok({ events: [], before: 0, atStart: true })))
    await expect(fetchHistory('a')).resolves.toEqual({ events: [], before: 0, atStart: true })
    expect(spy.mock.calls[0][0]).toBe('/api/sessions/a/history')
    await fetchHistory('a', 1234, 200)
    expect(spy.mock.calls[1][0]).toBe('/api/sessions/a/history?before=1234&limit=200')
  })
})
