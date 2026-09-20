import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { useStore } from '../store'

vi.mock('../components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) => (
    <>
      <textarea data-testid="code-editor" value={value} onChange={(e) => onChange(e.target.value)} />
      {/* o keymap Mod-s é do CodeMirror; aqui se testa a LIGAÇÃO dele com a gravação */}
      <button type="button" data-testid="atalho-salvar" onClick={onSave}>atalho</button>
    </>
  ),
}))

const { TextDocument } = await import('../components/TextDocument')

const respostaDeLeitura = (texto: string, hash: string | null = 'h1') =>
  new Response(texto, { status: 200, headers: hash ? { 'X-Content-Hash': hash } : {} })

const montar = (props: Record<string, unknown> = {}) =>
  render(<TextDocument kind="markdown" url="/api/files/content?path=doc.md" name="doc.md" path="doc.md" projectId={1} {...props} />)

beforeEach(() => { useStore.setState({ fileEditDirty: false }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('TextDocument — quando o lápis aparece', () => {
  it('markdown com projeto: aparece', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar()
    expect(await screen.findByRole('button', { name: /Editar/ })).toBeTruthy()
  })

  it('sem projeto: não aparece (o servidor recusaria a gravação)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar({ projectId: undefined })
    await screen.findByText('oi')
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull()
  })

  it('sem hash no header: não aparece (não dá para provar qual versão foi lida)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi', null))
    montar()
    await screen.findByText('oi')
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull()
  })
})

describe('TextDocument — editar e salvar', () => {
  it('editar abre o editor com o conteúdo lido', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('# oi'))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('# oi')
  })

  it('digitar marca como sujo; salvar manda o baseHash e limpa a marca', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('# oi', 'hash-lido'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'hash-novo' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: '# mudou' } })
    expect(useStore.getState().fileEditDirty).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    const corpo = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)
    expect(corpo).toEqual({ path: 'doc.md', projectId: 1, content: '# mudou', baseHash: 'hash-lido' })
  })

  it('salvar duas vezes usa o hash devolvido na primeira', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValue(new Response(JSON.stringify({ hash: 'h2' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'c' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    expect(JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string).baseHash).toBe('h2')
  })

  it('409: mostra o aviso de arquivo alterado e mantém o texto editado', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'minha versão' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText(/mudou no disco/i)).toBeTruthy()
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('minha versão')
    expect(useStore.getState().fileEditDirty).toBe(true)
  })

  it('recarregar depois do conflito traz a versão do disco e limpa o aviso', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(respostaDeLeitura('versão do agente', 'h9'))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'minha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Recarregar' }))
    await waitFor(() => expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('versão do agente'))
    expect(useStore.getState().fileEditDirty).toBe(false)
  })

  it('o atalho do editor (Ctrl+S) grava igual ao botão', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respostaDeLeitura('a', 'h1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'h2' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'b' } })
    fireEvent.click(screen.getByTestId('atalho-salvar'))
    await waitFor(() => expect(useStore.getState().fileEditDirty).toBe(false))
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string).content).toBe('b')
  })

  it('desmontar sujo limpa a marca do store (não fica travando o modal seguinte)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaDeLeitura('a', 'h1'))
    const { unmount } = montar()
    fireEvent.click(await screen.findByRole('button', { name: /Editar/ }))
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'b' } })
    unmount()
    expect(useStore.getState().fileEditDirty).toBe(false)
  })
})
