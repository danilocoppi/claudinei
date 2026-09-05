import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store'
import { displayStatusKey, dotClassOf } from '../engineSession'

beforeEach(() => {
  useStore.setState({ projects: [], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, activeLocalId: undefined, view: 'dashboard', board: [], tasks: [], sessionEffort: {} })
})

describe('store', () => {
  it('compact_boundary limpa contextTokens: a barra não fica presa no valor pré-compactação', () => {
    useStore.setState({ sessions: { l1: { localId: 'l1', projectId: 1, status: 'idle', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude', contextTokens: 190_000 } as never } })
    useStore.getState().applyWsMessage({
      type: 'session_event', localId: 'l1',
      event: { kind: 'system', subtype: 'compact_boundary', raw: {} },
    })
    expect(useStore.getState().sessions['l1'].contextTokens).toBeUndefined()
  })

  it('session_status atualiza sessão', () => {
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'l1', status: 'idle', engineSessionId: 'c1' })
    expect(useStore.getState().sessions['l1']).toMatchObject({ status: 'idle', engineSessionId: 'c1' })
  })

  it('session_event acumula chat e incrementa unread quando não é a sessão ativa', () => {
    useStore.getState().applyWsMessage({
      type: 'session_event', localId: 'l1',
      event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] }, raw: {} },
    })
    expect(useStore.getState().chat['l1']).toHaveLength(1)
    expect(useStore.getState().unread['l1']).toBe(1)
  })

  it('sessão ativa não acumula unread', () => {
    useStore.getState().openSession('l1')
    useStore.getState().applyWsMessage({
      type: 'session_event', localId: 'l1',
      event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] }, raw: {} },
    })
    expect(useStore.getState().unread['l1'] ?? 0).toBe(0)
  })

  it('openSession zera unread e muda view', () => {
    useStore.setState({ unread: { l1: 5 } })
    useStore.getState().openSession('l1')
    expect(useStore.getState().unread['l1']).toBe(0)
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('l1')
  })

  it('session_status de sessão desconhecida usa o projectId do broadcast', () => {
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'novo', projectId: 7, status: 'starting', engineSessionId: null })
    expect(useStore.getState().sessions['novo']).toMatchObject({ projectId: 7, status: 'starting' })
  })

  it('sessions_snapshot popula sessões', () => {
    useStore.getState().applyWsMessage({
      type: 'sessions_snapshot',
      sessions: [{ localId: 'l1', projectId: 1, status: 'idle', engineSessionId: null, updatedAt: 'x' }],
    })
    expect(Object.keys(useStore.getState().sessions)).toEqual(['l1'])
  })

  it('session_status dead com detail é guardado na sessão', () => {
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'd1', projectId: 1, status: 'dead', engineSessionId: null, detail: 'boom' })
    expect(useStore.getState().sessions['d1']).toMatchObject({ status: 'dead', detail: 'boom' })
  })

  it('board_post do broadcast é adicionado no início do board', () => {
    useStore.setState({ board: [{ id: 1, projectId: 1, projectName: 'P1', title: 'Antigo', content: 'x', createdAt: 't0' }] })
    useStore.getState().applyWsMessage({
      type: 'board_post', id: 2, projectId: 2, projectName: 'P2', title: 'Novo aviso', content: 'olá',
    })
    const board = useStore.getState().board
    expect(board).toHaveLength(2)
    expect(board[0]).toMatchObject({ id: 2, projectId: 2, projectName: 'P2', title: 'Novo aviso', content: 'olá' })
    expect(board[1].id).toBe(1)
  })

  it('openBoard muda a view para board e limpa activeLocalId', () => {
    useStore.setState({ activeLocalId: 'l1', view: 'chat' })
    useStore.getState().openBoard()
    expect(useStore.getState().view).toBe('board')
    expect(useStore.getState().activeLocalId).toBeUndefined()
  })

  it('task_update com id novo é adicionado no início das tarefas', () => {
    useStore.setState({
      tasks: [{
        id: 1, fromProjectId: 1, fromProjectName: 'P1', toProjectId: 2, toProjectName: 'P2',
        description: 'antiga', status: 'completed', result: 'ok', createdAt: 't0', updatedAt: 't0',
      }],
    })
    useStore.getState().applyWsMessage({
      type: 'task_update',
      task: {
        id: 2, fromProjectId: 1, fromProjectName: 'P1', toProjectId: 3, toProjectName: 'P3',
        description: 'nova', status: 'in_progress', result: null, createdAt: 't1', updatedAt: 't1',
      },
    })
    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ id: 2, description: 'nova' })
    expect(tasks[1].id).toBe(1)
  })

  it('task_update com id existente substitui a tarefa no lugar, sem duplicar', () => {
    useStore.setState({
      tasks: [
        {
          id: 1, fromProjectId: 1, fromProjectName: 'P1', toProjectId: 2, toProjectName: 'P2',
          description: 'tarefa', status: 'in_progress', result: null, createdAt: 't0', updatedAt: 't0',
        },
        {
          id: 2, fromProjectId: 1, fromProjectName: 'P1', toProjectId: 2, toProjectName: 'P2',
          description: 'outra', status: 'in_progress', result: null, createdAt: 't0', updatedAt: 't0',
        },
      ],
    })
    useStore.getState().applyWsMessage({
      type: 'task_update',
      task: {
        id: 1, fromProjectId: 1, fromProjectName: 'P1', toProjectId: 2, toProjectName: 'P2',
        description: 'tarefa', status: 'completed', result: 'feito', createdAt: 't0', updatedAt: 't1',
      },
    })
    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ id: 1, status: 'completed', result: 'feito' })
    expect(tasks[1].id).toBe(2)
  })

  it('openTasks muda a view para tasks e limpa activeLocalId', () => {
    useStore.setState({ activeLocalId: 'l1', view: 'chat' })
    useStore.getState().openTasks()
    expect(useStore.getState().view).toBe('tasks')
    expect(useStore.getState().activeLocalId).toBeUndefined()
  })

  it('openTerminal muda view para terminal e seta activeLocalId', () => {
    useStore.getState().openTerminal('l9')
    expect(useStore.getState().view).toBe('terminal')
    expect(useStore.getState().activeLocalId).toBe('l9')
  })

  describe('effort da sessão (farejado do chat)', () => {
    it('result "Set effort level to X" atualiza sessionEffort', () => {
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'result', subtype: 'success', isError: false, costUsd: 0, raw: {},
                 resultText: 'Set effort level to xhigh (this session only): Deeper reasoning than high' },
      })
      expect(useStore.getState().sessionEffort['l1']).toBe('xhigh')
    })

    it('result sem relação não mexe no effort', () => {
      useStore.setState({ sessionEffort: { l1: 'high' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'result', subtype: 'success', isError: false, costUsd: 0, raw: {}, resultText: 'eco: qualquer coisa' },
      })
      expect(useStore.getState().sessionEffort['l1']).toBe('high')
    })

    it('init de uma sessão não apaga o effort das outras', () => {
      useStore.setState({ sessionEffort: { l1: 'max', l2: 'high' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'init', sessionId: 'c1', model: 'fable', raw: {} },
      })
      expect(useStore.getState().sessionEffort['l1']).toBeUndefined()
      expect(useStore.getState().sessionEffort['l2']).toBe('high')
    })

    it('init (processo novo) reseta o effort da sessão para o padrão', () => {
      useStore.setState({ sessionEffort: { l1: 'max' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'init', sessionId: 'c1', model: 'fable', raw: {} },
      })
      expect(useStore.getState().sessionEffort['l1']).toBeUndefined()
    })
  })

  describe('streaming preview (item 20)', () => {
    it('session_event kind stream acumula texto em streaming[localId] sem tocar no chat nem no unread', () => {
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'stream', text: 'ol', raw: {} },
      })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'stream', text: 'á, mundo', raw: {} },
      })
      expect(useStore.getState().streaming['l1']).toBe('olá, mundo')
      expect(useStore.getState().chat['l1'] ?? []).toHaveLength(0)
      expect(useStore.getState().unread['l1'] ?? 0).toBe(0)
    })

    it('kind assistant limpa streaming[localId] (apaga a CHAVE) e adiciona o item real no chat', () => {
      useStore.setState({ streaming: { l1: 'texto parcial em construção' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'texto completo' }] }, raw: {} },
      })
      expect('l1' in useStore.getState().streaming).toBe(false) // deletado, não '' (M20)
      expect(useStore.getState().chat['l1']).toHaveLength(1)
      expect(useStore.getState().chat['l1'][0]).toMatchObject({ kind: 'assistant_text', text: 'texto completo' })
    })

    it('kind result também limpa streaming[localId]', () => {
      useStore.setState({ streaming: { l1: 'texto parcial' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} },
      })
      expect('l1' in useStore.getState().streaming).toBe(false)
    })
  })

  it('evento init popula slashCommands (global)', () => {
    useStore.getState().applyWsMessage({ type: 'session_event', localId: 's1', event: { kind: 'init', sessionId: 'x', model: 'opus', slashCommands: ['compact', 'meu-comando'] } })
    expect(useStore.getState().slashCommands).toContain('meu-comando')
  })
})

