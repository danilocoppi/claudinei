import { describe, it, expect } from 'vitest'
import { pageIdOfToolCall, placePages } from '../pages/anchors'
import { turnKey, type TurnDto } from '../../../shared/undo'
import type { VisualPageDto } from '../../../shared/visual-pages'
import type { ChatItem } from '../types'

const PG = 'pg_0123456789abcdef'
const PG2 = 'pg_fedcba9876543210'
const PG3 = 'pg_00000000000000aa'

const user = (text: string): ChatItem => ({ kind: 'user_text', text })
const reply = (text: string): ChatItem => ({ kind: 'assistant_text', text })
const call = (name: string, result: string | undefined, over: Partial<Extract<ChatItem, { kind: 'tool_call' }>> = {}): ChatItem =>
  ({ kind: 'tool_call', id: `c${Math.random()}`, name, input: { title: 'Gráfico', html: '<p>x</p>' }, result, ...over })
/** O texto que o `show_page` do hermes devolve (run-hermes.ts). */
const shown = (id: string) => `page shown to the operator (id ${id}, 3 KB)`

const page = (id: string, turnId: number | null, text: string | null, over: Partial<VisualPageDto> = {}): VisualPageDto => ({
  id, projectId: 1, engine: 'codex', localId: 'L', conversationId: 'conv', turnId,
  turnKey: text === null ? null : turnKey(text), title: 'Gráfico', height: null, bytes: 3000, source: 'html',
  createdAt: '2026-11-21 12:00:00', ...over,
})
const turn = (id: number, text: string, over: Partial<TurnDto> = {}): TurnDto => ({
  id, localId: 'L', projectId: 1, engine: 'codex', origin: 'operator', key: turnKey(text), midTurn: false,
  state: 'ok', limited: false, endKind: 'result', summary: null, lastRun: null,
  startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})
/** `at` como [afterIndex, ids] em ordem, para comparar. */
const atOf = (r: ReturnType<typeof placePages>) =>
  [...r.at.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v.map(p => p.id)])

describe('pageIdOfToolCall', () => {
  it('quatro motores: mcp__hermes__show_page (Claude), hermes/show_page com resultado em JSON (Codex), hermes_show_page (OpenCode) e show_page (Kimi) dão o id', () => {
    // Claude: o texto do resultado do MCP.
    expect(pageIdOfToolCall(call('mcp__hermes__show_page', shown(PG)))).toBe(PG)
    // Codex: `mcpToolCall` vira `server/tool` e o resultado é o JSON do CallToolResult (codex-items.ts).
    const codexResult = JSON.stringify({ content: [{ type: 'text', text: shown(PG) }], structuredContent: null })
    expect(pageIdOfToolCall(call('hermes/show_page', codexResult))).toBe(PG)
    // OpenCode: `<servidor>_<ferramenta>`.
    expect(pageIdOfToolCall(call('hermes_show_page', shown(PG)))).toBe(PG)
    // Kimi: o nome cru.
    expect(pageIdOfToolCall(call('show_page', shown(PG)))).toBe(PG)
  })

  it('exec do Codex que imprime pg_… não vira cartão', () => {
    expect(pageIdOfToolCall(call('shell', `ls pages\n${PG}.html`, { input: { command: 'ls pages' } }))).toBeNull()
    // Nome parecido, mas não é o show_page.
    expect(pageIdOfToolCall(call('mcp__hermes__show_pages', shown(PG)))).toBeNull()
    expect(pageIdOfToolCall(call('hermes/reshow_page', shown(PG)))).toBeNull()
    // Item que não é chamada.
    expect(pageIdOfToolCall(reply(shown(PG)))).toBeNull()
  })

  it('show_page com isError ou sem resultado: null', () => {
    expect(pageIdOfToolCall(call('mcp__hermes__show_page', `show_page rejected: ${PG}`, { isError: true }))).toBeNull()
    expect(pageIdOfToolCall(call('mcp__hermes__show_page', undefined))).toBeNull()
    expect(pageIdOfToolCall(call('mcp__hermes__show_page', 'show_page rejected: html too large'))).toBeNull()
  })
})

