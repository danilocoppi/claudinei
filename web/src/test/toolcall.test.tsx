import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCallCard } from '../components/ToolCallCard'
import { DiffView } from '../components/DiffView'

describe('ToolCallCard', () => {
  it('Bash: recolhido mostra comando resumido; expandido mostra output', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls -la' }, result: 'total 0\narquivo.txt' }} />)
    expect(screen.getByText(/ls -la/)).toBeTruthy()
    expect(screen.queryByText(/arquivo.txt/)).toBeNull()
    fireEvent.click(screen.getByText(/Bash/))
    expect(screen.getByText(/arquivo.txt/)).toBeTruthy()
  })

  it('Edit expandido mostra diff', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't2', name: 'Edit',
      input: { file_path: '/x.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }} />)
    fireEvent.click(screen.getByText(/Edit/))
    expect(screen.getByText('- const a = 1')).toBeTruthy()
    expect(screen.getByText('+ const a = 2')).toBeTruthy()
  })

  it('resultado pendente mostra spinner textual', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't3', name: 'Read', input: { file_path: '/y' } }} />)
    fireEvent.click(screen.getByText(/Read/))
    expect(screen.getByText(/executando/)).toBeTruthy()
  })

  it('MultiEdit expandido mostra um diff por edit', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't4', name: 'MultiEdit',
      input: { file_path: '/x.ts', edits: [
        { old_string: 'a1', new_string: 'b1' },
        { old_string: 'a2', new_string: 'b2' },
      ] } }} />)
    fireEvent.click(screen.getByText(/MultiEdit/))
    expect(screen.getByText('- a1')).toBeTruthy()
    expect(screen.getByText('+ b1')).toBeTruthy()
    expect(screen.getByText('- a2')).toBeTruthy()
    expect(screen.getByText('+ b2')).toBeTruthy()
  })

  it('Write não mostra linha vermelha espúria (oldText vazio)', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't5', name: 'Write',
      input: { file_path: '/y.txt', content: 'novo' } }} />)
    fireEvent.click(screen.getByText(/Write/))
    expect(screen.getByText('+ novo')).toBeTruthy()
    expect(screen.queryByText(/^- /)).toBeNull()
  })
})

describe('DiffView', () => {
  it('marca linhas removidas e adicionadas', () => {
    render(<DiffView oldText={'a\nb'} newText={'c'} />)
    expect(screen.getByText('- a')).toBeTruthy()
    expect(screen.getByText('- b')).toBeTruthy()
    expect(screen.getByText('+ c')).toBeTruthy()
  })
})

describe('botão de copiar (comando/resultado)', () => {
  const withClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('Bash expandido tem copiar no comando (copia SÓ o comando) e no resultado', async () => {
    const writeText = withClipboard()
    render(<ToolCallCard item={{ kind: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'npm test' }, result: 'tudo verde' }} />)
    fireEvent.click(screen.getByText(/Bash/))
    const buttons = document.querySelectorAll('.copy-btn')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]) // área do comando
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test'))
    fireEvent.click(buttons[1]) // área do resultado
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('tudo verde'))
  })

  it('Edit expandido tem copiar do conteúdo NOVO do diff', async () => {
    const writeText = withClipboard()
    render(<ToolCallCard item={{ kind: 'tool_call', id: 'c2', name: 'Edit',
      input: { file_path: '/x.ts', old_string: 'a', new_string: 'b' }, result: 'ok' }} />)
    fireEvent.click(screen.getByText(/Edit/))
    const buttons = document.querySelectorAll('.copy-btn')
    fireEvent.click(buttons[0])
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('b'))
  })

  it('feedback visual: após copiar o botão marca copied', async () => {
    withClipboard()
    render(<ToolCallCard item={{ kind: 'tool_call', id: 'c3', name: 'Bash', input: { command: 'ls' }, result: 'x' }} />)
    fireEvent.click(screen.getByText(/Bash/))
    const btn = document.querySelector('.copy-btn')!
    fireEvent.click(btn)
    await vi.waitFor(() => expect(btn.className).toContain('copied'))
  })
})
