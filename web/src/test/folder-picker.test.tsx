import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderPicker } from '../components/FolderPicker'

const listing = (path: string, parent: string | null, dirs: string[]) =>
  new Response(JSON.stringify({ path, parent, entries: dirs.map((d) => ({ name: d, path: `${path}/${d}`, isDir: true })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
    const u = String(url)
    if (u.includes('sub-a')) return Promise.resolve(listing('/home/u/sub-a', '/home/u', []))
    return Promise.resolve(listing('/home/u', '/home', ['sub-a', 'sub-b']))
  })
})

describe('FolderPicker', () => {
  it('lista subpastas do diretório inicial', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('sub-a')).toBeTruthy())
    expect(screen.getByText('sub-b')).toBeTruthy()
  })

  it('clicar numa subpasta navega para ela', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    fireEvent.click(screen.getByText('sub-a'))
    await waitFor(() => expect(screen.getByText('/home/u/sub-a')).toBeTruthy())
  })

  it('"Selecionar esta pasta" devolve o caminho atual', async () => {
    const onSelect = vi.fn()
    render(<FolderPicker onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    expect(onSelect).toHaveBeenCalledWith('/home/u')
  })

  it('navegar para uma subpasta e então selecionar devolve o caminho da subpasta (não o inicial)', async () => {
    const onSelect = vi.fn()
    render(<FolderPicker onSelect={onSelect} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    fireEvent.click(screen.getByText('sub-a'))
    await waitFor(() => screen.getByText('/home/u/sub-a'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    expect(onSelect).toHaveBeenCalledWith('/home/u/sub-a')
  })

  it('"Subir" fica desabilitado quando parent é null (raiz)', async () => {
    ;(globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ path: '/', parent: null, entries: [{ name: 'home', path: '/home', isDir: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText('home'))
    expect((screen.getByText('⬆ Subir') as HTMLButtonElement).disabled).toBe(true)
  })

  it('"Subir" navega para o parent quando existe', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    // o parent de /home/u é /home no mock padrão; ajustamos o mock para responder /home
    ;(globalThis.fetch as any).mockImplementation((url: any) =>
      Promise.resolve(new Response(JSON.stringify({ path: '/home', parent: '/', entries: [{ name: 'u', path: '/home/u', isDir: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    fireEvent.click(screen.getByText('⬆ Subir'))
    await waitFor(() => expect(screen.getByText('/home')).toBeTruthy())
  })

  it('erro de navegação mostra a mensagem e mantém a lista anterior', async () => {
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => screen.getByText('sub-a'))
    ;(globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'sem permissão de leitura: /x' }), { status: 400, headers: { 'Content-Type': 'application/json' } })),
    )
    fireEvent.click(screen.getByText('sub-b'))
    await waitFor(() => expect(screen.getByText(/sem permissão/)).toBeTruthy())
    // a lista anterior continua visível (não sumiu)
    expect(screen.getByText('sub-a')).toBeTruthy()
  })

  it('botão "Selecionar esta pasta" começa desabilitado antes do primeiro carregamento', () => {
    ;(globalThis.fetch as any).mockImplementation(() => new Promise(() => {})) // nunca resolve
    render(<FolderPicker onSelect={() => {}} onClose={() => {}} />)
    expect((screen.getByText('Selecionar esta pasta') as HTMLButtonElement).disabled).toBe(true)
  })
})