describe('placePages', () => {
  it('página sem chamada vai ao fim do bloco do turno dela', () => {
    const items = [
      user('faça o gráfico'), call('shell', 'ok'), reply('pronto'),
      user('outra coisa'), reply('feito'),
    ]
    const r = placePages(items, [page(PG, 1, 'faça o gráfico')], undefined, false)
    expect(atOf(r)).toEqual([[2, [PG]]])
    expect(r.shown.size).toBe(0)
  })

  it('duas páginas do mesmo turno: as duas no fim do bloco, na ordem da lista', () => {
    const items = [user('dois gráficos'), reply('pronto'), user('outra')]
    const r = placePages(items, [page(PG, 1, 'dois gráficos'), page(PG2, 1, 'dois gráficos')], undefined, false)
    expect(atOf(r)).toEqual([[1, [PG, PG2]]])
  })

  it('dois turnos "continue" (5 e 9), página só no 5: vai ao bloco do 5', () => {
    const items = [
      user('continue'), reply('fiz a parte 1'),
      user('continue'), reply('fiz a parte 2'),
    ]
    const turns = [turn(5, 'continue'), turn(9, 'continue')]
    const r = placePages(items, [page(PG, 5, 'continue')], turns, false)
    // Com os turnos reais, o 9 fica com o "continue" mais novo e o 5 com o anterior.
    expect(atOf(r)).toEqual([[1, [PG]]])
  })

  it('sem os turnos reais, o pseudo-turno casa pela turn_key', () => {
    const items = [user('faça A'), reply('a'), user('faça B'), reply('b'), user('faça C')]
    const r = placePages(items, [page(PG, 7, 'faça B')], undefined, false)
    expect(atOf(r)).toEqual([[3, [PG]]])
    // Turnos reais carregados sem o da página (ex.: lista vazia ou turno de fora): o pseudo-turno completa.
    expect(atOf(placePages(items, [page(PG, 7, 'faça B')], [], false))).toEqual([[3, [PG]]])
    expect(atOf(placePages(items, [page(PG, 7, 'faça B')], [turn(3, 'faça A')], false))).toEqual([[3, [PG]]])
  })

  it('turn_key nulo, turno que não casou e página de turno antes da página carregada (sem atStart): fora de at', () => {
    // A conversa carregada começa no meio de um turno antigo ("faça o antigo", que ficou na página de cima).
    const items = [reply('resto do turno antigo'), user('faça o novo'), reply('ok')]
    const pages = [
      page(PG, 3, null),                       // turno sem texto (do motor)
      page(PG2, 4, 'algo que o chat não tem'), // não casou
      page(PG3, 2, 'faça o antigo'),           // turno da página antiga, ainda não carregada
    ]
    const r = placePages(items, pages, undefined, false)
    expect(r.at.size).toBe(0)
    expect(r.shown.size).toBe(0)
    // Com os turnos reais também: nenhum casa.
    expect(placePages(items, pages, [turn(2, 'faça o antigo'), turn(4, 'algo que o chat não tem')], false).at.size).toBe(0)
    // Turno sem id (sem turno aberto no servidor): também fora.
    expect(placePages(items, [page(PG, null, null)], undefined, true).at.size).toBe(0)
  })

  it('página com chamada visível fica fora de at e entra em shown', () => {
    const items = [
      user('faça o gráfico'), call('mcp__hermes__show_page', shown(PG)), reply('pronto'),
      // Um exec que imprime outro id não conta como chamada visível.
      call('shell', `echo ${PG2}`),
    ]
    const r = placePages(items, [page(PG, 1, 'faça o gráfico'), page(PG2, 1, 'faça o gráfico')], undefined, false)
    expect([...r.shown]).toEqual([PG])
    expect(atOf(r)).toEqual([[3, [PG2]]])
  })

  it('sem páginas: nada em at, mesmo Map vazio', () => {
    const r = placePages([user('oi')], [], undefined, true)
    expect(r.at.size).toBe(0)
    expect(r.shown.size).toBe(0)
  })
})
