import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import App from '../App'
import { useStore } from '../store'

afterEach(() => cleanup())

describe('App', () => {
  it('renderiza', () => {
    // Sem isso o boot fica em authStatus 'loading' (App devolve null): o gate
    // de auth é testado em auth-screen.test.tsx, aqui só queremos o app pronto.
    useStore.setState({ authStatus: 'ready', view: 'dashboard' })
    render(<App />)
    expect(screen.getByText(/Claudinei/)).toBeTruthy()
  })

  // O relato foi "abri a conversa no celular e não tenho como voltar para a
  // lista". A gaveta sempre esteve lá atrás do ☰, mas um ☰ genérico não diz
  // que ali está o caminho de volta — quem entra numa conversa procura VOLTAR.
  it('na conversa, a topbar do celular oferece VOLTAR', () => {
    useStore.setState({ authStatus: 'ready', view: 'chat' })
    render(<App />)
    expect(screen.getByLabelText('Voltar para a lista de terminais')).toBeTruthy()
  })

  it('no terminal também (a mesma visão de detalhe)', () => {
    useStore.setState({ authStatus: 'ready', view: 'terminal' })
    render(<App />)
    expect(screen.getByLabelText('Voltar para a lista de terminais')).toBeTruthy()
  })

  it('fora das visões de detalhe continua sendo o ☰', () => {
    useStore.setState({ authStatus: 'ready', view: 'dashboard' })
    render(<App />)
    expect(screen.getByLabelText('Abrir menu')).toBeTruthy()
    expect(screen.queryByLabelText('Voltar para a lista de terminais')).toBeNull()
  })
})
