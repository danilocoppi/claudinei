import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// As rotas das páginas espiadas: cada `viewPage` devolve um token novo.
vi.mock('../pages/api', async (orig) => ({
  ...(await orig<typeof import('../pages/api')>()),
  viewPage: vi.fn(),
  fetchPagesSettings: vi.fn(),
  savePagesSettings: vi.fn(),
}))
// O menu do terminal busca apps locais e ações ao abrir.
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchLocalApps: vi.fn(async () => ({})),
  fetchActions: vi.fn(async () => []),
}))

import { fetchPagesSettings, savePagesSettings, viewPage } from '../pages/api'
import { usePagesStore } from '../pages/pagesStore'
import { useStore } from '../store'
import { TerminalMenu } from '../components/TerminalMenu'
import { PageCard } from '../components/PageCard'
import { PageFullscreenHost } from '../components/PageFullscreen'
import { UserMenu } from '../components/UserMenu'
import { VisualPagesSettings } from '../components/VisualPagesSettings'
import i18n from '../i18n'
import ptBR from '../i18n/pt-BR'
import en from '../i18n/en'
import es from '../i18n/es'
import type { VisualPageDto } from '../../../shared/visual-pages'
import type { Project } from '../types'

const PG1 = 'pg_0000000000000001'
const PG2 = 'pg_0000000000000002'
const page = (id: string, over: Partial<VisualPageDto> = {}): VisualPageDto => ({
  id, projectId: 1, engine: 'claude', localId: 'a', conversationId: 'c', turnId: 1, turnKey: 'faça',
  title: 'Gráfico', height: null, bytes: 3000, source: 'html', createdAt: '2026-11-21 12:00:00', ...over,
})
const project = { id: 1, name: 'Alvo', path: '/tmp/alvo' } as Project

const AVISO = 'Com a rede liberada, o código de qualquer página visual pode mandar o que estiver nela (inclusive dados do projeto que o agente pôs ali) para qualquer endereço da internet, carregar código de qualquer site e tentar alcançar outros aparelhos da rede de quem a abrir. A página continua sem acesso à sua sessão e à API do Claudinei. Vale para todas as páginas, de todos os terminais e usuários, a partir da próxima vez que forem abertas.'

// ── IntersectionObserver dublado: só avisa quando o teste manda ──
interface FakeObs { cb: IntersectionObserverCallback; els: Set<Element> }
let observers: FakeObs[] = []
class FakeIO {
  private o: FakeObs
  constructor(cb: IntersectionObserverCallback) { this.o = { cb, els: new Set() }; observers.push(this.o) }
  observe(el: Element) { this.o.els.add(el) }
  unobserve(el: Element) { this.o.els.delete(el) }
  disconnect() { this.o.els.clear(); observers = observers.filter(x => x !== this.o) }
  takeRecords() { return [] }
  root = null
  rootMargin = ''
  thresholds: number[] = []
}
/** Todos os cartões observados entram na tela. */
function tela() {
  act(() => {
    for (const o of [...observers]) for (const el of [...o.els]) {
      o.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver)
    }
  })
}

const view = vi.mocked(viewPage)
const fetchSettings = vi.mocked(fetchPagesSettings)
const saveSettings = vi.mocked(savePagesSettings)
let tok = 0
const urlOf = (id: string, n: number) => `/api/pages/view/${id}/t${n}`