it('setSlashCommands atualiza a lista; lista vazia não sobrescreve', () => {
  useStore.getState().setSlashCommands(['compact', 'cost', 'x'])
  expect(useStore.getState().slashCommands).toEqual(['compact', 'cost', 'x'])
  useStore.getState().setSlashCommands([]) // vazia = mantém a boa (backend sem cache ainda)
  expect(useStore.getState().slashCommands).toEqual(['compact', 'cost', 'x'])
})

describe('rebusca de histórico no fim do turno', () => {
  it('working → idle invalida o historyLoadedFor da sessão (retag de injeções da engine)', () => {
    useStore.setState({
      sessions: { l9: { localId: 'l9', projectId: 1, status: 'working', engineSessionId: 'c9', updatedAt: 'x', engine: 'claude' } as never },
      historyLoadedFor: { l9: 'c9', outra: 'cX' },
    })
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'l9', status: 'idle', engineSessionId: 'c9' })
    expect(useStore.getState().historyLoadedFor).toEqual({ outra: 'cX' })
  })

  it('working → working (ou idle → idle) NÃO invalida', () => {
    useStore.setState({
      sessions: { l9: { localId: 'l9', projectId: 1, status: 'idle', engineSessionId: 'c9', updatedAt: 'x', engine: 'claude' } as never },
      historyLoadedFor: { l9: 'c9' },
    })
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'l9', status: 'idle', engineSessionId: 'c9' })
    expect(useStore.getState().historyLoadedFor).toEqual({ l9: 'c9' })
  })
})

