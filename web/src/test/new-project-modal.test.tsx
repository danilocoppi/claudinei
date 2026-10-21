import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewProjectModal } from '../components/NewProjectModal'
import { useStore } from '../store'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: any, init: any) => {
    const u = String(url)
    if (u.includes('/api/fs/list')) {
      return Promise.resolve(new Response(JSON.stringify({ path: '/home/u', parent: '/home', entries: [{ name: 'proj', path: '/home/u/proj', isDir: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    if (u.endsWith('/api/projects') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ id: 1, name: 'P', path: '/home/u/proj', color: '#7c5cff', icon: '📁' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })
})

describe('NewProjectModal', () => {
  it('preview reflete o nome digitado', () => {
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Meu App' } })
    // o preview mostra o nome
    expect(screen.getAllByText('Meu App').length).toBeGreaterThan(0)
  })

  it('escolher pasta pelo FolderPicker preenche o caminho e permite criar', async () => {
    const onClose = vi.fn()
    render(<NewProjectModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'P' } })
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    await waitFor(() => expect(screen.getByText('/home/u')).toBeTruthy())
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sem pasta escolhida, Criar fica desabilitado', () => {
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'P' } })
    expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(true)
  })

  it('clicar no backdrop do FolderPicker fecha só o picker, não o modal (mantém os dados)', async () => {
    const onClose = vi.fn()
    render(<NewProjectModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Preservar' } })
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    // clica no overlay do picker (o elemento com a classe modal-overlay mais interno)
    const overlays = document.querySelectorAll('.modal-overlay')
    const pickerOverlay = overlays[overlays.length - 1] as HTMLElement
    fireEvent.click(pickerOverlay)
    // o modal pai continua aberto (onClose NÃO foi chamado) e o nome preservado
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('Nome do projeto') as HTMLInputElement).value).toBe('Preservar')
  })

  it('pasta que já tem terminal: avisa, mas deixa criar', async () => {
    useStore.setState({ projects: [{ id: 9, name: 'Existente', path: '/home/u', color: '#fff', icon: '📁' } as any] })
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Segundo' } })
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    await waitFor(() => screen.getByText(/já tem um terminal/i))
    // Aviso, não erro: o botão continua ativo.
    expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(false)
    useStore.setState({ projects: [] })
  })

  it('pasta livre não mostra aviso nenhum', async () => {
    useStore.setState({ projects: [{ id: 9, name: 'Outro', path: '/outro/lugar', color: '#fff', icon: '📁' } as any] })
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    expect(screen.queryByText(/já tem um terminal/i)).toBeNull()
    useStore.setState({ projects: [] })
  })

  describe('pasta padrão', () => {
    const PADRAO = '/home/u/Projects'
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    /** Servidor com pasta padrão configurada; `criar` responde o POST de /api/projects. */
    const servidor = (criar: () => Response = () => json({ id: 1, name: 'P', path: `${PADRAO}/x`, color: '#7c5cff', icon: '📁' }, 201)) =>
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        const u = String(url)
        if (u === '/api/settings/default-folder') return json({ path: PADRAO, effective: PADRAO, missing: false })
        if (u.includes('/api/fs/list')) return json({ path: PADRAO, parent: '/home/u', entries: [] })
        if (u === '/api/projects' && init?.method === 'POST') return criar()
        return json([])
      })
    const nome = () => screen.getByPlaceholderText('Nome do projeto')
    const corpoDoPost = (spy: { mock: { calls: unknown[][] } }) =>
      JSON.parse(String((spy.mock.calls.find(([u, i]) => String(u) === '/api/projects' && (i as RequestInit)?.method === 'POST')![1] as RequestInit).body))

    it('vem com a pasta padrão preenchida e já permite criar', async () => {
      servidor()
      render(<NewProjectModal onClose={() => {}} />)
      await waitFor(() => expect(screen.getByText(PADRAO)).toBeTruthy())
      fireEvent.change(nome(), { target: { value: 'P' } })
      expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(false)
    })

    it('trocar a pasta abre o seletor dentro da pasta padrão', async () => {
      const spy = servidor()
      render(<NewProjectModal onClose={() => {}} />)
      await waitFor(() => screen.getByText(PADRAO))
      fireEvent.click(screen.getByText(PADRAO))
      await waitFor(() => screen.getByText('Selecionar esta pasta'))
      expect(spy.mock.calls.some(([u]) => String(u) === `/api/fs/list?path=${encodeURIComponent(PADRAO)}`)).toBe(true)
    })

    it('pasta nova: o nome acompanha o terminal até ser editado e vai como newFolder', async () => {
      const spy = servidor()
      const onClose = vi.fn()
      render(<NewProjectModal onClose={onClose} />)
      await waitFor(() => screen.getByText(PADRAO))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Criar pasta nova dentro desta' }))
      const pasta = () => screen.getByRole('textbox', { name: 'Nome da nova pasta' }) as HTMLInputElement
      fireEvent.change(nome(), { target: { value: 'Meu App' } })
      expect(pasta().value).toBe('meu-app')
      expect(screen.getByText(`Será criada: ${PADRAO}/meu-app`)).toBeTruthy()
      fireEvent.change(pasta(), { target: { value: 'app-x' } })
      fireEvent.change(nome(), { target: { value: 'Meu App 2' } })
      expect(pasta().value).toBe('app-x')
      fireEvent.click(screen.getByText('Criar'))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(corpoDoPost(spy)).toMatchObject({ name: 'Meu App 2', path: PADRAO, newFolder: 'app-x' })
    })

    it('pasta escolhida antes de a padrão chegar não é trocada pela resposta atrasada', async () => {
      let liberar: (r: Response) => void = () => {}
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url)
        if (u === '/api/settings/default-folder') return new Promise<Response>((r) => { liberar = r })
        if (u.includes('/api/fs/list')) return json({ path: '/outra', parent: '/', entries: [] })
        return json([])
      })
      render(<NewProjectModal onClose={() => {}} />)
      fireEvent.click(screen.getByText('Escolher pasta…'))
      await waitFor(() => screen.getByText('Selecionar esta pasta'))
      fireEvent.click(screen.getByText('Selecionar esta pasta'))
      await waitFor(() => screen.getByText('/outra'))
      liberar(json({ path: PADRAO, effective: PADRAO, missing: false }))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.getByText('/outra')).toBeTruthy()
      expect(screen.queryByText(PADRAO)).toBeNull()
    })

    it('pasta nova sem nome deixa Criar desabilitado', async () => {
      servidor()
      render(<NewProjectModal onClose={() => {}} />)
      await waitFor(() => screen.getByText(PADRAO))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Criar pasta nova dentro desta' }))
      fireEvent.change(nome(), { target: { value: '!!!' } })
      expect((screen.getByRole('textbox', { name: 'Nome da nova pasta' }) as HTMLInputElement).value).toBe('')
      expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(true)
    })

    it('pasta que já existe: o erro do servidor aparece e o modal fica', async () => {
      servidor(() => json({ error: `a pasta já existe: ${PADRAO}/meu-app` }, 409))
      const onClose = vi.fn()
      render(<NewProjectModal onClose={onClose} />)
      await waitFor(() => screen.getByText(PADRAO))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Criar pasta nova dentro desta' }))
      fireEvent.change(nome(), { target: { value: 'Meu App' } })
      fireEvent.click(screen.getByText('Criar'))
      await waitFor(() => expect(screen.getByText(/a pasta já existe/)).toBeTruthy())
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('modo edição: pré-preenche, trava o path e salva via PATCH', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 7, name: 'Novo Nome', path: '/tmp/x', color: '#111111', icon: '🚀' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    render(<NewProjectModal onClose={() => {}} editProject={{ id: 7, name: 'Velho', path: '/tmp/x', color: '#222222', icon: '📁' }} />)
    expect(screen.getByText('Editar terminal')).toBeTruthy()
    expect((screen.getByPlaceholderText('Nome do projeto') as HTMLInputElement).value).toBe('Velho')
    expect(screen.getByText('/tmp/x')).toBeTruthy() // path visível mas não clicável p/ trocar
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Novo Nome' } })
    fireEvent.click(screen.getByText('Salvar'))
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/projects/7', expect.objectContaining({ method: 'PATCH' })))
    spy.mockRestore()
  })
})

