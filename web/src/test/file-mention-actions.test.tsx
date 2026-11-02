import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../components/ChatInput'
import { FileOpenMenu } from '../components/FileOpenMenu'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { fetchProjectFiles } from '../api'
import type { ProjectFileListing } from '../../../shared/project-files'

/**
 * No seletor do `@!`, clicar num arquivo continua referenciando; o ⋯ da linha
 * (ou o clique direito) abre as mesmas ações do link de arquivo do chat, com
 * "Referenciar na mensagem" em primeiro. Uma ação que não referencia tira o
 * `@!` do campo e fecha o seletor.
 */
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), fetchProjectFiles: vi.fn() }))
const fetchFiles = vi.mocked(fetchProjectFiles)
const root: ProjectFileListing = { path: '', parent: null, nextOffset: null, entries: [
  { name: 'docs', path: 'docs', isDir: true }, { name: 'README.md', path: 'README.md', isDir: false },
  { name: 'app.ts', path: 'app.ts', isDir: false },
] }
const send = vi.fn()
let copied: string[]
const input = () => screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement
const type = (value: string, cursor = value.length) => fireEvent.change(input(), { target: { value, selectionStart: cursor, selectionEnd: cursor } })
const open = async (value = 'veja @!', cursor = value.length) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /><FileOpenMenu /></WsContext.Provider>)
  type(value, cursor)
  await screen.findByRole('button', { name: /^README\.md/ })
}
const picker = () => screen.queryByTestId('file-mention-menu')
const more = (name: string) => screen.getByRole('button', { name: `Mais ações: ${name}` })

beforeEach(() => {
  localStorage.clear(); send.mockReset(); fetchFiles.mockReset(); copied = []
  fetchFiles.mockResolvedValue(root)
  Object.assign(navigator, { clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve() } } })
  useStore.setState({
    projects: [{ id: 42, name: 'Projeto', path: '/project', color: '#fff', icon: '📁' }],
    sessions: { s1: { localId: 's1', projectId: 42, engine: 'codex', status: 'idle', engineSessionId: 'c', updatedAt: 'x' } },
    chat: {}, editRequest: undefined, fileMenu: null, fileViewer: null, inlineFile: null,
    engines: [{ id: 'codex', label: 'Codex', icon: 'openai', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] }],
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ações de arquivo no seletor do @!', () => {
  it('clicar no arquivo continua referenciando direto', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /^README\.md/ }))
    expect(input().value).toBe('veja "./README.md" ')
    expect(useStore.getState().fileMenu).toBeNull()
  })

  it('o ⋯ abre o menu do arquivo com Referenciar em primeiro; pastas não têm ⋯', async () => {
    await open()
    expect(screen.queryByRole('button', { name: 'Mais ações: docs' })).toBeNull()
    fireEvent.click(more('README.md'))
    const itens = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(itens[0]).toContain('Referenciar na mensagem')
    expect(itens.join('|')).toMatch(/Abrir em popup.*Ver inline no chat.*Copiar caminho.*Copiar caminho completo/)
    expect(picker()).toBeTruthy()
  })

  it('o clique direito no arquivo abre o mesmo menu', async () => {
    await open()
    fireEvent.contextMenu(screen.getByRole('button', { name: /^README\.md/ }))
    expect(screen.getByRole('menuitem', { name: /Referenciar na mensagem/ })).toBeTruthy()
  })

  it('Referenciar na mensagem faz o mesmo que clicar no arquivo', async () => {
    await open()
    fireEvent.click(more('README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Referenciar na mensagem/ }))
    expect(input().value).toBe('veja "./README.md" ')
    expect(picker()).toBeNull()
    expect(useStore.getState().fileMenu).toBeNull()
  })

  it('Abrir em popup abre o arquivo, tira o @! e fecha o seletor', async () => {
    // o cursor fica logo depois do @!, com texto em seguida
    await open('veja @! depois', 7)
    fireEvent.click(more('README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Abrir em popup/ }))
    expect(useStore.getState().fileViewer).toEqual({ path: 'README.md', kind: 'markdown', projectId: 42 })
    expect(input().value).toBe('veja  depois')
    expect(picker()).toBeNull()
  })

  it('Ver inline no chat abre no painel deste chat', async () => {
    await open()
    fireEvent.click(more('app.ts'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Ver inline no chat/ }))
    expect(useStore.getState().inlineFile).toEqual({ localId: 's1', path: 'app.ts', kind: 'code', projectId: 42 })
    expect(input().value).toBe('veja ')
    expect(picker()).toBeNull()
  })

  it('copiar os caminhos também fecha o seletor e tira o @!', async () => {
    await open()
    fireEvent.click(more('README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^.*Copiar caminho completo$/ }))
    await waitFor(() => expect(copied).toEqual(['/project/README.md']))
    expect(input().value).toBe('veja ')
    expect(picker()).toBeNull()
  })

  it('fechar só o menu de ações (clique fora ou Esc) deixa o seletor aberto', async () => {
    await open()
    fireEvent.click(more('README.md'))
    const overlay = document.querySelector('[data-file-actions]') as HTMLElement
    fireEvent.pointerDown(overlay); fireEvent.click(overlay)
    expect(useStore.getState().fileMenu).toBeNull()
    expect(picker()).toBeTruthy()

    fireEvent.click(more('README.md'))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Referenciar na mensagem/ }), { key: 'Escape' })
    expect(useStore.getState().fileMenu).toBeNull()
    expect(picker()).toBeTruthy()
    expect(input().value).toBe('veja @!')
  })

  it('pelo teclado: as setas da lista pulam o ⋯, e o menu abre focado e navega com setas e Enter', async () => {
    await open()
    const file = screen.getByRole('button', { name: /^README\.md/ })
    file.focus()
    fireEvent.keyDown(file, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^app\.ts/ }))

    fireEvent.keyDown(document.activeElement!, { key: 'ContextMenu' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Referenciar na mensagem/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Abrir em popup/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(useStore.getState().fileViewer?.path).toBe('app.ts')
    expect(picker()).toBeNull()
  })

  it('o seletor que fecha leva junto o menu de ações que ele abriu', async () => {
    await open()
    fireEvent.click(more('README.md'))
    // o chat (e o seletor com ele) sai da tela: o menu dele não pode ficar órfão
    cleanup()
    expect(useStore.getState().fileMenu).toBeNull()
  })
})
