import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import i18n from '../i18n'
import { localizeServerError } from '../serverErrors'
import { deleteProject } from '../api'
import { useStore } from '../store'

/**
 * O servidor manda o texto em português e, nos erros que chegam à tela, um
 * código estável. A interface mostra a mensagem no idioma escolhido; sem
 * tradução para o código, mostra o texto, como antes.
 */
afterEach(async () => { await i18n.changeLanguage('pt-BR'); vi.restoreAllMocks() })

describe('localizeServerError', () => {
  it('traduz pelo código, com os parâmetros', async () => {
    await i18n.changeLanguage('en')
    expect(localizeServerError({ error: 'a pasta já existe: /x/app', code: 'folder_exists', params: { path: '/x/app' } }))
      .toBe('The folder already exists: /x/app')
    await i18n.changeLanguage('es')
    expect(localizeServerError({ error: 'x', code: 'session_already_active', params: { project: 'Vaexa' } }))
      .toBe('El terminal Vaexa ya tiene una sesión activa.')
  })

  it('sem tradução para o código, ou sem código, mostra o texto do servidor', async () => {
    await i18n.changeLanguage('en')
    expect(localizeServerError({ error: 'algo novo', code: 'codigo_que_nao_existe' })).toBe('algo novo')
    expect(localizeServerError({ error: 'mensagem antiga' })).toBe('mensagem antiga')
  })

  it('erro que já era um código (forbidden, "file too large") também é traduzido', async () => {
    await i18n.changeLanguage('en')
    expect(localizeServerError({ error: 'forbidden' })).toBe('Not allowed.')
    expect(localizeServerError({ error: 'file too large' })).toBe('File too large.')
  })
})

describe('onde a tela mostra os erros', () => {
  it('as chamadas da API lançam a mensagem no idioma da tela', async () => {
    await i18n.changeLanguage('en')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'não foi possível finalizar todas as sessões; o terminal não foi excluído', code: 'sessions_not_stopped', params: {}, sessions: [],
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    await expect(deleteProject(1, { stopSessions: true })).rejects.toThrow("Couldn't end all sessions; the terminal was not deleted.")
  })

  it('o erro que chega pelo WebSocket entra na conversa no idioma da tela', async () => {
    await i18n.changeLanguage('en')
    useStore.setState({ chat: {}, sessions: {} })
    useStore.getState().applyWsMessage({ type: 'error', localId: 'l1', message: 'sessão l1 não está ativa', code: 'session_not_active', params: {} })
    const itens = useStore.getState().chat['l1'] ?? []
    expect(JSON.stringify(itens)).toContain('This session is not active.')
  })
})