describe('NewProjectModal — onde fica o terminal novo', () => {
  type Call = { url: string; method: string; body: any }
  let calls: Call[]
  let falharAtribuicao = 0

  const json = (b: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }))

  beforeEach(() => {
    calls = []
    falharAtribuicao = 0
    useStore.setState({
      projects: [],
      sectors: [{ id: 3, name: 'Clientes' }],
      groups: [{ id: 7, name: 'Backend', sectorId: 3 }, { id: 8, name: 'Solto' }],
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: any, init: any) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined })
      if (u.endsWith('/api/projects') && method === 'POST') return json({ id: 42, name: 'P', path: '/p', color: '#7c5cff', icon: '📁' }, 201)
      if (u.endsWith('/api/groups') && method === 'POST') return json({ id: 90, name: 'Novo' }, 201)
      if (u.endsWith('/api/sectors') && method === 'POST') return json({ id: 91, name: 'Novo' }, 201)
      if (/\/api\/projects\/42\/(group|sector)$/.test(u) && method === 'PATCH') {
        if (falharAtribuicao > 0) { falharAtribuicao--; return json({ error: 'falhou' }, 500) }
        return json({ ok: true })
      }
      if (u === '/api/settings/default-folder') return json({ path: '/p', effective: '/p', missing: false })
      return json([])
    })
  })

  const preencher = async () => {
    render(<NewProjectModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'P' } })
    await waitFor(() => expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(false))
  }
  let onClose = vi.fn()
  beforeEach(() => { onClose = vi.fn() })
  const escolher = (v: string) => fireEvent.change(screen.getByTestId('new-terminal-placement'), { target: { value: v } })
  const posts = (re: RegExp) => calls.filter((c) => re.test(c.url) && c.method !== 'GET')

  it('padrão é solto: cria o terminal e não mexe em grupo nem setor', async () => {
    await preencher()
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/(group|sector)s?$/)).toHaveLength(0)
  })

  it('grupo existente: lista com o setor no rótulo e atribui depois de criar', async () => {
    await preencher()
    expect(screen.getByText('Clientes › Backend')).toBeTruthy()
    escolher('group:7')
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/api\/projects\/42\/group$/)[0].body).toEqual({ groupId: 7 })
  })

  it('setor existente', async () => {
    await preencher()
    escolher('sector:3')
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/api\/projects\/42\/sector$/)[0].body).toEqual({ sectorId: 3 })
  })

  it('novo setor: exige nome, cria e coloca o terminal nele', async () => {
    await preencher()
    escolher('new-sector')
    expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('new-terminal-place-name'), { target: { value: 'Pessoal' } })
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/api\/sectors$/)[0].body).toEqual({ name: 'Pessoal' })
    expect(posts(/\/api\/projects\/42\/sector$/)[0].body).toEqual({ sectorId: 91 })
  })

  it('novo grupo dentro de um setor: cria o grupo, move para o setor e coloca o terminal', async () => {
    await preencher()
    escolher('new-group')
    fireEvent.change(screen.getByTestId('new-terminal-place-name'), { target: { value: 'APIs' } })
    fireEvent.change(screen.getByTestId('new-terminal-group-sector'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/api\/groups$/)[0].body).toEqual({ name: 'APIs' })
    expect(posts(/\/api\/groups\/90\/sector$/)[0].body).toEqual({ sectorId: 3 })
    expect(posts(/\/api\/projects\/42\/group$/)[0].body).toEqual({ groupId: 90 })
  })

  /** A 2ª etapa falhou: tentar de novo não pode criar outro terminal nem outro grupo. */
  it('falha ao posicionar: avisa, e a retentativa refaz só o que faltou', async () => {
    falharAtribuicao = 1
    await preencher()
    escolher('new-group')
    fireEvent.change(screen.getByTestId('new-terminal-place-name'), { target: { value: 'APIs' } })
    fireEvent.click(screen.getByText('Criar'))
    await waitFor(() => expect(screen.getByText(/O terminal foi criado/)).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Tentar de novo'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posts(/\/api\/projects$/)).toHaveLength(1)
    expect(posts(/\/api\/groups$/)).toHaveLength(1)
    expect(posts(/\/api\/projects\/42\/group$/)).toHaveLength(2)
  })

  it('edição não mostra o campo (mover um terminal existente é pelo menu ⋯)', () => {
    render(<NewProjectModal onClose={() => {}} editProject={{ id: 1, name: 'P', path: '/p', color: '#7c5cff', icon: '📁' } as never} />)
    expect(screen.queryByTestId('new-terminal-placement')).toBeNull()
  })
})
