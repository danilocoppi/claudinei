import { describe, it, expect } from 'vitest'
import {
  HANDOFF_PREFIX, HANDOFF_BUDGET_CHARS, HANDOFF_MAX_BYTES, TOOL_RESULT_MAX,
  messagesOf, dropOpenTurn, isCompactionSummary, buildHandoff, withRequest, collectHandoff,
  type HandoffMessage,
} from '../src/branch/handoff.js'
import { CONVERSATION_REWOUND_NOTE, filesRevertedNote, withNote } from '../../shared/undo.js'
import type { AgentEvent, Engine } from '../src/engine/types.js'
import type { HistoryPageOptions, PositionedEvent } from '../src/history-page.js'

/**
 * Pacote de contexto: a conversa recente em texto, para um motor que não copia
 * a conversa (Kimi), para a cópia nativa recusada e para a troca de motor.
 * Eventos montados à mão; a engine é falsa (nada de CLI nem de ~/.claude).
 */

// ---- eventos de mentira --------------------------------------------------
const op = (text: string, raw: Record<string, unknown> = {}): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content: text }, raw: { type: 'user', ...raw } })
const opBlocks = (text: string): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, raw: { type: 'user' } })
const ag = (...content: any[]): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content }, raw: { type: 'assistant' } })
const txt = (text: string) => ({ type: 'text', text })
const think = (thinking: string) => ({ type: 'thinking', thinking })
const tool = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const res = (id: string, content: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, raw: { type: 'user' } })

const META = { label: 'Claude', ref: '/tmp/x/conversa.jsonl' }

function cabecalho(label: string, n: number, t: number, ref: string): string {
  return `[Claudinei: context handoff]: This conversation continues one held with ${label} in this same folder. `
    + `Below are its ${n} most recent messages, whole, oldest first (about ${t} tokens). `
    + `The full conversation is at ${ref}; read it only if you need something older. `
    + 'If no request follows, reply with one short line confirming you have the context.'
}

/** Engine falsa que pagina por índice: `pageSize` eventos por página, antes de `before`. */
function fakeEngine(events: AgentEvent[], opts: { pageSize?: number; ref?: string | null; calls?: number[] } = {}): Engine {
  const eng: Partial<Engine> = {
    id: 'fake',
    capabilities: () => ({ label: 'Fake', icon: '', permissions: [], slashSource: 'none', slashCommands: [], models: [] } as any),
    readHistory: () => events,
  }
  if (opts.pageSize) {
    const size = opts.pageSize
    eng.readHistoryPage = async (_p: string, _id: string, o: HistoryPageOptions) => {
      const fim = Math.min(o.before ?? events.length, events.length)
      const ini = Math.max(0, fim - size)
      opts.calls?.push(fim)
      const page: PositionedEvent[] = events.slice(ini, fim).map((e, i) => ({ ...e, pos: ini + i }))
      return { events: page, start: ini, atStart: ini === 0 }
    }
  }
  if (opts.ref !== undefined) eng.transcriptRef = () => opts.ref!
  return eng as Engine
}

describe('constantes', () => {
  it('valores do plano', () => {
    expect(HANDOFF_PREFIX).toBe('[Claudinei: context handoff]')
    expect(HANDOFF_BUDGET_CHARS).toBe(64_000)
    expect(HANDOFF_MAX_BYTES).toBe(100 * 1024)
    expect(TOOL_RESULT_MAX).toBe(300)
  })
})

