import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import i18n from '../i18n'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'

afterEach(() => { void i18n.changeLanguage('pt-BR') }) // devolve o default dos testes

describe('i18n', () => {
  it('resolve a mesma chave nas 3 línguas', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('sidebar.terminals')).toBe('Terminals')
    await i18n.changeLanguage('es')
    expect(i18n.t('sidebar.terminals')).toBe('Terminales')
    await i18n.changeLanguage('pt-BR')
    expect(i18n.t('sidebar.terminals')).toBe('Terminais')
  })

  it('interpola variáveis', async () => {
    await i18n.changeLanguage('pt-BR')
    expect(i18n.t('confirm.deleteTitle', { name: 'Alpha' })).toBe('Excluir Alpha?')
  })

  it('persiste a troca no localStorage', async () => {
    await i18n.changeLanguage('es')
    expect(localStorage.getItem('claudinei.locale')).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it('tem as chaves do microfone nas 3 línguas', async () => {
    for (const lng of ['en', 'es', 'pt-BR'] as const) {
      await i18n.changeLanguage(lng)
      for (const k of ['mic.start', 'mic.stop', 'mic.errTranscribe', 'mic.transcribing', 'mic.errPermission', 'mic.errCapture', 'mic.errLowSignal'] as const) {
        expect(i18n.t(k), `${k} em ${lng}`).not.toBe(k) // resolveu (não devolveu a própria chave)
      }
    }
    await i18n.changeLanguage('pt-BR')
  })
})

describe('LanguageSwitcher', () => {
  afterEach(() => cleanup())

  it('abre o menu, troca para inglês e a sidebar re-renderiza', async () => {
    useStore.setState({ projects: [], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, view: 'dashboard', activeLocalId: undefined })
    render(<Sidebar />)
    expect(screen.getByText('Terminais')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Idioma'))
    fireEvent.click(screen.getByText('English'))
    expect(await screen.findByText('Terminals')).toBeTruthy()
  })

  it('marca o idioma ativo com ✓', async () => {
    await i18n.changeLanguage('es')
    render(<LanguageSwitcher />)
    fireEvent.click(screen.getByLabelText('Idioma'))
    const active = screen.getByText('Español').closest('.lang-menu__item')
    expect(active?.querySelector('.lang-menu__check')).toBeTruthy()
  })
})
