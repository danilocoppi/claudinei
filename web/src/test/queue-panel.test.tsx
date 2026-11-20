import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render, cleanup, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  fetchQueue: vi.fn(),
  addToQueue: vi.fn(),
  editQueueItem: vi.fn(),
  reorderQueue: vi.fn(),
  removeQueueItem: vi.fn(),
  sendQueueItemNow: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
}))

import * as api from '../api'
import { QueuePanel } from '../components/QueuePanel'
import { useStore } from '../store'
import { queueHeld } from '../queueHold'
import { localizeServerError } from '../serverErrors'
import i18n from '../i18n'
import type { OperatorQueue, TerminalState } from '../types'

/** A fila do operador acima do campo: lista editável, pausa e espera pelo aviso. */

const fila = (o: Partial<OperatorQueue> = {}): OperatorQueue =>
  ({ projectId: 1, engine: 'claude', items: [], paused: false, pauseReason: null, ...o })
const A = { id: 11, text: 'primeiro: rode os testes\ne depois o lint', createdAt: '2026-11-20 12:00:00' }
const B = { id: 12, text: 'segundo: abra o PR', createdAt: '2026-11-20 12:01:00' }
const estado = (o: Partial<TerminalState> = {}): TerminalState => ({
  projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null,
  autoResumeLimit: false, usageLimit: null, ...o,
})

const mocks = [api.fetchQueue, api.addToQueue, api.editQueueItem, api.reorderQueue, api.removeQueueItem, api.sendQueueItemNow, api.pauseQueue, api.resumeQueue]