describe('buildHandoff', () => {
  it('cabeçalho verbatim com N, T, Motor e ref', () => {
    const msgs: HandoffMessage[] = [
      { role: 'operator', text: 'oi' },
      { role: 'agent', text: 'olá, tudo certo' },
    ]
    const h = buildHandoff(msgs, META)!
    const corpo = '=== operator ===\noi\n\n=== agent ===\nolá, tudo certo'
    const t = Math.ceil(corpo.length / 4)
    expect(h.text).toBe(`${cabecalho('Claude', 2, t, META.ref)}\n\n${corpo}`)
    expect(h.messages).toBe(2)
    expect(h.tokens).toBe(t)
  })

  it('mensagens inteiras, em ordem, mais antiga primeiro (e o resumo vira "earlier summary")', () => {
    const msgs: HandoffMessage[] = [
      { role: 'summary', text: 'resumo' },
      { role: 'operator', text: 'primeira' },
      { role: 'agent', text: 'segunda' },
      { role: 'operator', text: 'terceira' },
    ]
    const h = buildHandoff(msgs, META)!
    const corpo = h.text.slice(h.text.indexOf('\n\n') + 2)
    expect(corpo).toBe('=== earlier summary ===\nresumo\n\n=== operator ===\nprimeira\n\n=== agent ===\nsegunda\n\n=== operator ===\nterceira')
  })

  it('orçamento: a 64 001ª letra deixa a mensagem mais antiga de fora, nunca pela metade', () => {
    const recente: HandoffMessage = { role: 'agent', text: 'b'.repeat(50_000) }
    const com = (n: number) => buildHandoff([{ role: 'operator', text: 'a'.repeat(n) }, recente], META)!
    // Maior tamanho da antiga que ainda cabe inteira.
    let n = 0
    while (com(n + 1).messages === 2) n++
    const cabe = com(n)
    expect(cabe.messages).toBe(2)
    expect(cabe.text.length).toBe(HANDOFF_BUDGET_CHARS)
    const fora = com(n + 1)
    expect(fora.messages).toBe(1)
    expect(fora.text).not.toContain('aa') // nem pedaço da antiga
    expect(fora.text).not.toContain('=== operator ===')
    expect(fora.text).toContain('b'.repeat(50_000))
  })

  it('teto de 100 KB com texto multibyte', () => {
    // 10 000 emojis = 20 000 caracteres e 40 000 bytes: três cabem em caracteres, não em bytes.
    const emoji = '😀'.repeat(10_000)
    const msgs: HandoffMessage[] = [
      { role: 'operator', text: emoji },
      { role: 'agent', text: emoji },
      { role: 'operator', text: emoji },
    ]
    const h = buildHandoff(msgs, META)!
    expect(h.text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS)
    expect(Buffer.byteLength(h.text)).toBeLessThanOrEqual(102_400)
    expect(h.messages).toBe(2)
  })

  it('a mais recente sozinha acima do orçamento entra com "(beginning cut off)" e o fim preservado', () => {
    const grande = 'x'.repeat(70_000) + 'FIM-DA-MENSAGEM'
    const h = buildHandoff([{ role: 'operator', text: 'antiga' }, { role: 'agent', text: grande }], META)!
    expect(h.messages).toBe(1)
    expect(h.text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS)
    expect(h.text.length).toBeGreaterThan(HANDOFF_BUDGET_CHARS - 10)
    expect(h.text).toContain('=== agent ===\n(beginning cut off)\n')
    expect(h.text.endsWith('FIM-DA-MENSAGEM')).toBe(true)
    expect(h.text).not.toContain('antiga')
    expect(h.text.startsWith(cabecalho('Claude', 1, h.tokens, META.ref))).toBe(true)
  })

  it('a mais recente cortada em bytes não parte um emoji', () => {
    const h = buildHandoff([{ role: 'operator', text: '😀'.repeat(60_000) }], META)!
    expect(Buffer.byteLength(h.text)).toBeLessThanOrEqual(HANDOFF_MAX_BYTES)
    expect(h.text).not.toContain('�')
    const resto = h.text.slice(h.text.indexOf('(beginning cut off)\n') + '(beginning cut off)\n'.length)
    expect(/^(😀)+$/u.test(resto)).toBe(true)
  })

  it('sem mensagens: null', () => {
    expect(buildHandoff([], META)).toBeNull()
  })
})

describe('withRequest', () => {
  it('withRequest acrescenta "=== request ==="', () => {
    const h = buildHandoff([{ role: 'operator', text: 'oi' }], META)!
    expect(withRequest(h, 'e agora?')).toBe(`${h.text}\n\n=== request ===\ne agora?`)
  })
})

