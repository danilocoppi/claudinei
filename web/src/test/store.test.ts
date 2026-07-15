import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({ projects: [], sessions: {}, chat: {}, unread: {}, streaming: {}, activeLocalId: undefined, view: 'dashboard', board: [], tasks: [], sessionEffort: {} })
})

describe('store', () => {
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

    it('kind assistant limpa streaming[localId] e adiciona o item real no chat', () => {
      useStore.setState({ streaming: { l1: 'texto parcial em construção' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'texto completo' }] }, raw: {} },
      })
      expect(useStore.getState().streaming['l1']).toBe('')
      expect(useStore.getState().chat['l1']).toHaveLength(1)
      expect(useStore.getState().chat['l1'][0]).toMatchObject({ kind: 'assistant_text', text: 'texto completo' })
    })

    it('kind result também limpa streaming[localId]', () => {
      useStore.setState({ streaming: { l1: 'texto parcial' } })
      useStore.getState().applyWsMessage({
        type: 'session_event', localId: 'l1',
        event: { kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: {} },
      })
      expect(useStore.getState().streaming['l1']).toBe('')
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
