import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { StartSessionModal } from '../components/StartSessionModal'
import { useStore } from '../store'
import type { EngineMeta, Project } from '../types'

const project: Project = { id: 1, name: 'AiShiba', path: '/tmp/a', color: '#ff0000', icon: '🐕' }

// Espelha as capabilities reais do backend (server/src/engine/{claude,codex}) —
// em produção o App carrega isto no boot via GET /api/engines.
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: '✳',
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'],
  slashSource: 'protocol', slashCommands: [],
}
const CODEX: EngineMeta = {
  id: 'codex', label: 'Codex', icon: '◆',
  models: ['', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  permissions: [],
  slashSource: 'curated', slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
}

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  useStore.setState({ engines: [CLAUDE, CODEX] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear() // o modal agora LEMBRA escolhas — sem limpar, um teste polui o próximo
})

describe('StartSessionModal', () => {
  it('renderiza com o checkbox de continuar marcado e o modo de permissão em "Pular permissões" por padrão', () => {
    render(<StartSessionModal project={project} onClose={() => {}} />)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes).toHaveLength(1)
    expect(checkboxes[0].checked).toBe(true)

    const permSelect = screen.getByLabelText(/Pular permissões/) as HTMLSelectElement
    expect(permSelect.value).toBe('bypassPermissions')
  })

  it('trocar o modo de permissão para algo diferente de bypass revela o aviso', () => {
    render(<StartSessionModal project={project} onClose={() => {}} />)
    expect(screen.queryByText(/negadas automaticamente/)).toBeNull()

    const permSelect = screen.getByLabelText(/Pular permissões/) as HTMLSelectElement
    fireEvent.change(permSelect, { target: { value: 'plan' } })

    expect(screen.getByText(/negadas automaticamente/)).toBeTruthy()
  })

  it('clicar em "Iniciar sessão" envia as flags default (continue:true, permissionMode:bypassPermissions) e abre a sessão', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      okJson({ localId: 'l1', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x' }, 201),
    )
    const onClose = vi.fn()
    render(<StartSessionModal project={project} onClose={onClose} />)

    fireEvent.click(screen.getByText('Iniciar sessão'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())

    const [url, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/projects/1/sessions')
    expect(JSON.parse(opts.body as string)).toEqual({ continueConversation: true, permissionMode: 'bypassPermissions', engine: 'claude' })

    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('l1'))
    expect(useStore.getState().view).toBe('chat')
    expect(onClose).toHaveBeenCalled()
  })

  it('renderiza o seletor de modelo com Padrão selecionado por padrão', () => {
    render(<StartSessionModal project={project} onClose={() => {}} />)
    const select = screen.getByLabelText(/Modelo/) as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('selecionar Opus e iniciar sessão envia model:"opus" no body', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      okJson({ localId: 'l3', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x' }, 201),
    )
    render(<StartSessionModal project={project} onClose={() => {}} />)

    const select = screen.getByLabelText(/Modelo/) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'opus' } })
    fireEvent.click(screen.getByText('Iniciar sessão'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())

    const opts = spy.mock.calls[0][1] as RequestInit
    expect(JSON.parse(opts.body as string)).toEqual({ continueConversation: true, permissionMode: 'bypassPermissions', model: 'opus', engine: 'claude' })
  })

  it('mantendo Padrão, iniciar sessão não envia a chave model', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      okJson({ localId: 'l4', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x' }, 201),
    )
    render(<StartSessionModal project={project} onClose={() => {}} />)

    fireEvent.click(screen.getByText('Iniciar sessão'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())

    const opts = spy.mock.calls[0][1] as RequestInit
    const parsed = JSON.parse(opts.body as string)
    expect(parsed).toEqual({ continueConversation: true, permissionMode: 'bypassPermissions', engine: 'claude' })
    expect('model' in parsed).toBe(false)
  })

  it('desmarcar continuar e escolher modo "Manual" envia continueConversation:false e permissionMode:"default"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      okJson({ localId: 'l2', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x' }, 201),
    )
    render(<StartSessionModal project={project} onClose={() => {}} />)

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText(/Pular permissões/), { target: { value: 'default' } })
    fireEvent.click(screen.getByText('Iniciar sessão'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())

    const opts = spy.mock.calls[0][1] as RequestInit
    expect(JSON.parse(opts.body as string)).toEqual({ continueConversation: false, permissionMode: 'default', engine: 'claude' })
  })

  it('mostra erro lançado pela API sem fechar o modal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    )
    const onClose = vi.fn()
    render(<StartSessionModal project={project} onClose={onClose} />)

    fireEvent.click(screen.getByText('Iniciar sessão'))

    expect(await screen.findByText('boom')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('usa o overlay temático modal-overlay', () => {
    render(<StartSessionModal project={project} onClose={() => {}} />)
    expect(document.querySelector('.modal-overlay')).toBeTruthy()
  })

  describe('seletor de engine (SP-C Task 3)', () => {
    it('mostra um botão por engine de store.engines, com Claude Code ativo por padrão', () => {
      render(<StartSessionModal project={project} onClose={() => {}} />)
      expect(screen.getByText('Claude Code')).toBeTruthy()
      expect(screen.getByText('Codex')).toBeTruthy()
      expect(screen.getByText('Claude Code').closest('.engine-picker__btn')?.className).toContain('active')
    })

    it('trocar para Codex re-popula o modelo e esconde a seção de permissão (Codex não tem)', () => {
      render(<StartSessionModal project={project} onClose={() => {}} />)
      fireEvent.click(screen.getByText('Codex'))

      expect(screen.getByText('Codex').closest('.engine-picker__btn')?.className).toContain('active')
      expect(screen.queryByLabelText(/Pular permissões/)).toBeNull()

      const select = screen.getByLabelText(/Modelo/) as HTMLSelectElement
      const optionValues = Array.from(select.options).map((o) => o.value)
      expect(optionValues).toEqual(CODEX.models)
      // modelo sem chave i18n usa o próprio id como label (ex.: gpt-5.6-sol)
      expect(screen.getByText('gpt-5.6-sol')).toBeTruthy()
    })

    it('submit com Codex selecionado envia engine:"codex" e omite permissionMode', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        okJson({ localId: 'lx', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x' }, 201),
      )
      render(<StartSessionModal project={project} onClose={() => {}} />)
      fireEvent.click(screen.getByText('Codex'))
      fireEvent.click(screen.getByText('Iniciar sessão'))
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())

      const opts = spy.mock.calls[0][1] as RequestInit
      const parsed = JSON.parse(opts.body as string)
      expect(parsed).toEqual({ continueConversation: true, engine: 'codex' })
      expect('permissionMode' in parsed).toBe(false)
    })

    it('voltar para Claude Code depois de Codex mostra a seção de permissão de novo', () => {
      render(<StartSessionModal project={project} onClose={() => {}} />)
      fireEvent.click(screen.getByText('Codex'))
      expect(screen.queryByLabelText(/Pular permissões/)).toBeNull()
      fireEvent.click(screen.getByText('Claude Code'))
      expect(screen.getByLabelText(/Pular permissões/)).toBeTruthy()
    })
  })
})