describe('resyncOnReconnect (I8: WS caiu e voltou — servidor não faz replay)', () => {
  it('invalida os históricos carregados (ChatView rebusca) e descarta streaming órfão', () => {
    useStore.setState({
      historyLoadedFor: { l1: 'c1', l2: 'c2' },
      streaming: { l1: 'resposta que nunca vai terminar de chegar' },
    })
    useStore.getState().resyncOnReconnect()
    expect(useStore.getState().historyLoadedFor).toEqual({})
    expect(useStore.getState().streaming).toEqual({})
  })

  it('não mexe no chat já renderizado (a rebusca é quem atualiza)', () => {
    useStore.setState({
      chat: { l1: [{ kind: 'user_text', text: 'oi' }] },
      historyLoadedFor: { l1: 'c1' },
    })
    useStore.getState().resyncOnReconnect()
    expect(useStore.getState().chat['l1']).toHaveLength(1)
  })
})

describe('M20: mapas do store não crescem sem limite', () => {
  it('board é podado nos últimos 200 posts', () => {
    const cheio = Array.from({ length: 200 }, (_, i) => ({
      id: i, projectId: 1, projectName: 'P', title: `t${i}`, content: 'x', createdAt: 't0',
    }))
    useStore.setState({ board: cheio })
    useStore.getState().applyWsMessage({ type: 'board_post', id: 999, projectId: 1, projectName: 'P', title: 'novo', content: 'y' })
    const board = useStore.getState().board
    expect(board).toHaveLength(200)
    expect(board[0].id).toBe(999) // o novo entra…
    expect(board.some((p) => p.id === 199)).toBe(false) // …e o mais velho sai
  })

  it('sessions_snapshot poda entradas por-sessão de sessões que não existem mais', () => {
    useStore.setState({
      chat: { viva: [], morta: [{ kind: 'user_text', text: 'x' }] },
      unread: { morta: 3 },
      historyLoadedFor: { viva: 'c1', morta: 'c2' },
      streaming: { morta: 'resto' },
    })
    useStore.getState().applyWsMessage({
      type: 'sessions_snapshot',
      sessions: [{ localId: 'viva', projectId: 1, status: 'idle', engineSessionId: 'c1', updatedAt: 'x' }],
    })
    expect(Object.keys(useStore.getState().chat)).toEqual(['viva'])
    expect(useStore.getState().unread).toEqual({})
    expect(useStore.getState().historyLoadedFor).toEqual({ viva: 'c1' })
    expect(useStore.getState().streaming).toEqual({})
  })
})

