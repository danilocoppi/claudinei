import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { FileOpenMenu } from '../components/FileOpenMenu'
import { useStore } from '../store'
import * as api from '../api'

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

describe('FileOpenMenu — pasta', () => {
  const folderMenu = { x: 10, y: 10, path: 'docs/hoanglong/', kind: 'folder' as const, projectId: 1, localId: 's1' }
  const labels = () => screen.getAllByRole('menuitem').map((item) => item.lastElementChild?.textContent)

  it('mostra só copiar, copiar completo e abrir a pasta', () => {
    useStore.setState({ fileMenu: folderMenu })
    render(<FileOpenMenu />)
    expect(labels()).toEqual(['Copiar caminho', 'Copiar caminho completo', 'Abrir a pasta'])
    expect(screen.queryByText('Abrir em popup')).toBeNull()
    expect(screen.queryByText('Ver inline no chat')).toBeNull()
  })

  it('o cabeçalho mostra o nome da pasta, não o caminho inteiro', () => {
    useStore.setState({ fileMenu: folderMenu })
    render(<FileOpenMenu />)
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('hoanglong')
    expect(document.querySelector('.sess-pop__eyebrow')?.textContent).toBe('hoanglong')
  })

  it('abrir a pasta chama revealFile com o caminho da pasta', () => {
    const reveal = vi.spyOn(api, 'revealFile').mockResolvedValue(undefined as never)
    useStore.setState({ fileMenu: folderMenu })
    render(<FileOpenMenu />)
    fireEvent.click(screen.getByText('Abrir a pasta'))
    expect(reveal).toHaveBeenCalledWith('docs/hoanglong/', 1)
  })

  it('sem acesso local, só os dois de copiar', () => {
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hostname: '192.168.0.9' } as Location)
    useStore.setState({ fileMenu: folderMenu })
    render(<FileOpenMenu />)
    expect(labels()).toEqual(['Copiar caminho', 'Copiar caminho completo'])
  })
})
