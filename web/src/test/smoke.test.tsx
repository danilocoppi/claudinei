import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'
import { useStore } from '../store'

describe('App', () => {
  it('renderiza', () => {
    // Sem isso o boot fica em authStatus 'loading' (App devolve null): o gate
    // de auth é testado em auth-screen.test.tsx, aqui só queremos o app pronto.
    useStore.setState({ authStatus: 'ready' })
    render(<App />)
    expect(screen.getByText(/Claudinei/)).toBeTruthy()
  })
})
