import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { fetchProjectFiles } from '../api'
import { applyFileMention, mentionAt } from '../mentions'
import { extractCandidatePaths, splitCandidatePaths } from '../files'
import type { ProjectFileListing } from '../../../shared/project-files'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), fetchProjectFiles: vi.fn() }))
const fetchFiles = vi.mocked(fetchProjectFiles)
const root: ProjectFileListing = { path: '', parent: null, nextOffset: null, entries: [
  { name: 'src', path: 'src', isDir: true }, { name: 'README', path: 'README', isDir: false },
] }
const sub: ProjectFileListing = { path: 'src', parent: '', nextOffset: null, entries: [
  { name: 'ação "nova".tsx', path: 'src/ação "nova".tsx', isDir: false },
] }
const send = vi.fn()
const input = () => screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement
const search = () => screen.getByRole('textbox', { name: 'Buscar nesta pasta…' })
const type = (value: string, cursor = value.length) => fireEvent.change(input(), { target: { value, selectionStart: cursor, selectionEnd: cursor } })
const open = () => render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
beforeEach(() => {
  localStorage.clear(); send.mockReset(); fetchFiles.mockReset()
  fetchFiles.mockImplementation(async (_id, path) => path === 'src' ? sub : root)
  useStore.setState({
    projects: [{ id: 42, name: 'Projeto local', path: '/project', color: '#fff', icon: '📁' }],
    sessions: { s1: { localId: 's1', projectId: 42, engine: 'codex', status: 'idle', engineSessionId: 'c', updatedAt: 'x' } },
    chat: {}, editRequest: undefined,
    engines: [{ id: 'codex', label: 'Codex', icon: 'openai', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] }],
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('@! como referência local', () => {
  it('só reconhece o gatilho junto ao cursor e no começo de palavra', () => {
    expect(mentionAt('veja @!', 7, '@!')).toBe(5)
    expect(mentionAt('x@!', 3, '@!')).toBeNull()
    expect(mentionAt('@! depois', 9, '@!')).toBeNull()
    expect(mentionAt('@@', 2, '@!')).toBeNull()
  })
  it('mantém nomes exatos, links do chat e rascunhos com espaços, aspas e sem extensão', () => {
    for (const path of ['README', '.env', 'src/ação "nova".tsx', 'docs/a\\b.txt']) {
      const reference = applyFileMention('veja @! agora', 7, path)
      expect(reference.text).toBe(`veja ${JSON.stringify(`./${path}`)}  agora`)
      expect(extractCandidatePaths(reference.text)).toEqual([`./${path}`])
      expect(splitCandidatePaths(reference.text).find(segment => segment.path)?.path).toBe(`./${path}`)
    }
    expect(applyFileMention('texto mudou', 2, 'a.txt').text).toBe('texto mudou')
  })
  it('abre na raiz, entra na pasta e insere o caminho no cursor sem enviar a mensagem', async () => {
    open(); type('veja @! depois', 7)
    expect(document.activeElement).toBe(search())
    await screen.findByRole('button', { name: /src Pasta/ })
    expect(fetchFiles).toHaveBeenCalledWith(42, '', '', 0, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: /src Pasta/ }))
    fireEvent.click(await screen.findByRole('button', { name: /ação.*Arquivo/ }))
    expect(input().value).toBe('veja "./src/ação \\"nova\\".tsx"  depois')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(send).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(input()))
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'veja "./src/ação \\"nova\\".tsx"  depois' })
  })
  it('permite navegar por teclado, voltar à raiz e cancelar sem alterar o rascunho', async () => {
    open(); type('@!')
    await screen.findByRole('button', { name: /src Pasta/ })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /src Pasta/ }))
    fireEvent.click(document.activeElement!)
    await screen.findByRole('button', { name: /ação.*Arquivo/ })
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à pasta anterior' }))
    await screen.findByRole('button', { name: /README Arquivo/ })
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(input().value).toBe('@!')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(input())
  })
  it('ignora respostas antigas e permite limpar a busca', async () => {
    let late!: (value: ProjectFileListing) => void
    fetchFiles.mockImplementation((_id, _path, query) => query === 'old'
      ? new Promise(resolve => { late = resolve }) : Promise.resolve(root))
    open(); type('@!')
    await screen.findByRole('button', { name: /README Arquivo/ })
    fireEvent.change(search(), { target: { value: 'old' } })
    await waitFor(() => expect(late).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }))
    await screen.findByRole('button', { name: /README Arquivo/ })
    await act(async () => late({ ...root, entries: [] }))
    expect(screen.getByRole('button', { name: /README Arquivo/ })).toBeTruthy()
  })
  it('não consulta nem seleciona durante composição e Enter encerra apenas a composição', async () => {
    open(); type('@!')
    await screen.findByRole('button', { name: /README Arquivo/ })
    const before = fetchFiles.mock.calls.length
    fireEvent.compositionStart(search())
    fireEvent.change(search(), { target: { value: 'ação' } })
    fireEvent.keyDown(search(), { key: 'Enter', isComposing: true })
    await new Promise(resolve => setTimeout(resolve, 330))
    expect(fetchFiles).toHaveBeenCalledTimes(before)
    expect(input().value).toBe('@!')
    fireEvent.compositionEnd(search())
    await waitFor(() => expect(fetchFiles).toHaveBeenCalledTimes(before + 1))
  })
  it('mostra erro com retry e diferencia pasta vazia', async () => {
    fetchFiles.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...root, entries: [] })
    open(); type('@!')
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Esta pasta está vazia.')).toBeTruthy()
    expect(input().value).toBe('@!')
  })
  it('retém a referência no rascunho ao remontar e não depende de um mapa de anexos', async () => {
    const first = open(); type('@!')
    fireEvent.click(await screen.findByRole('button', { name: /README Arquivo/ }))
    first.unmount(); open()
    expect(input().value).toBe('"./README" ')
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: '"./README"' })
  })
  it('mantém itens anteriores durante paginação e acumula os resultados sem duplicatas', async () => {
    let nextPage!: (data: ProjectFileListing) => void
    fetchFiles.mockResolvedValueOnce({ ...root, nextOffset: 100 }).mockImplementationOnce(() => new Promise(resolve => { nextPage = resolve }))
    open(); type('@!')
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }))
    await waitFor(() => expect(nextPage).toBeDefined())
    expect((screen.getByRole('button', { name: /README Arquivo/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => nextPage({ ...root, entries: [...root.entries, { name: '.env', path: '.env', isDir: false }] }))
    expect(screen.getAllByRole('button', { name: /README Arquivo/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /.env Arquivo/ }))
    expect(input().value).toBe('"./.env" ')
  })
})
