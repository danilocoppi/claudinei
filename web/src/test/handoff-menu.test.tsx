import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { EngineTabs } from '../components/EngineTabs'
import { MessageBlock } from '../components/MessageBlock'
import { useStore } from '../store'
import * as branchApi from '../branch/api'
import { handoffTargets, parseHandoffHeader } from '../branch/handoff'
import { foldsToOpen } from '../chat/find'
import i18n from '../i18n'
import type { ChatItem, EngineMeta, OperatorQueue, Project, SessionInfo, SessionStatus, TerminalState } from '../types'

/**
 * ⇄ Continuar noutro motor: o menu da aba ativa (destinos, estado e pendências
 * de cada um), a confirmação do destino ocioso, o POST e a aba do destino; e o
 * cartão "Contexto trazido do <Motor>" do pacote que chega lá.
 */

const meta = (id: string, label: string, extra: Partial<EngineMeta> = {}): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [], ...extra,
})
const CLAUDE = meta('claude', 'Claude Code')
const CODEX = meta('codex', 'Codex')
const KIMI = meta('kimi', 'Kimi Code')
const OPENCODE = meta('opencode', 'OpenCode')
const GEMINI = meta('gemini', 'Gemini', { available: false })
const CATALOG = [CLAUDE, CODEX, KIMI, OPENCODE, GEMINI]

const sess = (localId: string, engine: string, status: SessionStatus): SessionInfo =>
  ({ localId, projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine })

const state = (engine: string, o: Partial<TerminalState> = {}): TerminalState => ({
  projectId: 1, engine, autostart: false, autoResume: false, interruption: null, autoResumeLimit: false,
  usageLimit: null, taskResults: [], taskResultsHeld: false, goal: null, ...o,
})
const queue = (engine: string, n: number): OperatorQueue => ({
  projectId: 1, engine, paused: false, pauseReason: null,
  items: Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `m${i}`, createdAt: 'x', via: 'alt-enter' as const })),
})
const goal = (status: 'active' | 'waiting' | 'paused') =>
  ({ criterion: 'x', status, pause: null, turns: 1, max: 20, evidence: null })

/** Daqui a uma hora, em epoch SEGUNDOS (o `resetsAt` do limite). */
const emUmaHora = () => Math.floor(Date.now() / 1000) + 3600

const PROJECT: Project = {
  id: 1, name: 'T', path: '/tmp/t', color: '#000', icon: 'x', engines: ['claude', 'codex', 'kimi', 'opencode', 'gemini'],
}