beforeEach(async () => {
  await i18n.changeLanguage('pt-BR')
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  tok = 0
  view.mockReset()
  view.mockImplementation(async (id: string) => ({ url: urlOf(id, ++tok) }))
  fetchSettings.mockReset()
  saveSettings.mockReset()
  usePagesStore.setState({ byLocal: {}, byId: {}, livePageId: null, livePlace: 'chat', fullPageId: null })
  useStore.setState({ groups: [], sectors: [], authStatus: 'ready', me: { setupRequired: false, id: 1, username: 'root', isAdmin: true, projectIds: [] } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const duas = () => {
  const a = page(PG1, { title: 'Primeira' })
  const b = page(PG2, { title: 'Segunda' })
  usePagesStore.setState({ byLocal: { a: [a, b] }, byId: { [PG1]: a, [PG2]: b } })
}

describe('menu do terminal: Páginas desta conversa', () => {
  it('no chat com 2 páginas: item "Páginas desta conversa (2)"', () => {
    duas()
    render(<TerminalMenu project={project} localId="a" x={0} y={0} onDone={() => {}} />)
    screen.getByText('Páginas desta conversa (2)')
  })

  it('sem páginas (lista vazia ou não carregada) ou sem localId (cartão da lateral): sem item', () => {
    usePagesStore.setState({ byLocal: { a: [] } })
    const { unmount } = render(<TerminalMenu project={project} localId="a" x={0} y={0} onDone={() => {}} />)
    expect(screen.queryByText(/Páginas desta conversa/)).toBeNull()
    unmount()
    const r2 = render(<TerminalMenu project={project} localId="b" x={0} y={0} onDone={() => {}} />)
    expect(screen.queryByText(/Páginas desta conversa/)).toBeNull()
    r2.unmount()
    duas()
    render(<TerminalMenu project={project} x={0} y={0} onDone={() => {}} />)
    expect(screen.queryByText(/Páginas desta conversa/)).toBeNull()
  })
})

describe('lista das páginas da conversa', () => {
  const abreLista = () => {
    duas()
    const onDone = vi.fn()
    render(<>
      {/* O cartão da mesma página no chat, atrás do diálogo. */}
      <div data-testid="chat"><PageCard pageId={PG1} localId="a" /></div>
      <TerminalMenu project={project} localId="a" x={0} y={0} onDone={onDone} />
      <PageFullscreenHost />
    </>)
    fireEvent.click(screen.getByText('Páginas desta conversa (2)'))
    return { dialog: screen.getByRole('dialog', { name: 'Páginas desta conversa' }), onDone }
  }

  it('um cartão por página, em ordem de criação', () => {
    const { dialog } = abreLista()
    const titles = [...dialog.querySelectorAll('.page-card__title')].map(e => e.textContent)
    expect(titles).toEqual(['Primeira', 'Segunda'])
  })

  it('abrir monta o iframe no diálogo (não no chat); tela cheia e nova aba pedem token novo', async () => {
    const { dialog } = abreLista()
    const primeira = within(dialog).getByText('Primeira').closest<HTMLElement>('.page-card')!
    fireEvent.click(within(primeira).getByRole('button', { name: 'Ver página' }))
    tela()
    const f = await waitFor(() => {
      const el = dialog.querySelector('iframe')
      expect(el?.getAttribute('src')).toBeTruthy()
      return el!
    })
    expect(f.getAttribute('src')).toBe(urlOf(PG1, 1))
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    // O cartão da mesma página no chat continua parado: uma viva por vez.
    const chat = screen.getByTestId('chat')
    expect(chat.querySelector('iframe')).toBeNull()
    within(chat).getByRole('button', { name: 'Ver página' })

    // Nova aba: token novo.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(within(primeira).getByRole('button', { name: 'Nova aba' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(urlOf(PG1, 2), '_blank', 'noopener,noreferrer'))

    // Tela cheia: token novo, por cima do diálogo.
    fireEvent.click(within(primeira).getByRole('button', { name: 'Tela cheia' }))
    const full = screen.getByRole('dialog', { name: 'Primeira' })
    await waitFor(() => expect(full.querySelector('iframe')?.getAttribute('src')).toBe(urlOf(PG1, 3)))
    expect(view).toHaveBeenCalledTimes(3)
    // Esc fecha só a tela cheia; a lista continua.
    fireEvent.keyDown(full, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Primeira' })).toBeNull()
    screen.getByRole('dialog', { name: 'Páginas desta conversa' })
  })

  it('o cartão do chat aberto vira parado quando outra abre na lista; o ✕ do diálogo fecha o menu', async () => {
    const { dialog, onDone } = abreLista()
    act(() => usePagesStore.getState().setLive(PG1))
    tela()
    const chat = screen.getByTestId('chat')
    await waitFor(() => expect(chat.querySelector('iframe')).toBeTruthy())
    expect(dialog.querySelector('iframe')).toBeNull()
    const segunda = within(dialog).getByText('Segunda').closest<HTMLElement>('.page-card')!
    fireEvent.click(within(segunda).getByRole('button', { name: 'Ver página' }))
    tela()
    await waitFor(() => expect(segunda.querySelector('iframe')).toBeTruthy())
    expect(chat.querySelector('iframe')).toBeNull()
    // O × do diálogo fecha o menu inteiro.
    fireEvent.click(dialog.querySelector<HTMLElement>('.pages-dialog__close')!)
    expect(onDone).toHaveBeenCalled()
  })

  it('fechar o diálogo (desmontar) solta a página viva da lista', async () => {
    duas()
    const { PagesListDialog } = await import('../components/PagesListDialog')
    const { unmount } = render(<PagesListDialog localId="a" onClose={() => {}} />)
    fireEvent.click(within(screen.getByText('Primeira').closest<HTMLElement>('.page-card')!).getByRole('button', { name: 'Ver página' }))
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    unmount()
    expect(usePagesStore.getState().livePageId).toBeNull()
  })
})

describe('menu do usuário: Páginas visuais', () => {
  it('admin vê o item e ele abre o diálogo', async () => {
    fetchSettings.mockResolvedValue({ network: 'cdn' })
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /root/i }))
    fireEvent.click(screen.getByText('Páginas visuais'))
    await screen.findByRole('dialog', { name: 'Páginas visuais' })
  })

  it('não-admin não vê o item', () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false, projectIds: [1] } })
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /ana/i }))
    expect(screen.queryByText('Páginas visuais')).toBeNull()
  })
})