describe('terminal_activity (heurística do TUI)', () => {
  it('atualiza terminalActivity da sessão in_terminal', () => {
    useStore.setState({
      sessions: { t1: { localId: 't1', projectId: 1, status: 'in_terminal', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    useStore.getState().applyWsMessage({ type: 'terminal_activity', localId: 't1', activity: 'working' })
    expect(useStore.getState().sessions.t1.terminalActivity).toBe('working')
  })

  it('ignora sessão que não está in_terminal', () => {
    useStore.setState({
      sessions: { t1: { localId: 't1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } as never },
    })
    useStore.getState().applyWsMessage({ type: 'terminal_activity', localId: 't1', activity: 'waiting' })
    expect(useStore.getState().sessions.t1.terminalActivity).toBeUndefined()
  })

  it('sair de in_terminal limpa a atividade', () => {
    useStore.setState({
      sessions: { t1: { localId: 't1', projectId: 1, status: 'in_terminal', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', terminalActivity: 'working' } as never },
    })
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 't1', status: 'stopped', engineSessionId: 'c' })
    expect(useStore.getState().sessions.t1.terminalActivity).toBeUndefined()
  })

  it('ENTRAR em in_terminal zera atividade velha (M19: transição de entrada)', () => {
    useStore.setState({
      sessions: { t1: { localId: 't1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', terminalActivity: 'working' } as never },
    })
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 't1', status: 'in_terminal', engineSessionId: 'c' })
    expect(useStore.getState().sessions.t1.terminalActivity).toBeUndefined()
  })

  it('permanência em in_terminal preserva a atividade corrente', () => {
    useStore.setState({
      sessions: { t1: { localId: 't1', projectId: 1, status: 'in_terminal', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', terminalActivity: 'waiting' } as never },
    })
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 't1', status: 'in_terminal', engineSessionId: 'c' })
    expect(useStore.getState().sessions.t1.terminalActivity).toBe('waiting')
  })
})

describe('displayStatusKey/dotClassOf', () => {
  const sess = (activity?: 'working' | 'waiting' | 'idle') =>
    ({ localId: 't', projectId: 1, status: 'in_terminal', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', terminalActivity: activity }) as never
  it('in_terminal refina pela atividade (idle mantém o rótulo básico)', () => {
    expect(displayStatusKey(sess('working'))).toBe('in_terminal_working')
    expect(displayStatusKey(sess('waiting'))).toBe('in_terminal_waiting')
    expect(displayStatusKey(sess('idle'))).toBe('in_terminal')
    expect(displayStatusKey(sess(undefined))).toBe('in_terminal')
  })
  it('esperando = âmbar; processando = pulso', () => {
    expect(dotClassOf(sess('waiting'))).toContain('status-needs_attention')
    expect(dotClassOf(sess('working'))).toContain('status-dot--pulse')
    expect(dotClassOf(sess(undefined))).toBe('status-dot status-in_terminal')
  })
})