beforeEach(() => {
  useStore.setState({
    engines: CATALOG, enginesLoaded: true, projects: [PROJECT],
    sessions: { c1: sess('c1', 'claude', 'idle') },
    terminalStates: {}, queues: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    activeLocalId: 'c1', view: 'chat',
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('handoffTargets', () => {
  const base = {
    projectId: 1, from: 'claude', engines: CATALOG, listed: PROJECT.engines!,
    sessions: {} as Record<string, SessionInfo>, terminalStates: {} as Record<string, TerminalState>,
    queues: {} as Record<string, OperatorQueue>,
  }
  const byId = (list: ReturnType<typeof handoffTargets>) => Object.fromEntries(list.map((t) => [t.engine.id, t]))

  it('lista os motores da lista do terminal, instalados e diferentes do atual, na ordem do catálogo', () => {
    expect(handoffTargets(base).map((t) => t.engine.id)).toEqual(['codex', 'kimi', 'opencode'])
    expect(handoffTargets({ ...base, listed: ['claude', 'kimi'] }).map((t) => t.engine.id)).toEqual(['kimi'])
  })

  it('estados none, idle, working e limited', () => {
    const t = byId(handoffTargets({
      ...base,
      engines: [...CATALOG, meta('grok', 'Grok')],
      listed: [...base.listed, 'grok'],
      sessions: {
        x1: sess('x1', 'codex', 'idle'),
        k1: sess('k1', 'kimi', 'working'),
        g1: sess('g1', 'grok', 'in_terminal'),
        o0: sess('o0', 'opencode', 'stopped'),
      },
      terminalStates: {
        '1:opencode': state('opencode', { usageLimit: { hitAt: '2026-11-21 10:00:00', resetsAt: emUmaHora(), action: 'none', origin: 'operator' } }),
      },
    }))
    expect(t.codex.state).toBe('idle')
    expect(t.kimi.state).toBe('working')
    // Aberto no terminal interativo: o servidor recusa como ocupado.
    expect(t.grok.state).toBe('working')
    expect(t.opencode.state).toBe('limited')
    expect(Date.parse(t.opencode.limitUntil!)).toBe(emUmaHora() * 1000)
    // Sem sessão viva: "sem conversa" (uma parada não conta).
    expect(byId(handoffTargets(base)).opencode.state).toBe('none')
  })

  it('limite que já reabriu não segura; armado segura mesmo sem hora', () => {
    const passado = Math.floor(Date.now() / 1000) - 60
    const reaberto = byId(handoffTargets({ ...base, terminalStates: {
      '1:codex': state('codex', { usageLimit: { hitAt: '2026-11-21 10:00:00', resetsAt: passado, action: 'none', origin: 'operator' } }),
    } }))
    expect(reaberto.codex.state).toBe('none')
    const armado = byId(handoffTargets({ ...base, terminalStates: {
      '1:codex': state('codex', { usageLimit: { hitAt: '2026-11-21 10:00:00', resetsAt: null, action: 'armed', origin: 'operator' } }),
    } }))
    expect(armado.codex.state).toBe('limited')
    expect(armado.codex.limitUntil).toBeUndefined()
  })

  it('pendências do destino: goal ativo (ou esperando), itens na fila e avisos de resultado', () => {
    const t = byId(handoffTargets({
      ...base,
      terminalStates: {
        '1:codex': state('codex', {
          goal: goal('active'),
          taskResults: [{ id: 1, toProjectName: 'A', status: 'completed' }, { id: 2, toProjectName: 'B', status: 'failed' }],
        }),
        '1:kimi': state('kimi', { goal: goal('waiting') }),
        '1:opencode': state('opencode', { goal: goal('paused') }),
      },
      queues: { '1:codex': queue('codex', 3) },
    }))
    expect(t.codex.pending).toEqual({ goal: true, queue: 3, taskResults: 2 })
    expect(t.kimi.pending).toEqual({ goal: true, queue: 0, taskResults: 0 })
    expect(t.opencode.pending).toEqual({ goal: false, queue: 0, taskResults: 0 })
  })
})

describe('parseHandoffHeader', () => {
  // Saída real do `buildHandoff`/`withRequest` (server/src/branch/handoff.ts).
  const PACOTE = '[Claudinei: context handoff]: This conversation continues one held with Claude Code in this same folder. Below are its 2 most recent messages, whole, oldest first (about 13 tokens). The full conversation is at /home/u/.claude/projects/-tmp-x/abc.jsonl; read it only if you need something older. If no request follows, reply with one short line confirming you have the context.\n\n=== operator ===\noi\n\n=== agent ===\nolá, tudo certo'

  it('lê Motor, N e T, e separa o request', () => {
    expect(parseHandoffHeader(PACOTE)).toEqual({
      engineLabel: 'Claude Code', messages: 2, tokens: 13, body: '=== operator ===\noi\n\n=== agent ===\nolá, tudo certo',
    })
    expect(parseHandoffHeader(`${PACOTE}\n\n=== request ===\ne agora?\nduas linhas`)).toEqual({
      engineLabel: 'Claude Code', messages: 2, tokens: 13,
      body: '=== operator ===\noi\n\n=== agent ===\nolá, tudo certo', request: 'e agora?\nduas linhas',
    })
  })

  it('referência sem caminho (motor sem transcript) também casa', () => {
    const texto = PACOTE.replace('/home/u/.claude/projects/-tmp-x/abc.jsonl', 'kimi conversation 3f2a').replace('Claude Code', 'Kimi Code')
    expect(parseHandoffHeader(texto)).toMatchObject({ engineLabel: 'Kimi Code', messages: 2, tokens: 13 })
  })

  it('fora do formato devolve null', () => {
    expect(parseHandoffHeader('oi')).toBeNull()
    expect(parseHandoffHeader(`veja: ${PACOTE}`)).toBeNull()
    expect(parseHandoffHeader('[Claudinei: context handoff]: outro texto')).toBeNull()
  })
})

describe('menu ⇄ na aba ativa', () => {
  const swap = () => screen.queryByTitle('Continuar noutro motor')
  const openMenu = () => {
    fireEvent.click(swap()!)
    return document.querySelector('.sess-pop') as HTMLElement
  }
  const item = (menu: HTMLElement, label: string) =>
    within(menu).getByText(label).closest('.sess-pop__item') as HTMLElement

  /** Codex ocioso com pendências, Kimi trabalhando, OpenCode no limite. */
  const cenario = () => useStore.setState({
    sessions: {
      c1: sess('c1', 'claude', 'idle'), x1: sess('x1', 'codex', 'idle'), k1: sess('k1', 'kimi', 'working'),
    },
    terminalStates: {
      '1:codex': state('codex', { goal: goal('active'), taskResults: [{ id: 1, toProjectName: 'A', status: 'completed' }, { id: 2, toProjectName: 'B', status: 'completed' }] }),
      '1:opencode': state('opencode', { usageLimit: { hitAt: '2026-11-21 10:00:00', resetsAt: emUmaHora(), action: 'none', origin: 'operator' } }),
    },
    queues: { '1:codex': queue('codex', 3) },
  })

  it('só na aba ativa e viva', () => {
    cenario()
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(screen.getAllByTitle('Continuar noutro motor')).toHaveLength(1)
    const abaAtiva = document.querySelector('.engine-tab.active') as HTMLElement
    expect(within(abaAtiva).getByTitle('Continuar noutro motor')).toBeTruthy()
  })

  it('sem outro motor instalado na lista, não há ⇄', () => {
    useStore.setState({ projects: [{ ...PROJECT, engines: ['claude', 'gemini'] }] })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(swap()).toBeNull()
  })

  it('lista estados e pendências, com o rodapé da origem', () => {
    cenario()
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    expect(within(item(menu, 'Codex')).getByText('ocioso — a conversa atual será encerrada (fica no histórico)')).toBeTruthy()
    expect(within(item(menu, 'Codex')).getByText('goal ativo')).toBeTruthy()
    expect(within(item(menu, 'Codex')).getByText('3 na fila')).toBeTruthy()
    expect(within(item(menu, 'Codex')).getByText('2 avisos de resultado')).toBeTruthy()
    expect(within(item(menu, 'Kimi Code')).getByText('trabalhando — indisponível')).toBeTruthy()
    expect(within(item(menu, 'OpenCode')).getByText(/^no limite até \d\d:\d\d — indisponível$/)).toBeTruthy()
    expect(within(menu).queryByText('Gemini')).toBeNull()
    expect(within(menu).queryByText('Claude Code')).toBeNull()
    expect(within(menu).getByText('o Claude Code continua aberto; pare-o se não quiser os dois na pasta')).toBeTruthy()
  })

  it('trabalhando e no limite ficam desabilitados', () => {
    cenario()
    const spy = vi.spyOn(branchApi, 'handoff').mockResolvedValue(sess('n1', 'kimi', 'starting'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    for (const label of ['Kimi Code', 'OpenCode']) {
      const el = item(menu, label)
      expect(el.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(el)
    }
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('ocioso pede confirmação antes do POST', async () => {
    cenario()
    const spy = vi.spyOn(branchApi, 'handoff').mockResolvedValue(sess('n1', 'codex', 'starting'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(item(openMenu(), 'Codex'))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Continuar no Codex?' })).toBeTruthy()
    // O goal ativo do destino fica pausado: a confirmação avisa.
    expect(screen.getByText(/goal do Codex fica pausado/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(1, 'claude', 'codex'))
  })

  it('cancelar a confirmação não chama a rota', () => {
    cenario()
    const spy = vi.spyOn(branchApi, 'handoff').mockResolvedValue(sess('n1', 'codex', 'starting'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(item(openMenu(), 'Codex'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('após o POST, a aba do destino abre', async () => {
    // OpenCode sem conversa: vai direto, sem confirmação.
    const spy = vi.spyOn(branchApi, 'handoff').mockResolvedValue(sess('o1', 'opencode', 'starting'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    fireEvent.click(item(openMenu(), 'OpenCode'))
    expect(spy).toHaveBeenCalledWith(1, 'claude', 'opencode')
    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('o1'))
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().sessions.o1?.engine).toBe('opencode')
    expect(document.querySelector('.sess-pop')).toBeNull()
  })

  it('erro da rota aparece no menu, no idioma da tela', async () => {
    vi.spyOn(branchApi, 'handoff').mockRejectedValue(new Error('O motor de destino está no limite de uso.'))
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const menu = openMenu()
    fireEvent.click(item(menu, 'Codex'))
    const erro = await within(menu).findByRole('alert')
    expect(erro.className).toContain('sess-pop__error')
    expect(erro.textContent).toBe('O motor de destino está no limite de uso.')
    expect(useStore.getState().activeLocalId).toBe('c1')
  })
})

describe('cartão do pacote', () => {
  const card = (o: Partial<Extract<ChatItem, { reason: 'handoff' }>> = {}): ChatItem => ({
    kind: 'claudinei_message', reason: 'handoff', engineLabel: 'Codex', messages: 12, tokens: 15800,
    text: '=== operator ===\noi\n\n=== agent ===\nolá', ...o,
  })

  it('mostra "~16 mil tokens" para 15800, dobrado por padrão; abre o corpo em <pre>', () => {
    render(<MessageBlock item={card()} />)
    expect(screen.getByText('Contexto trazido do Codex: 12 mensagens (~16 mil tokens)')).toBeTruthy()
    expect(document.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByText('Contexto trazido do Codex: 12 mensagens (~16 mil tokens)'))
    expect(document.querySelector('pre')?.textContent).toBe('=== operator ===\noi\n\n=== agent ===\nolá')
  })

  it('uma mensagem no singular', () => {
    render(<MessageBlock item={card({ messages: 1, tokens: 1200 })} />)
    expect(screen.getByText('Contexto trazido do Codex: 1 mensagem (~1 mil tokens)')).toBeTruthy()
  })

  it('abaixo de mil tokens mostra o número cru, não "~1 mil"', () => {
    render(<MessageBlock item={card({ tokens: 200 })} />)
    expect(screen.getByText('Contexto trazido do Codex: 12 mensagens (~200 tokens)')).toBeTruthy()
  })

  it('um token no singular', () => {
    render(<MessageBlock item={card({ tokens: 1 })} />)
    expect(screen.getByText('Contexto trazido do Codex: 12 mensagens (~1 token)')).toBeTruthy()
  })

  it.each([
    ['en', 200, 'Context brought from Codex: 12 messages (~200 tokens)'],
    ['en', 1, 'Context brought from Codex: 12 messages (~1 token)'],
    ['en', 15800, 'Context brought from Codex: 12 messages (~16k tokens)'],
    ['es', 200, 'Contexto traído de Codex: 12 mensajes (~200 tokens)'],
    ['es', 1, 'Contexto traído de Codex: 12 mensajes (~1 token)'],
    ['es', 15800, 'Contexto traído de Codex: 12 mensajes (~16 mil tokens)'],
  ] as const)('em %s, %i tokens', async (lang, tokens, texto) => {
    await i18n.changeLanguage(lang)
    try {
      render(<MessageBlock item={card({ tokens })} />)
      expect(screen.getByText(texto)).toBeTruthy()
    } finally {
      await i18n.changeLanguage('pt-BR')
    }
  })

  it('o request aparece abaixo como texto do operador', () => {
    render(<MessageBlock item={card({ request: 'e agora, o que falta?' })} />)
    const pedido = screen.getByText('e agora, o que falta?')
    expect(pedido.closest('.msg-bubble')).toBeTruthy()
    expect(pedido.closest('pre')).toBeNull()
  })
})

describe('busca (Ctrl+F) no cartão', () => {
  it('ocorrência dentro do pacote abre o cartão', () => {
    const it0: ChatItem = { kind: 'claudinei_message', reason: 'handoff', engineLabel: 'Codex', messages: 2, tokens: 10, text: 'x', key: 'p10' }
    expect(foldsToOpen([], [it0], 'p10', 'text')).toEqual(['p10:summary'])
  })
})