describe('engine não instalada no seletor', () => {
  it('botão da engine fica desabilitado com badge e tooltip do comando de instalação', () => {
    useStore.setState({ engines: [CLAUDE, { ...CODEX, available: false, installHint: 'npm install -g @openai/codex' }] })
    render(<StartSessionModal project={project} onClose={() => {}} />)
    const btn = screen.getByRole('button', { name: /Codex/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('npm install -g @openai/codex')
    expect(screen.getByText('não instalada')).toBeTruthy()
    // claude segue habilitado
    const claudeBtn = screen.getByRole('button', { name: /Claude Code/ }) as HTMLButtonElement
    expect(claudeBtn.disabled).toBe(false)
  })
})

describe('lembra as últimas escolhas (localStorage)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('reabre com a última engine e o último model daquela engine', () => {
    localStorage.setItem('claudinei:lastEngine', 'codex')
    localStorage.setItem('claudinei:lastModel:codex', 'gpt-5.5')
    render(<StartSessionModal project={project} onClose={() => {}} />)
    const codexBtn = screen.getByRole('button', { name: /Codex/ })
    expect(codexBtn.className).toContain('active')
    const select = screen.getByLabelText(/Modelo|Model/) as HTMLSelectElement
    expect(select.value).toBe('gpt-5.5')
  })

  it('iniciar sessão grava engine/model escolhidos', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ localId: 'n1', projectId: 1, status: 'starting' }))
    render(<StartSessionModal project={project} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/Modelo|Model/) as HTMLSelectElement, { target: { value: 'opus' } })
    fireEvent.click(screen.getByText(/Iniciar sessão|Start session/))
    await vi.waitFor(() => expect(localStorage.getItem('claudinei:lastEngine')).toBe('claude'))
    expect(localStorage.getItem('claudinei:lastModel:claude')).toBe('opus')
  })

  it('model lembrado que NÃO existe na lista da engine cai no Padrão (sem seleção inválida)', () => {
    localStorage.setItem('claudinei:lastEngine', 'claude')
    localStorage.setItem('claudinei:lastModel:claude', 'modelo-que-sumiu')
    render(<StartSessionModal project={project} onClose={() => {}} />)
    const select = screen.getByLabelText(/Modelo|Model/) as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('trocar de engine carrega o model lembrado DELA (não vaza entre engines)', () => {
    localStorage.setItem('claudinei:lastModel:codex', 'gpt-5.4')
    render(<StartSessionModal project={project} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    const select = screen.getByLabelText(/Modelo|Model/) as HTMLSelectElement
    expect(select.value).toBe('gpt-5.4')
  })
})
