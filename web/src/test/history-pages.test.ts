import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { applyEvent } from '../chat/applyEvent'
import { itemsEqual, reconcileByKey, reducePage } from '../chat/reconcile'
import { useStore } from '../store'
import { fetchHistory } from '../api'
import { loadHistoryTail, TAIL_CATCHUP_PAGES } from '../chat/loadTail'
import type { ChatItem, ClaudeEvent, HistoryPage } from '../types'

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
    st().prependHistory('s', older, 100)
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
    st().prependHistory('s', older, 100)
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

  /** Na tela, o caminho normal é `loadHistoryTail` ler para trás até encostar; isto é o que sobra além do teto. */
  it('cauda sem interseção (além do teto de páginas) substitui e reinicia o cursor, sem buraco', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().prependHistory('s', older, 100)
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

  it('mensagem do operador sem par fica onde estava, mesmo antes do último confirmado', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    st().addLocalUserText('s', 'mensagem que o motor perdeu')
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('resposta') })
    st().setHistoryTail('s', page([texto('a-130', 130), texto('resposta', 150)], 130))
    expect(st().chat.s.map((it) => (it as { text?: string }).text))
      .toEqual(['p-100', undefined, 'a-130', 'mensagem que o motor perdeu', 'resposta'])
  })

  it('o ao vivo que o transcript nunca guarda fica, ancorado depois do item que o precedia', () => {
    const st = () => useStore.getState()
    const ao = (event: ClaudeEvent) => st().applyWsMessage({ type: 'session_event', localId: 's', event })
    st().setHistoryTail('s', tail1)
    st().addLocalUserText('s', 'p-140')
    // `!comando` e a saída dele, só da tela
    st().addLocalItem('s', { kind: 'local_command', command: 'ls' })
    st().applyWsMessage({ type: 'shell_result', localId: 's', output: 'a.txt', isError: false })
    ao(texto('a-150'))
    // Codex: "Mensagem pendente…" (deliveryError) e o erro do fim do turno (finish(error))
    ao({ kind: 'system', subtype: 'message_error', raw: { message: 'Mensagem pendente do Codex: segundo pedido\n\nfalhou' } } as ClaudeEvent)
    ao(texto('a-160'))
    ao({ kind: 'system', subtype: 'message_error', raw: { message: 'turno falhou' } } as ClaudeEvent)
    // falha de envio pelo WebSocket
    st().applyWsMessage({ type: 'error', localId: 's', message: 'envio recusado' })
    st().setHistoryTail('s', page([texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150), texto('a-160', 160)], 130))
    const visto = st().chat.s.map((it) => (it.kind === 'local_command' ? `!${it.command}` : (it as { text?: string }).text))
    expect(visto).toEqual([
      'p-100', undefined, 'a-130', 'p-140', '!ls', 'a.txt', 'a-150',
      'Mensagem pendente do Codex: segundo pedido\n\nfalhou', 'a-160', 'turno falhou', 'envio recusado',
    ])
    expect(keys(st().chat.s).filter((k) => k!.startsWith('p'))).toEqual(['p100', 'p110', 'p130', 'p140', 'p150', 'p160'])
  })

  describe('ao vivo que o transcript ainda não alcançou', () => {
    const st = () => useStore.getState()
    const ao = (event: ClaudeEvent) => st().applyWsMessage({ type: 'session_event', localId: 's', event })
    const textos = () => st().chat.s.map((it) => (it as { text?: string }).text)

    it('o que veio depois do último ao vivo casado fica, inclusive resposta do agente e texto com cara de comando', () => {
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', 'pergunta')
      ao(texto('parte 1'))
      st().addLocalUserText('s', '/tmp está cheio')
      ao(texto('parte 2'))
      // O servidor leu a página antes de "/tmp está cheio" chegar ao transcript.
      st().setHistoryTail('s', page([texto('a-130', 130), pedido('pergunta', 140), texto('parte 1', 150)], 130), 'c')
      expect(textos().slice(3)).toEqual(['pergunta', 'parte 1', '/tmp está cheio', 'parte 2'])
      expect(keys(st().chat.s).slice(3, 5)).toEqual(['p140', 'p150'])
      // Na releitura seguinte, já gravados, casam e trocam de chave — sem duplicar.
      st().setHistoryTail('s', page([
        texto('a-130', 130), pedido('pergunta', 140), texto('parte 1', 150), pedido('/tmp está cheio', 160), texto('parte 2', 170),
      ], 130), 'c')
      expect(textos().slice(3)).toEqual(['pergunta', 'parte 1', '/tmp está cheio', 'parte 2'])
      expect(keys(st().chat.s).slice(3)).toEqual(['p140', 'p150', 'p160', 'p170'])
    })

    it('eco da fila, continue do goal e aviso de resultado ao vivo aparecem uma vez só depois da releitura do fim do turno', () => {
      const item = 'item da fila do operador'
      const resultado = '[Claudinei: task result]: Task #7 sent to Beta completed.\nresultado de Beta'
      const cont = '[Claudinei: goal]: Continue toward the goal: testes verdes. Turn 2/20. When it is fully met, call goal_done with the evidence.'
      st().setHistoryTail('s', tail1, 'c')
      // Ao vivo: a fila e o Claudinei ecoam (session_event user), cada um seguido da resposta.
      ao(pedido(item))
      ao(texto('feito o item'))
      ao(pedido(resultado))
      ao(texto('li o resultado'))
      ao(pedido(cont))
      ao(texto('seguindo'))
      const vivos = st().chat.s.slice(3)
      expect(vivos.map((it) => it.kind)).toEqual(['user_text', 'assistant_text', 'claudinei_message', 'assistant_text', 'claudinei_message', 'assistant_text'])
      expect(vivos.every((it) => /^l\d+$/.test(it.key!))).toBe(true)
      // O fim do turno relê a cauda, agora com tudo gravado.
      st().setHistoryTail('s', page([
        texto('a-130', 130), pedido(item, 140), texto('feito o item', 150),
        pedido(resultado, 160), texto('li o resultado', 170), pedido(cont, 180), texto('seguindo', 190),
      ], 130), 'c')
      const depois = st().chat.s.slice(3)
      expect(depois.map((it) => it.kind)).toEqual(['user_text', 'assistant_text', 'claudinei_message', 'assistant_text', 'claudinei_message', 'assistant_text'])
      expect(keys(depois)).toEqual(['p140', 'p150', 'p160', 'p170', 'p180', 'p190'])
      expect(depois.filter((it) => it.kind === 'claudinei_message').map((it) => (it as { reason: string }).reason)).toEqual(['task_result', 'goal'])
      expect(textos().filter((t) => t === item)).toHaveLength(1)
    })

    it('reconexão no meio do turno: a resposta que chegou depois da leitura não some', () => {
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', 'p-140')
      ao(texto('a-150'))
      ao(chamada('t9'))
      ao(texto('a-170'))
      st().setHistoryTail('s', page([texto('a-130', 130), pedido('p-140', 140)], 130), 'c')
      const visto = st().chat.s.map((it) => (it.kind === 'tool_call' ? `tool ${it.id}` : (it as { text?: string }).text))
      expect(visto.slice(3)).toEqual(['p-140', 'a-150', 'tool t9', 'a-170'])
    })

    it('mensagem do Claudinei que começa um turno enquanto a releitura anda: nada do turno novo some', () => {
      st().setHistoryTail('s', tail1, 'c')
      ao(pedido('[Task from Outro]: rode os testes'))
      ao(texto('rodando'))
      // A página foi lida antes do turno novo: nenhum ao vivo casa.
      st().setHistoryTail('s', page([texto('a-130', 130)], 130), 'c')
      const kinds = st().chat.s.slice(3).map((it) => it.kind)
      expect(kinds).toEqual(['task_message', 'assistant_text'])
    })

    it('comando de verdade enviado no meio do turno (o transcript não o grava) fica como texto do operador', () => {
      // Sessão do Claude via SDK: o prompt do meio do turno vira `queued_command`, que o parser ignora.
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', 'p-140')
      ao(texto('a-150'))
      st().addLocalUserText('s', '/effort high')
      ao(texto('a-170'))
      st().setHistoryTail('s', page([texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150), texto('a-170', 170)], 130), 'c')
      expect(textos().slice(3)).toEqual(['p-140', 'a-150', '/effort high', 'a-170'])
    })
  })

  describe('slash command enviado pelo chat', () => {
    const st = () => useStore.getState()
    const ao = (event: ClaudeEvent) => st().applyWsMessage({ type: 'session_event', localId: 's', event })
    const visto = () => st().chat.s.map((it) =>
      it.kind === 'local_command' ? `chip ${it.command}${it.args ? ` ${it.args}` : ''}` : `${it.kind}: ${(it as { text?: string }).text ?? ''}`)

    it('Claude: o transcript grava o chip; a bolha ao vivo casa com ele e não fica duplicada', () => {
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', '/effort xhigh')
      const bolha = st().chat.s[st().chat.s.length - 1].key!
      st().addLocalUserText('s', '/superpowers:brainstorming  uma ideia ')
      st().setHistoryTail('s', page([
        texto('a-130', 130),
        user('<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>xhigh</command-args>', 140),
        user('<local-command-stdout>Set effort level to xhigh</local-command-stdout>', 150),
        user('<command-name>/superpowers:brainstorming</command-name>\n<command-args>uma ideia</command-args>', 160),
      ], 130), 'c')
      expect(visto().slice(3)).toEqual([
        'chip /effort xhigh', 'command_output: Set effort level to xhigh', 'chip /superpowers:brainstorming uma ideia',
      ])
      expect(st().chat.s.find((it) => it.key === 'p140')).toBeDefined()
      expect(keys(st().chat.s)).not.toContain(bolha)
    })

    it('Codex: /compact não grava texto; a bolha ao vivo sem par não fica como fantasma', () => {
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', '/compact')
      ao(texto('compactando'))
      st().setHistoryTail('s', page([
        texto('a-130', 130),
        { kind: 'system', subtype: 'compact_boundary', raw: { compact_metadata: { pre_tokens: 9000 } }, pos: 140 } as ClaudeEvent,
        texto('compactando', 150),
      ], 130), 'c')
      expect(visto().some((v) => v.includes('/compact'))).toBe(false)
    })

    it('texto que só começa com um caminho não é slash command: sem par, fica', () => {
      st().setHistoryTail('s', tail1, 'c')
      st().addLocalUserText('s', '/home/x/a.ts quebrou')
      st().setHistoryTail('s', page([texto('a-130', 130)], 130), 'c')
      expect(visto()).toContain('user_text: /home/x/a.ts quebrou')
    })
  })

  it('prompt de subagente ao vivo sem par não fica (não é texto do operador)', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1, 'c')
    st().addLocalUserText('s', 'pedido do operador')
    st().applyWsMessage({ type: 'session_event', localId: 's', event: user([{ type: 'text', text: 'investigue o módulo X' }], undefined, { parent_tool_use_id: 'toolu_agent' }) })
    expect(st().chat.s[st().chat.s.length - 1]).toMatchObject({ kind: 'user_text', fromSubagent: true })
    // O transcript principal não guarda o subagente; a resposta depois dele casa.
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('pronto') })
    st().setHistoryTail('s', page([texto('a-130', 130), texto('pronto', 150)], 130), 'c')
    const textos = st().chat.s.map((it) => (it as { text?: string }).text)
    expect(textos).not.toContain('investigue o módulo X')
    expect(textos).toContain('pedido do operador')
  })

  it('página vazia da mesma conversa não mexe na tela nem no cursor', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1, 'c1')
    st().prependHistory('s', older, 100)
    const antes = st().chat.s
    const cursor = st().historyCursor.s
    // id fantasma, rollout que sumiu: a rota devolve vazio
    st().setHistoryTail('s', page([], 0, true), 'c1')
    expect(st().chat.s).toBe(antes)
    expect(st().historyCursor.s).toBe(cursor)
  })

  it('conversa trocada substitui (e mantém a mensagem otimista), mesmo com a página vazia', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1, '(preview)')
    st().addLocalUserText('s', 'primeira mensagem')
    st().setHistoryTail('s', page([], 0, true), 'real-1')
    expect(st().chat.s).toMatchObject([{ kind: 'user_text', text: 'primeira mensagem' }])
    expect(st().historyCursor.s).toEqual({ before: 0, atStart: true, conv: 'real-1' })
    // e a mesma posição em outro arquivo não vira prefixo da conversa nova
    st().setHistoryTail('t', tail1, 'c1')
    st().setHistoryTail('t', page([pedido('p-100', 100), texto('outra', 120)], 100), 'c2')
    expect(keys(st().chat.t)).toEqual(['p100', 'p120'])
    expect(st().historyCursor.t).toEqual({ before: 100, atStart: false, conv: 'c2' })
  })

  it('prependHistory não duplica chaves', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1)
    // página antiga que se sobrepõe ao que já está carregado
    st().prependHistory('s', page([texto('a-80', 80), pedido('p-100', 100), chamada('t1', 110)], 80), 100)
    const ks = keys(st().chat.s)
    expect(ks).toEqual(['p80', 'p100', 'p110', 'p130'])
    expect(new Set(ks).size).toBe(ks.length)
  })

  it('página antiga que chega depois de o cursor andar é descartada (sem buraco nem falso começo)', () => {
    const st = () => useStore.getState()
    st().setHistoryTail('s', tail1, 'c1')
    // pediu a página antes de 100; enquanto ela vinha, o turno terminou e a cauda substituiu tudo
    st().setHistoryTail('s', page([texto('a-900', 900), texto('a-950', 950)], 900), 'c1')
    st().prependHistory('s', older, 100)
    expect(keys(st().chat.s)).toEqual(['p900', 'p950'])
    expect(st().historyCursor.s).toEqual({ before: 900, atStart: false, conv: 'c1' })
    // sem cursor (nada carregado) também não enxerta
    st().prependHistory('outra', older, 100)
    expect(st().chat.outra).toBeUndefined()
  })

  it('página antiga com o tool_use preenche o resultado que chegou antes, órfão', () => {
    const st = () => useStore.getState()
    // a cauda começa com o resultado; a chamada ficou na página anterior
    st().setHistoryTail('s', page([resultado('t0', 'saída de t0', 100), texto('a-110', 110)], 100))
    expect(keys(st().chat.s)).toEqual(['p110'])
    st().prependHistory('s', page([pedido('p-0', 0), chamada('t0', 50)], 0, true), 100)
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

describe('loadHistoryTail: turno maior que uma página', () => {
  afterEach(() => vi.restoreAllMocks())
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  /** Rota falsa: `paginas[before ?? 'fim']` é a resposta; registra os pedidos. */
  const rota = (paginas: Record<string, ReturnType<typeof page>>) => {
    const pedidos: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = new URL(String(url), 'http://x')
      pedidos.push(u.search)
      return Promise.resolve(ok(paginas[u.searchParams.get('before') ?? 'fim']))
    })
    return pedidos
  }
  const st = () => useStore.getState()
  /** Relê e devolve a página entregue ao `apply` (null se não houve entrega). */
  const reler = async (localId: string, conv: string) => {
    let entregue: HistoryPage | null = null
    await loadHistoryTail(localId, conv, (p) => { entregue = p })
    return entregue as HistoryPage | null
  }
  const telaComPaginasAntigas = () => {
    st().setHistoryTail('s', page([pedido('p-100', 100), texto('a-130', 130)], 100), 'c')
    st().prependHistory('s', page([pedido('p-0', 0), texto('a-40', 40)], 0, true), 100)
    // o turno começa ao vivo: o pedido e as primeiras respostas
    st().addLocalUserText('s', 'p-140')
    st().applyWsMessage({ type: 'session_event', localId: 's', event: texto('a-150') })
    return st().chat.s
  }

  it('lê para trás até encostar na tela; nada se perde e o que não mudou mantém o objeto', async () => {
    const antes = telaComPaginasAntigas()
    const pedidos = rota({
      fim: page([texto('a-400', 400), texto('a-450', 450)], 400),
      400: page([texto('a-200', 200), texto('a-300', 300)], 200),
      200: page([texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150), texto('a-190', 190)], 130),
    })
    const tail = (await reler('s', 'c'))!
    expect(pedidos).toEqual(['', '?before=400&limit=500', '?before=200&limit=500'])
    expect(tail.before).toBe(130)
    st().setHistoryTail('s', tail, 'c')
    const depois = st().chat.s
    expect(keys(depois)).toEqual(['p0', 'p40', 'p100', 'p130', 'p140', 'p150', 'p190', 'p200', 'p300', 'p400', 'p450'])
    for (let i = 0; i < 4; i++) expect(depois[i]).toBe(antes[i])
    expect(st().historyCursor.s).toEqual({ before: 0, atStart: true, conv: 'c' })
  })

  it('a cauda que já encosta na tela não pede página extra', async () => {
    telaComPaginasAntigas()
    const pedidos = rota({ fim: page([texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150)], 130) })
    await reler('s', 'c')
    expect(pedidos).toEqual([''])
  })

  it(`passado o teto (${TAIL_CATCHUP_PAGES} páginas extras), substitui sem buraco`, async () => {
    telaComPaginasAntigas()
    const paginas: Record<string, ReturnType<typeof page>> = { fim: page([texto('fim', 100_000)], 100_000) }
    for (let i = 0; i < 20; i++) {
      const b = 100_000 - i * 1000
      paginas[b] = page([texto(`t-${b - 1000}`, b - 1000)], b - 1000)
    }
    const pedidos = rota(paginas)
    const tail = (await reler('s', 'c'))!
    expect(pedidos).toHaveLength(1 + TAIL_CATCHUP_PAGES)
    st().setHistoryTail('s', tail, 'c')
    expect(st().historyCursor.s).toEqual({ before: tail.before, atStart: false, conv: 'c' })
    expect(keys(st().chat.s)[0]).toBe(`p${tail.before}`)
    // a mensagem do operador que o transcript não tem continua na tela
    expect(st().chat.s.some((it) => it.kind === 'user_text' && it.text === 'p-140')).toBe(true)
  })

  describe('terminal novo: o primeiro turno passa de uma página', () => {
    /** Primeiro turno só ao vivo: a abertura e as respostas. */
    const turnoAoVivo = () => {
      st().addLocalUserText('s', 'abertura')
      for (const t of ['a-10', 'a-20', 'a-300', 'a-310']) st().applyWsMessage({ type: 'session_event', localId: 's', event: texto(t) })
    }
    const paginas = () => ({
      fim: page([texto('a-300', 300), texto('a-310', 310)], 300),
      300: page([pedido('abertura', 0), texto('a-10', 10), texto('a-20', 20)], 0, true),
    })
    const textos = () => st().chat.s.map((it) => (it as { text?: string }).text)

    it('sem cursor (a carga inicial veio vazia): lê para trás até achar a abertura', async () => {
      // Carga inicial vazia: a tela não ganha cursor.
      st().setHistoryTail('s', page([], 0, true), 'c')
      expect(st().historyCursor.s).toBeUndefined()
      turnoAoVivo()
      const pedidos = rota(paginas())
      const tail = (await reler('s', 'c'))!
      expect(pedidos).toEqual(['', '?before=300&limit=500'])
      st().setHistoryTail('s', tail, 'c')
      expect(textos()).toEqual(['abertura', 'a-10', 'a-20', 'a-300', 'a-310'])
      expect(keys(st().chat.s)).toEqual(['p0', 'p10', 'p20', 'p300', 'p310'])
      expect(st().historyCursor.s).toEqual({ before: 0, atStart: true, conv: 'c' })
    })

    it('cursor sem nenhum item confirmado na tela também lê para trás', async () => {
      // Prévia → conversa real com página vazia: cursor no começo, nada confirmado.
      st().setHistoryTail('s', page([pedido('da prévia', 0)], 0, true), '(preview)')
      st().setHistoryTail('s', page([], 0, true), 'c')
      expect(st().chat.s).toEqual([])
      expect(st().historyCursor.s).toEqual({ before: 0, atStart: true, conv: 'c' })
      turnoAoVivo()
      const pedidos = rota(paginas())
      st().setHistoryTail('s', (await reler('s', 'c'))!, 'c')
      expect(pedidos).toEqual(['', '?before=300&limit=500'])
      expect(textos()).toEqual(['abertura', 'a-10', 'a-20', 'a-300', 'a-310'])
    })

    it('a página que já tem a abertura não pede mais nada', async () => {
      turnoAoVivo()
      const pedidos = rota({ fim: page([pedido('abertura', 0), texto('a-10', 10)], 0, false) })
      await reler('s', 'c')
      expect(pedidos).toEqual([''])
    })
  })

  it('outra conversa não lê para trás (as chaves são de outro arquivo)', async () => {
    telaComPaginasAntigas()
    const pedidos = rota({ fim: page([texto('a-400', 400)], 400), 400: page([texto('a-200', 200)], 200) })
    await reler('s', 'outra')
    expect(pedidos).toEqual([''])
  })

  it('releituras concorrentes: só a mais recente é aplicada, e a velha que chega depois é ignorada', async () => {
    telaComPaginasAntigas()
    const respostas: ((r: Response) => void)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((res) => { respostas.push(res) }))
    const aplicadas: string[] = []
    const primeira = loadHistoryTail('s', 'c', () => aplicadas.push('primeira'))
    const segunda = loadHistoryTail('s', 'c', () => aplicadas.push('segunda'))
    // a mais nova responde antes; a velha (cauda mais curta) chega depois
    respostas[1](ok(page([texto('a-130', 130), pedido('p-140', 140), texto('a-150', 150), texto('a-160', 160)], 130)))
    await expect(segunda).resolves.toBe(true)
    respostas[0](ok(page([texto('a-130', 130)], 130)))
    await expect(primeira).resolves.toBe(false)
    expect(aplicadas).toEqual(['segunda'])
  })

  it('a velha também não aplica quando a mais nova ainda está a caminho', async () => {
    telaComPaginasAntigas()
    const respostas: ((r: Response) => void)[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((res) => { respostas.push(res) }))
    const aplicadas: string[] = []
    const primeira = loadHistoryTail('s', 'c', () => aplicadas.push('primeira'))
    void loadHistoryTail('s', 'c', () => aplicadas.push('segunda'))
    respostas[0](ok(page([texto('a-130', 130)], 130)))
    await expect(primeira).resolves.toBe(false)
    expect(aplicadas).toEqual([])
  })
})