beforeEach(() => {
  for (const m of mocks) { vi.mocked(m).mockReset(); vi.mocked(m).mockResolvedValue(fila({ items: [A, B] })) }
  // a leitura inicial não chega: o estado é o que o teste pôs no store
  vi.mocked(api.fetchQueue).mockImplementation(() => new Promise(() => {}))
  useStore.setState({ authStatus: 'ready', queues: {}, terminalStates: {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const poe = (q: OperatorQueue) => useStore.setState({ queues: { '1:claude': q } })
const abrir = () => render(<QueuePanel projectId={1} engine="claude" />)
const linha = (texto: RegExp) => screen.getByText(texto).closest('li') as HTMLElement

describe('painel da fila', () => {
  it('mostra os itens e esconde quando vazia', () => {
    poe(fila({ items: [A, B] }))
    abrir()
    // uma linha só por item: a primeira linha do texto
    expect(screen.getByText('primeiro: rode os testes')).toBeTruthy()
    expect(screen.getByText('segundo: abra o PR')).toBeTruthy()
    act(() => useStore.getState().setQueue(fila()))
    expect(screen.queryByTestId('queue-panel')).toBeNull()
  })

  it('lê a fila do servidor ao montar', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(fila({ items: [B] }))
    abrir()
    expect(api.fetchQueue).toHaveBeenCalledWith(1, 'claude')
    expect(await screen.findByText('segundo: abra o PR')).toBeTruthy()
  })

  it('editar, subir, descer, remover e enviar agora chamam a API certa', async () => {
    poe(fila({ items: [A, B] }))
    abrir()

    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Editar' }))
    const editor = screen.getByRole('textbox', { name: 'Editar mensagem da fila' }) as HTMLTextAreaElement
    expect(editor.value).toBe(A.text)
    fireEvent.change(editor, { target: { value: 'primeiro, só os testes' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(api.editQueueItem).toHaveBeenCalledWith(1, 'claude', 11, 'primeiro, só os testes')
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())

    fireEvent.click(within(linha(/^segundo/)).getByRole('button', { name: 'Subir' }))
    expect(api.reorderQueue).toHaveBeenLastCalledWith(1, 'claude', [12, 11])
    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Descer' }))
    expect(api.reorderQueue).toHaveBeenLastCalledWith(1, 'claude', [12, 11])
    // nas pontas não há para onde ir
    expect((within(linha(/^primeiro/)).getByRole('button', { name: 'Subir' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(linha(/^segundo/)).getByRole('button', { name: 'Descer' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Remover da fila' }))
    expect(api.removeQueueItem).toHaveBeenCalledWith(1, 'claude', 11)
    fireEvent.click(within(linha(/^segundo/)).getByRole('button', { name: 'Enviar agora' }))
    expect(api.sendQueueItemNow).toHaveBeenCalledWith(1, 'claude', 12)
  })

  it('Esc no editor desiste sem chamar a API', () => {
    poe(fila({ items: [A] }))
    abrir()
    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Editar' }))
    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'outra coisa' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(api.editQueueItem).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('erro da API aparece no painel', async () => {
    vi.mocked(api.sendQueueItemNow).mockRejectedValue(new Error('Esta sessão não está ativa.'))
    poe(fila({ items: [A] }))
    abrir()
    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Enviar agora' }))
    expect(await screen.findByText(/Esta sessão não está ativa/)).toBeTruthy()
  })

  it('pausada mostra o motivo e Retomar fila', () => {
    poe(fila({ items: [A], paused: true, pauseReason: 'error' }))
    abrir()
    expect(screen.getByText(/fila pausada — erro no turno/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar fila' }))
    expect(api.resumeQueue).toHaveBeenCalledWith(1, 'claude')
  })

  it('pausada à mão e vazia continua à vista, para poder retomar', () => {
    poe(fila({ paused: true, pauseReason: 'manual' }))
    abrir()
    expect(screen.getByTestId('queue-panel')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retomar fila' })).toBeTruthy()
  })

  it('Pausar fila chama a API', () => {
    poe(fila({ items: [A] }))
    abrir()
    fireEvent.click(screen.getByRole('button', { name: 'Pausar fila' }))
    expect(api.pauseQueue).toHaveBeenCalledWith(1, 'claude')
  })

  it('segurando por aviso mostra a espera', () => {
    poe(fila({ items: [A] }))
    useStore.setState({ terminalStates: { '1:claude': estado({ interruption: { at: '2026-11-20 12:00:00', reason: 'off' } }) } })
    abrir()
    expect(screen.getByText(/esperando o aviso acima/)).toBeTruthy()
  })

  it('mensagem WS operator_queue atualiza o painel', () => {
    abrir()
    expect(screen.queryByTestId('queue-panel')).toBeNull()
    act(() => useStore.getState().applyWsMessage({ type: 'operator_queue', projectId: 1, engine: 'claude', queue: fila({ items: [B] }) }))
    expect(screen.getByText('segundo: abra o PR')).toBeTruthy()
    // a de outro terminal não mexe neste
    act(() => useStore.getState().applyWsMessage({ type: 'operator_queue', projectId: 1, engine: 'codex', queue: fila({ engine: 'codex', items: [A] }) }))
    expect(screen.queryByText('primeiro: rode os testes')).toBeNull()
  })
})

/** Promessa que o teste resolve na hora que quiser: a resposta HTTP que chega atrasada. */
function adiada<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const ws = (q: OperatorQueue) =>
  act(() => useStore.getState().applyWsMessage({ type: 'operator_queue', projectId: q.projectId, engine: q.engine, queue: q }))

describe('resposta HTTP atrasada não sobrescreve a fila mais nova do WebSocket', () => {
  it('enviar agora no Kimi: a resposta que chega depois da entrega não ressuscita o item', async () => {
    const kimi = (o: Partial<OperatorQueue> = {}) => fila({ engine: 'kimi', ...o })
    const resposta = adiada<OperatorQueue>()
    vi.mocked(api.sendQueueItemNow).mockReturnValue(resposta.promise)
    useStore.setState({ queues: { '1:kimi': kimi({ items: [B] }) } })
    render(<QueuePanel projectId={1} engine="kimi" />)
    fireEvent.click(within(linha(/^segundo/)).getByRole('button', { name: 'Enviar agora' }))
    expect(api.sendQueueItemNow).toHaveBeenCalledWith(1, 'kimi', 12)
    // A ordem vista no app real: o emit do sendNow, a entrega (emit do offer) e só então o 200.
    ws(kimi({ items: [B] }))
    ws(kimi())
    await act(async () => { resposta.resolve(kimi({ items: [B] })); await resposta.promise })
    expect(screen.queryByTestId('queue-panel')).toBeNull()
    expect(useStore.getState().queues['1:kimi'].items).toEqual([])
  })

  it('sem WebSocket no meio, a resposta da API vale', async () => {
    vi.mocked(api.removeQueueItem).mockResolvedValue(fila({ items: [B] }))
    poe(fila({ items: [A, B] }))
    abrir()
    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Remover da fila' }))
    await waitFor(() => expect(screen.queryByText('primeiro: rode os testes')).toBeNull())
  })

  it('a leitura inicial que chega depois de um WebSocket fica de fora', async () => {
    const leitura = adiada<OperatorQueue>()
    vi.mocked(api.fetchQueue).mockReturnValue(leitura.promise)
    abrir()
    ws(fila())
    await act(async () => { leitura.resolve(fila({ items: [A] })); await leitura.promise })
    expect(screen.queryByTestId('queue-panel')).toBeNull()
  })
})

describe('edição de um item que saiu da fila no meio', () => {
  /** Abre o editor de A, muda o texto e faz A sair da fila (entregue) pelo WebSocket. */
  const editarESumir = (restante: OperatorQueue) => {
    poe(fila({ items: [A, B] }))
    abrir()
    fireEvent.click(within(linha(/^primeiro/)).getByRole('button', { name: 'Editar' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Editar mensagem da fila' }), { target: { value: 'primeiro, editado' } })
    ws(restante)
  }

  it('o texto editado fica num editor órfão com o aviso, mesmo com a fila vazia', () => {
    editarESumir(fila())
    // A fila esvaziou, mas o painel continua à vista por causa da edição.
    expect(screen.getByTestId('queue-panel')).toBeTruthy()
    expect(screen.getByText('Esta mensagem saiu antes de você salvar a edição.')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('primeiro, editado')
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull()
  })

  it('Pôr na fila de novo acrescenta o texto editado e fecha o editor', async () => {
    vi.mocked(api.addToQueue).mockResolvedValue(fila({ items: [B, { ...A, id: 13, text: 'primeiro, editado' }] }))
    editarESumir(fila({ items: [B] }))
    // Editar outro item agora jogaria fora o texto órfão: fica bloqueado até decidir.
    expect((within(linha(/^segundo/)).getByRole('button', { name: 'Editar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pôr na fila de novo' }))
    expect(api.addToQueue).toHaveBeenCalledWith(1, 'claude', 'primeiro, editado')
    await waitFor(() => expect(screen.queryByText(/saiu antes de você salvar/)).toBeNull())
    expect(screen.getByText('primeiro, editado')).toBeTruthy()
    expect(api.editQueueItem).not.toHaveBeenCalled()
  })

  it('Pôr na fila de novo usa a mesma proteção contra resposta atrasada', async () => {
    const resposta = adiada<OperatorQueue>()
    vi.mocked(api.addToQueue).mockReturnValue(resposta.promise)
    editarESumir(fila())
    fireEvent.click(screen.getByRole('button', { name: 'Pôr na fila de novo' }))
    // O WebSocket já trouxe a fila de depois (o item novo entregue na hora): a resposta velha fica de fora.
    ws(fila())
    await act(async () => { resposta.resolve(fila({ items: [{ ...A, id: 13 }] })); await resposta.promise })
    expect(useStore.getState().queues['1:claude'].items).toEqual([])
    expect(screen.queryByTestId('queue-panel')).toBeNull()
  })

  it('Pôr na fila de novo que falha mantém o texto e mostra o erro', async () => {
    vi.mocked(api.addToQueue).mockRejectedValue(new Error('A fila já tem 20 mensagens.'))
    editarESumir(fila())
    fireEvent.click(screen.getByRole('button', { name: 'Pôr na fila de novo' }))
    expect(await screen.findByText(/A fila já tem 20 mensagens/)).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('primeiro, editado')
  })

  it('Descartar fecha o editor órfão sem chamar a API, e o painel vazio some', () => {
    editarESumir(fila())
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(api.addToQueue).not.toHaveBeenCalled()
    expect(api.editQueueItem).not.toHaveBeenCalled()
    expect(screen.queryByTestId('queue-panel')).toBeNull()
  })
})

describe('queueHeld: a fila segura enquanto há aviso aberto (espelha holdsForNotice)', () => {
  const AGORA = Date.parse('2026-11-20T15:00:00Z')
  const lim = (o: Partial<NonNullable<TerminalState['usageLimit']>>) =>
    estado({ usageLimit: { hitAt: '2026-11-20 14:00:00', resetsAt: null, action: 'none', origin: 'operator', ...o } })

  it('sem estado ou sem aviso não segura', () => {
    expect(queueHeld(undefined, AGORA)).toBe(false)
    expect(queueHeld(estado(), AGORA)).toBe(false)
  })
  it('interrompido segura', () => {
    expect(queueHeld(estado({ interruption: { at: 'x', reason: 'queued' } }), AGORA)).toBe(true)
  })
  it('limite com aviso na tela (none ou armed) segura, mesmo vencido', () => {
    expect(queueHeld(lim({ action: 'none', resetsAt: AGORA / 1000 - 3600 }), AGORA)).toBe(true)
    expect(queueHeld(lim({ action: 'armed', resetsAt: AGORA / 1000 - 3600 }), AGORA)).toBe(true)
  })
  it('adiado segura só enquanto o limite está ativo', () => {
    expect(queueHeld(lim({ action: 'snoozed', resetsAt: AGORA / 1000 + 60 }), AGORA)).toBe(true)
    expect(queueHeld(lim({ action: 'snoozed', resetsAt: AGORA / 1000 - 60 }), AGORA)).toBe(false)
    // reabertura desconhecida: ativo até 5 h depois de gravado
    expect(queueHeld(lim({ action: 'snoozed', resetsAt: null, hitAt: '2026-11-20 11:00:00' }), AGORA)).toBe(true)
    expect(queueHeld(lim({ action: 'snoozed', resetsAt: null, hitAt: '2026-11-20 09:00:00' }), AGORA)).toBe(false)
    // data ilegível não segura
    expect(queueHeld(lim({ action: 'snoozed', resetsAt: null, hitAt: 'lixo' }), AGORA)).toBe(false)
  })
})

describe('fila: Zen e erros do servidor', () => {
  it('o painel da fila não está entre o que o Zen esconde', () => {
    // fileURLToPath direto: o jsdom substitui o construtor global de URL (ver sidebar-css.test.ts)
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')
    const zenHides = [...css.matchAll(/([^{}]*\.app\.zen[^{}]*)\{[^}]*display:\s*none/g)].map((m) => m[1]).join(' ')
    expect(zenHides).toContain('.chat-header')
    expect(zenHides).not.toContain('queue-panel')
  })

  it('os códigos de erro da fila são traduzidos nas três línguas', async () => {
    expect(localizeServerError({ error: 'a fila já tem 20 mensagens', code: 'queue_full', params: { max: 20 } }))
      .toBe('A fila já tem 20 mensagens.')
    for (const lng of ['en', 'es', 'pt-BR'] as const) {
      await i18n.changeLanguage(lng)
      for (const code of ['queue_full', 'queue_item_too_large', 'queue_item_empty', 'queue_item_not_found', 'queue_order_mismatch']) {
        expect(i18n.exists(`serverErrors.${code}`), `${code} em ${lng}`).toBe(true)
      }
      for (const k of ['queue.resume', 'queue.held', 'queue.placeholderPaused', 'queue.reason.dead',
        'queue.orphan', 'queue.orphanLabel', 'queue.requeue', 'queue.discard'] as const) {
        expect(i18n.t(k), `${k} em ${lng}`).not.toBe(k)
      }
    }
    await i18n.changeLanguage('pt-BR')
  })
})
