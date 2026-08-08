import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { FileOpenMenu } from '../components/FileOpenMenu'
import { useStore } from '../store'

const ROOT = '/home/coppi/Projects/alfa'
let copied: string[]

beforeEach(() => {
  copied = []
  Object.assign(navigator, {
    clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve() } },
  })
  useStore.setState({
    projects: [{ id: 1, name: 'Alfa', path: ROOT, color: '#f00', icon: '🅰️' }],
    fileMenu: { x: 10, y: 10, path: 'engine/sizing.js', kind: 'text', projectId: 1, localId: 's1' },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('FileOpenMenu — copiar caminhos', () => {
  it('copia o caminho relativo ao projeto', async () => {
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Copiar caminho'))
    await vi.waitFor(() => expect(copied).toEqual(['engine/sizing.js']))
  })

  it('copia o caminho completo juntando a raiz do projeto', async () => {
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Copiar caminho completo'))
    await vi.waitFor(() => expect(copied).toEqual([`${ROOT}/engine/sizing.js`]))
  })

  it('normaliza para relativo quando o path veio absoluto', async () => {
    useStore.setState({ fileMenu: { x: 0, y: 0, path: `${ROOT}/engine/sizing.js`, kind: 'text', projectId: 1 } })
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Copiar caminho'))
    await vi.waitFor(() => expect(copied).toEqual(['engine/sizing.js']))
  })
})

describe('FileOpenMenu — abrir na pasta', () => {
  // jsdom serve em localhost, então o item aparece.
  it('mostra a opção quando o acesso é local', () => {
    render(<FileOpenMenu />)
    expect(screen.queryByText('Abrir na pasta')).toBeTruthy()
  })

  it('esconde a opção quando o acesso NÃO é local', () => {
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hostname: '192.168.0.9' } as Location)
    render(<FileOpenMenu />)
    expect(screen.queryByText('Abrir na pasta')).toBeNull()
  })

  it('mantém os itens de abrir que já existiam', () => {
    render(<FileOpenMenu />)
    expect(screen.queryByText(/popup/i)).toBeTruthy()
  })
})
