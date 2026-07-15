import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewProjectModal } from '../components/NewProjectModal'

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