describe('messagesOf', () => {
  it('operador e agente inteiros; vários assistant seguidos viram uma mensagem agent', () => {
    const msgs = messagesOf([
      op('pergunta 1'),
      ag(txt('vou olhar')),
      ag(txt('pronto')),
      opBlocks('pergunta 2'),
      ag(txt('resposta 2')),
    ])
    expect(msgs).toEqual([
      { role: 'operator', text: 'pergunta 1' },
      { role: 'agent', text: 'vou olhar\npronto' },
      { role: 'operator', text: 'pergunta 2' },
      { role: 'agent', text: 'resposta 2' },
    ])
  })

  it('ferramenta vira "→ Bash: npm test" e o resultado até 300 caracteres com "…"', () => {
    const longo = 'r'.repeat(500)
    const msgs = messagesOf([
      op('roda os testes'),
      ag(txt('rodando'), tool('t1', 'Bash', { command: 'npm test', description: 'testes' })),
      res('t1', longo),
      ag(tool('t2', 'Read', { file_path: '/a/b.ts' })),
      res('t2', [{ type: 'text', text: 'linha 1\nlinha 2' }]),
      ag(tool('t3', 'Grep', { pattern: 'foo', glob: '*.ts' })),
      ag(tool('t4', 'Glob', { path: '/src' })),
      ag(tool('t5', 'Task', { description: 'explorar' })),
      ag(tool('t6', 'Outra', { x: 1 })),
      ag(txt('feito')),
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[1].text.split('\n')).toEqual([
      'rodando',
      '→ Bash: npm test',
      `  ← ${'r'.repeat(TOOL_RESULT_MAX)}…`,
      '→ Read: /a/b.ts',
      '  ← linha 1 linha 2',
      '→ Grep: foo',
      '→ Glob: /src',
      '→ Task: explorar',
      '→ Outra: {"x":1}',
      'feito',
    ])
  })

  it('o resumo da ferramenta fica numa linha e é cortado em 200 caracteres', () => {
    const msgs = messagesOf([op('x'), ag(tool('t', 'Bash', { command: 'echo a\necho b\n' + 'z'.repeat(400) }))])
    const linha = msgs[1].text
    expect(linha).not.toContain('\n')
    expect(linha.startsWith('→ Bash: echo a echo b zzz')).toBe(true)
    expect(linha.length - '→ Bash: '.length).toBeLessThanOrEqual(201) // 200 + "…"
  })

  it('thinking fica de fora', () => {
    const msgs = messagesOf([op('pensa'), ag(think('segredo interno'), txt('resposta'))])
    expect(msgs).toEqual([{ role: 'operator', text: 'pensa' }, { role: 'agent', text: 'resposta' }])
  })

  it('injetados (fromEngine, isMeta, isSynthetic) ficam de fora', () => {
    const msgs = messagesOf([
      op('de verdade'),
      op('skill injetada', { isMeta: true }),
      op('ao vivo injetada', { isSynthetic: true }),
      { kind: 'user', message: { role: 'user', content: 'developer do codex' }, fromEngine: true, raw: {} },
      ag(txt('ok')),
    ])
    expect(msgs).toEqual([{ role: 'operator', text: 'de verdade' }, { role: 'agent', text: 'ok' }])
  })

  it('resumo da compactação é o mais antigo e o que vem antes some', () => {
    const msgs = messagesOf([
      op('antes da compactação'),
      ag(txt('velho')),
      { kind: 'system', subtype: 'compact_boundary', raw: {} },
      op('This session is being continued from a previous conversation that ran out of context. Summary: …', { isMeta: true }),
      op('depois'),
      ag(txt('novo')),
    ])
    expect(msgs.map((m) => m.role)).toEqual(['summary', 'operator', 'agent'])
    expect(msgs[0].text.startsWith('This session is being continued')).toBe(true)
  })
})

describe('pacote recebido e interrupções (pacotes encadeados)', () => {
  it('[Request interrupted…] não vira mensagem do operador', () => {
    const msgs = messagesOf([
      op('pergunta'),
      ag(txt('começando')),
      op('[Request interrupted by user]'),
      opBlocks('[Request interrupted by user for tool use]'),
      op('pergunta 2'),
      ag(txt('ok')),
    ])
    expect(msgs).toEqual([
      { role: 'operator', text: 'pergunta' },
      { role: 'agent', text: 'começando' },
      { role: 'operator', text: 'pergunta 2' },
      { role: 'agent', text: 'ok' },
    ])
  })

  it('um pacote recebido se desdobra nas mensagens dele; o request vira mensagem do operador', () => {
    const original: HandoffMessage[] = [
      { role: 'summary', text: 'resumo antigo' },
      { role: 'operator', text: 'pergunta A\n\ncom parágrafo' },
      { role: 'agent', text: 'resposta A\n→ Bash: ls' },
    ]
    const pacote = buildHandoff(original, { label: 'Claude', ref: '/x/conv.jsonl' })!
    const msgs = messagesOf([
      op(withRequest(pacote, 'continua daqui')),
      ag(txt('continuando')),
      op('mais uma'),
      ag(txt('feito')),
    ])
    expect(msgs).toEqual([
      ...original,
      { role: 'operator', text: 'continua daqui' },
      { role: 'agent', text: 'continuando' },
      { role: 'operator', text: 'mais uma' },
      { role: 'agent', text: 'feito' },
    ])
  })

  it('nota do desfazer na frente do pacote recebido: sai, e o pacote se desdobra', () => {
    const original: HandoffMessage[] = [
      { role: 'operator', text: 'pergunta A' },
      { role: 'agent', text: 'resposta A' },
    ]
    const pacote = withRequest(buildHandoff(original, META)!, 'continua')
    for (const nota of [filesRevertedNote(['a.txt']), CONVERSATION_REWOUND_NOTE]) {
      expect(messagesOf([op(withNote(nota, pacote)), ag(txt('ok'))])).toEqual([
        ...original,
        { role: 'operator', text: 'continua' },
        { role: 'agent', text: 'ok' },
      ])
    }
    // As duas notas juntas também saem.
    const duas = withNote(CONVERSATION_REWOUND_NOTE, withNote(filesRevertedNote(['b.txt']), pacote))
    expect(messagesOf([op(duas)])).toEqual([...original, { role: 'operator', text: 'continua' }])
  })

  it('pacote cujo corpo cita <local-command-caveat> continua desdobrado e com o corpo intacto, com ou sem nota', () => {
    const original: HandoffMessage[] = [
      { role: 'operator', text: 'o que é isto?' },
      { role: 'agent', text: 'É o aviso <local-command-caveat>Caveat: x</local-command-caveat> do CLI.' },
    ]
    const pacote = buildHandoff(original, META)!.text
    for (const texto of [pacote, withNote(filesRevertedNote(['a.txt']), pacote)]) {
      expect(messagesOf([op(texto), ag(txt('ok'))])).toEqual([...original, { role: 'agent', text: 'ok' }])
    }
    // O pacote seguinte leva o corpo do anterior.
    const seguinte = buildHandoff(messagesOf([op(withNote(CONVERSATION_REWOUND_NOTE, pacote)), ag(txt('ok'))]), META)!
    expect(seguinte.text).toContain('=== agent ===\nÉ o aviso <local-command-caveat>Caveat: x</local-command-caveat> do CLI.')
    // O texto de comando local de verdade (começa com o caveat) continua de fora.
    expect(messagesOf([op('<local-command-caveat>Caveat: x</local-command-caveat>'), op('oi')]))
      .toEqual([{ role: 'operator', text: 'oi' }])
  })

  it('ida e volta: o pacote do destino carrega o contexto da origem, não só a confirmação', async () => {
    // Claude → Codex (pacote sem pedido) → de volta ao Claude.
    const origem = messagesOf([op('pergunta 1'), ag(txt('resposta 1')), op('pergunta 2'), ag(txt('resposta 2'))])
    const ida = buildHandoff(origem, { label: 'Claude', ref: '/c/conv.jsonl' })!
    const destino = [op(ida.text), ag(txt('Contexto recebido.')), op('e agora?'), ag(txt('agora isto'))]
    const volta = (await collectHandoff(fakeEngine(destino, { pageSize: 1 }), '/p', 'cdx', { working: false }))!
    expect(volta.messages).toBe(7)
    expect(volta.text).toContain('=== operator ===\npergunta 1\n\n=== agent ===\nresposta 1')
    expect(volta.text).toContain('=== agent ===\nresposta 2\n\n=== agent ===\nContexto recebido.')
    // O cabeçalho do pacote antigo não entra como texto.
    expect(volta.text.split(HANDOFF_PREFIX)).toHaveLength(2)
    // Com o destino trabalhando no turno do pacote: o contexto fica, a confirmação em curso sai.
    const emCurso = (await collectHandoff(fakeEngine([op(ida.text), ag(txt('lendo…'))]), '/p', 'cdx', { working: true }))!
    expect(emCurso.messages).toBe(4)
    expect(emCurso.text).not.toContain('lendo')
  })

  it('resumo de dentro do pacote não descarta o que veio antes dele na conversa', () => {
    const pacote = buildHandoff([{ role: 'summary', text: 'resumo' }, { role: 'operator', text: 'q' }], META)!
    const msgs = messagesOf([op('antes'), ag(txt('r')), op(pacote.text)])
    expect(msgs).toEqual([
      { role: 'operator', text: 'antes' },
      { role: 'agent', text: 'r' },
      { role: 'summary', text: 'resumo' },
      { role: 'operator', text: 'q' },
    ])
  })
})

describe('isCompactionSummary', () => {
  it('pela flag ou pelo preâmbulo', () => {
    expect(isCompactionSummary(op('qualquer coisa', { isCompactSummary: true }))).toBe(true)
    expect(isCompactionSummary(opBlocks('This session is being continued from a previous conversation …'))).toBe(true)
    expect(isCompactionSummary(op('texto comum'))).toBe(false)
    expect(isCompactionSummary(ag(txt('This session is being continued from a previous conversation')))).toBe(false)
  })
})

describe('dropOpenTurn', () => {
  it('dropOpenTurn tira o turno em andamento', () => {
    const fechado = [op('um'), ag(txt('resposta um'))]
    const aberto = [op('dois'), ag(tool('t', 'Bash', { command: 'ls' })), res('t', 'a b c')]
    expect(dropOpenTurn([...fechado, ...aberto])).toEqual(fechado)
  })

  it('resultado de ferramenta e injetados não contam como texto do operador', () => {
    const evs = [op('um'), ag(txt('r')), op('dois'), ag(tool('t', 'Bash', { command: 'ls' })), res('t', 'x'), op('lembrete', { isMeta: true })]
    expect(dropOpenTurn(evs)).toEqual([op('um'), ag(txt('r'))])
  })

  it('sem texto do operador, tudo é o turno em andamento', () => {
    expect(dropOpenTurn([ag(txt('só agente'))])).toEqual([])
  })
})

describe('collectHandoff', () => {
  const conversa = [
    op('pergunta 1'), ag(txt('resposta 1')),
    op('pergunta 2'), ag(tool('t', 'Bash', { command: 'npm test' })), res('t', 'ok'), ag(txt('resposta 2')),
  ]

  it('monta pelo readHistory (sem página) com label e transcriptRef', async () => {
    const h = (await collectHandoff(fakeEngine(conversa, { ref: '/r/conv.jsonl' }), '/p', 'abc', { working: false }))!
    expect(h.messages).toBe(4)
    expect(h.text.startsWith(cabecalho('Fake', 4, h.tokens, '/r/conv.jsonl'))).toBe(true)
    expect(h.text).toContain('=== agent ===\n→ Bash: npm test\n  ← ok\nresposta 2')
  })

  it('sem transcriptRef: "<engine> conversation <id>"', async () => {
    const h = (await collectHandoff(fakeEngine(conversa), '/p', 'abc', { working: false }))!
    expect(h.text).toContain('The full conversation is at fake conversation abc;')
  })

  it('transcriptRef null também cai no "<engine> conversation <id>"', async () => {
    const h = (await collectHandoff(fakeEngine(conversa, { ref: null }), '/p', 'abc', { working: false }))!
    expect(h.text).toContain('The full conversation is at fake conversation abc;')
  })

  it('pagina de trás para a frente e junta uma mensagem agent que atravessa páginas', async () => {
    const h = (await collectHandoff(fakeEngine(conversa, { pageSize: 2 }), '/p', 'abc', { working: false }))!
    const viaHistorico = (await collectHandoff(fakeEngine(conversa), '/p', 'abc', { working: false }))!
    expect(h.text).toBe(viaHistorico.text)
  })

  it('a partir de `before`', async () => {
    const h = (await collectHandoff(fakeEngine(conversa, { pageSize: 2 }), '/p', 'abc', { working: false, before: 2 }))!
    expect(h.messages).toBe(2)
    expect(h.text).toContain('resposta 1')
    expect(h.text).not.toContain('pergunta 2')
  })

  it('working: tira o turno em andamento, mesmo atravessando páginas', async () => {
    const evs = [
      op('pergunta 1'), ag(txt('resposta 1')),
      op('pergunta 2 em curso'), ag(tool('a', 'Bash', { command: 'ls' })), res('a', 'x'), ag(tool('b', 'Bash', { command: 'pwd' })), res('b', 'y'),
    ]
    const h = (await collectHandoff(fakeEngine(evs, { pageSize: 2 }), '/p', 'abc', { working: true }))!
    expect(h.messages).toBe(2)
    expect(h.text).not.toContain('em curso')
    expect(h.text).not.toContain('→ Bash')
  })

  it('working sem turno fechado: null', async () => {
    expect(await collectHandoff(fakeEngine([op('só a primeira'), ag(txt('...'))], { pageSize: 1 }), '/p', 'abc', { working: true })).toBeNull()
  })

  it('resumo da compactação é o mais antigo e a leitura para nele', async () => {
    const evs = [
      ...Array.from({ length: 20 }, (_, i) => op(`velha ${i}`)),
      op('This session is being continued from a previous conversation. Resumo.', { isCompactSummary: true }),
      op('nova'), ag(txt('resposta nova')),
    ]
    const calls: number[] = []
    const h = (await collectHandoff(fakeEngine(evs, { pageSize: 1, calls }), '/p', 'abc', { working: false }))!
    expect(h.messages).toBe(3)
    expect(h.text).toContain('=== earlier summary ===\nThis session is being continued')
    expect(h.text).not.toContain('velha')
    // Três páginas (resposta, nova, resumo): nenhuma antes do resumo.
    expect(calls).toEqual([23, 22, 21])
  })

  it('para quando o orçamento enche, sem ler o começo', async () => {
    const evs: AgentEvent[] = []
    for (let i = 0; i < 100; i++) evs.push(op(`p${i} ` + 'q'.repeat(5_000)), ag(txt(`r${i}`)))
    const calls: number[] = []
    const h = (await collectHandoff(fakeEngine(evs, { pageSize: 4, calls }), '/p', 'abc', { working: false }))!
    expect(h.text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS)
    expect(h.text).toContain('r99')
    expect(Math.min(...calls)).toBeGreaterThan(150)
    // Mesmo resultado que a montagem com a conversa inteira.
    const tudo = buildHandoff(messagesOf(evs), { label: 'Fake', ref: 'fake conversation abc' })!
    expect(h.text).toBe(tudo.text)
  })

  it('a mais recente sozinha acima do orçamento: para sem ler o começo', async () => {
    const evs: AgentEvent[] = [op('antiga'), ag(txt('a')), op('enorme ' + 'w'.repeat(80_000))]
    const calls: number[] = []
    const h = (await collectHandoff(fakeEngine(evs, { pageSize: 1, calls }), '/p', 'abc', { working: false }))!
    expect(h.messages).toBe(1)
    expect(h.text).toContain('(beginning cut off)\n')
    expect(calls.length).toBeLessThanOrEqual(2)
  })

  it('conversa vazia: null', async () => {
    expect(await collectHandoff(fakeEngine([]), '/p', 'abc', { working: false })).toBeNull()
  })
})
