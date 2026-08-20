import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Icon } from '../components/Icon'
import { IconPicker } from '../components/IconPicker'
import { parseIcon, iconCacheForTest } from '../icons'

/** A Iconify de mentira que o servidor expõe: /api/icons/search e /bodies. */
function fakeApi(bodies: Record<string, string> = {}, search: Record<string, string[]> = {}) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    if (u.startsWith('/api/icons/search')) {
      const q = decodeURIComponent(new URL(u, 'http://x').searchParams.get('q') ?? '')
      const icons = (search[q] ?? []).map((t) => ({ token: t, body: bodies[t] ?? `<path d="${t}"/>`, width: 24, height: 24 }))
      return new Response(JSON.stringify({ icons }), { status: 200 })
    }
    if (u.startsWith('/api/icons/bodies')) {
      const tokens = (new URL(u, 'http://x').searchParams.get('tokens') ?? '').split(',').filter(Boolean)
      const icons = tokens.filter((t) => t in bodies || !t.startsWith('sumiu'))
        .map((t) => ({ token: t, body: bodies[t] ?? `<path d="${t}"/>`, width: 24, height: 24 }))
      return new Response(JSON.stringify({ icons }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { fn: fn as unknown as typeof globalThis.fetch, calls, batches: () => calls.filter((c) => c.includes('/bodies')) }
}

let api: ReturnType<typeof fakeApi>
beforeEach(() => {
  localStorage.clear()
  iconCacheForTest.clear()
  api = fakeApi()
  vi.spyOn(globalThis, 'fetch').mockImplementation(api.fn)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('o que uma string de ícone quer dizer', () => {
  it('emoji continua sendo emoji (nada foi migrado)', () => {
    expect(parseIcon('📁')).toEqual({ kind: 'emoji', char: '📁' })
    expect(parseIcon('')).toEqual({ kind: 'emoji', char: '' })
  })

  it('prefixo:nome é um token do acervo', () => {
    expect(parseIcon('mdi:server')).toEqual({ kind: 'iconify', token: 'mdi:server' })
    expect(parseIcon('material-symbols:rocket-launch')).toEqual({ kind: 'iconify', token: 'material-symbols:rocket-launch' })
  })

  /**
   * O que já está gravado no banco não pode virar quadrado vazio. `si:` e `lu:`
   * eram os prefixos dos dois acervos embutidos; no Iconify os mesmos desenhos
   * atendem por `simple-icons:` e `lucide:`, com os MESMOS nomes — então a
   * migração é uma tradução de prefixo, e o banco não é tocado.
   */
  it('os prefixos antigos continuam valendo, traduzidos', () => {
    expect(parseIcon('si:react')).toEqual({ kind: 'iconify', token: 'simple-icons:react' })
    expect(parseIcon('lu:terminal')).toEqual({ kind: 'iconify', token: 'lucide:terminal' })
  })

  it('coisa que não é token nem emoji não vira requisição', () => {
    expect(parseIcon('não:válido!').kind).toBe('emoji')
  })
})

describe('desenhar o ícone', () => {
  it('emoji não vai à rede', async () => {
    render(<Icon value="📁" />)
    expect(screen.getByText('📁')).toBeTruthy()
    expect(api.batches()).toHaveLength(0)
  })

  it('token busca o desenho e pinta', async () => {
    render(<Icon value="mdi:server" />)
    await waitFor(() => expect(document.querySelector('svg.icon')).toBeTruthy())
    expect(document.querySelector('svg.icon')!.innerHTML).toContain('mdi:server')
  })

  /**
   * A sidebar tem um ícone por terminal. Sem juntar, abrir o app dispararia uma
   * requisição por cartão — o motivo de existir um lote.
   */
  it('vários ícones na tela viram UMA requisição', async () => {
    render(<><Icon value="mdi:server" /><Icon value="lucide:box" /><Icon value="ph:cloud" /></>)
    await waitFor(() => expect(api.batches().length).toBeGreaterThan(0))
    expect(api.batches()).toHaveLength(1)
    expect(api.batches()[0]).toContain('mdi:server')
    expect(api.batches()[0]).toContain('ph:cloud')
  })

  it('o mesmo ícone duas vezes não é pedido duas vezes', async () => {
    render(<><Icon value="mdi:server" /><Icon value="mdi:server" /></>)
    await waitFor(() => expect(api.batches().length).toBe(1))
    expect(api.batches()[0].match(/mdi:server/g)).toHaveLength(1)
  })

  /** Recarregar a página não pode reacender a rede para o que já se viu. */
  it('o desenho sobrevive ao reload sem nova requisição', async () => {
    render(<Icon value="mdi:server" />)
    await waitFor(() => expect(document.querySelector('svg.icon')).toBeTruthy())
    cleanup()
    iconCacheForTest.reloadFromDisk()
    api.calls.length = 0
    render(<Icon value="mdi:server" />)
    expect(document.querySelector('svg.icon')!.innerHTML).toContain('mdi:server')
    expect(api.batches()).toHaveLength(0)
  })

  /** Enquanto não chega, o espaço fica reservado: a linha não pode pular depois. */
  it('sem o desenho ainda, ocupa o mesmo espaço', () => {
    const { container } = render(<Icon value="mdi:server" size={20} />)
    expect((container.firstChild as HTMLElement).style.width).toBe('20px')
  })

  /** Token que não existe mais não pode virar laço de pedidos. */
  it('ícone que sumiu do acervo é pedido uma vez só', async () => {
    render(<Icon value="sumiu:mesmo" />)
    await waitFor(() => expect(api.batches().length).toBe(1))
    cleanup()
    render(<Icon value="sumiu:mesmo" />)
    await new Promise((r) => setTimeout(r, 10))
    expect(api.batches()).toHaveLength(1)
  })
})

describe('o seletor', () => {
  const abrir = (search: Record<string, string[]>) => {
    api = fakeApi({}, search)
    vi.spyOn(globalThis, 'fetch').mockImplementation(api.fn)
    const onSelect = vi.fn()
    render(<IconPicker onSelect={onSelect} onClose={() => {}} />)
    return onSelect
  }

  /**
   * O defeito relatado: "o Search tem que ser global e não ficar trocando de aba
   * buscando e buscando". Uma caixa, todos os acervos.
   */
  it('uma busca só varre o acervo inteiro', async () => {
    abrir({ financeiro: ['lucide:wallet', 'mdi:cash', 'ph:bank'] })
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'financeiro' } })
    await waitFor(() => expect(screen.getAllByTestId('icon-cell').length).toBe(3))
  })

  /** Saber de onde veio o desenho é o que permite escolher um traço coerente. */
  it('os resultados vêm agrupados por acervo', async () => {
    abrir({ caixa: ['lucide:box', 'lucide:package', 'mdi:box'] })
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'caixa' } })
    await waitFor(() => expect(screen.getAllByTestId('icon-group').length).toBe(2))
    const [primeiro] = screen.getAllByTestId('icon-group')
    expect(within(primeiro).getAllByTestId('icon-cell')).toHaveLength(2)
  })

  it('escolher devolve o token', async () => {
    const onSelect = abrir({ box: ['lucide:box'] })
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'box' } })
    await waitFor(() => expect(screen.getAllByTestId('icon-cell').length).toBe(1))
    fireEvent.click(screen.getAllByTestId('icon-cell')[0])
    expect(onSelect).toHaveBeenCalledWith('lucide:box')
  })

  it('sem resultado, diz que não achou em vez de ficar em branco', async () => {
    abrir({ xyzzy: [] })
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'xyzzy' } })
    await waitFor(() => expect(screen.getByTestId('icon-empty')).toBeTruthy())
  })

  /** O emoji continua ali, e é o único acervo que não depende de rede. */
  it('o emoji continua sendo uma opção', () => {
    abrir({})
    expect(screen.getByTestId('icon-tab-emoji')).toBeTruthy()
  })

  /** Quem já usa emoji abre no emoji; quem usa desenho abre na busca. */
  it('abre onde está o ícone que já foi escolhido', () => {
    render(<IconPicker value="📁" onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('icon-tab-emoji').className).toMatch(/\bon\b/)
    cleanup()
    render(<IconPicker value="mdi:server" onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('icon-tab-search').className).toMatch(/\bon\b/)
  })

  /** Grade vazia não ensina nada: antes de digitar, há de onde partir. */
  it('antes de digitar já mostra sugestões', () => {
    abrir({})
    expect(screen.getAllByTestId('icon-cell').length).toBeGreaterThan(10)
  })
})