describe('diálogo Páginas visuais', () => {
  it('carrega cdn; marcar Liberar a rede mostra o aviso verbatim; Salvar manda open e fecha', async () => {
    fetchSettings.mockResolvedValue({ network: 'cdn' })
    saveSettings.mockResolvedValue({ network: 'open' })
    const onClose = vi.fn()
    render(<VisualPagesSettings onClose={onClose} />)
    const cdn = await screen.findByRole('radio', { name: 'Só as CDNs conhecidas (padrão)' })
    await waitFor(() => expect((cdn as HTMLInputElement).checked).toBe(true))
    expect(screen.queryByText(AVISO)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Liberar a rede' }))
    screen.getByText(AVISO)
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith('open'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('já aberta: o aviso aparece de cara; voltar ao padrão o esconde', async () => {
    fetchSettings.mockResolvedValue({ network: 'open' })
    render(<VisualPagesSettings onClose={() => {}} />)
    await screen.findByText(AVISO)
    fireEvent.click(screen.getByRole('radio', { name: 'Só as CDNs conhecidas (padrão)' }))
    expect(screen.queryByText(AVISO)).toBeNull()
  })

  it('erro ao salvar aparece no diálogo, que continua aberto', async () => {
    fetchSettings.mockResolvedValue({ network: 'cdn' })
    saveSettings.mockRejectedValue(Object.assign(new Error('Só o admin altera'), { status: 403 }))
    const onClose = vi.fn()
    render(<VisualPagesSettings onClose={onClose} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Liberar a rede' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Só o admin altera')
    expect(onClose).not.toHaveBeenCalled()
    screen.getByRole('dialog', { name: 'Páginas visuais' })
  })

  it('erro ao carregar aparece e Salvar fica desligado', async () => {
    fetchSettings.mockRejectedValue(new Error('caiu'))
    render(<VisualPagesSettings onClose={() => {}} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('caiu')
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

/** As chaves de um namespace, achatadas (`a.b`). */
function keysOf(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`])
}

describe('i18n das páginas', () => {
  it('as chaves pages.* existem nas três línguas', async () => {
    const pt = keysOf(ptBR.pages)
    expect(keysOf(en.pages).sort()).toEqual([...pt].sort())
    expect(keysOf(es.pages).sort()).toEqual([...pt].sort())
    for (const k of ['listItem', 'listTitle', 'settingsItem', 'settingsTitle', 'networkCdn', 'networkOpen', 'openWarning']) {
      expect(pt).toContain(k)
    }
    for (const lng of ['pt-BR', 'en', 'es'] as const) {
      await i18n.changeLanguage(lng)
      for (const k of pt) expect(i18n.t(`pages.${k}` as never), `pages.${k} em ${lng}`).not.toBe(`pages.${k}`)
    }
    await i18n.changeLanguage('pt-BR')
    expect(i18n.t('pages.openWarning')).toBe(AVISO)
    expect(i18n.t('pages.listItem', { n: 3 })).toBe('Páginas desta conversa (3)')
    // "Abrir a rede" em inglês soava como abrir uma rede; a opção libera todo acesso à rede.
    expect(i18n.t('pages.networkOpen')).toBe('Liberar a rede')
    expect(en.pages.networkOpen).toBe('Allow all network access')
    expect(es.pages.networkOpen).toBe('Permitir todo el acceso a la red')
  })
})
