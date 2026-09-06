import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { applyEvent, mergeEngineFlags } from '../chat/applyEvent'
import { isEditableUserText, lastUserTexts } from '../chat/history'
import { MessageBlock } from '../components/MessageBlock'
import { useStore } from '../store'
import type { ChatItem, ClaudeEvent } from '../types'

const skill = '<skills_instructions>\n## Skills\nUse uma skill.\n### Available skills\n- **imagegen**: gera imagens\n- `openai-docs`: documentação\n</skills_instructions>'
const event = (text = skill, fromEngine = true): ClaudeEvent => ({
  kind: 'user', ...(fromEngine ? { fromEngine: true } : {}),
  message: { role: fromEngine ? 'developer' : 'user', content: [{ type: 'text', text }] }, raw: {},
})
const originalEngines = useStore.getState().engines

afterEach(() => {
  cleanup()
  useStore.setState({ projects: [], sessions: {}, chat: {}, engines: originalEngines })
})

function show(item: ChatItem) {
  useStore.setState({
    sessions: { codex: { localId: 'codex', projectId: 1, status: 'idle', engineSessionId: 'thread', updatedAt: '', engine: 'codex' } },
    engines: [{ id: 'codex', label: 'Codex', icon: 'openai', models: [], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] } as never],
  })
  return render(<MessageBlock item={item} currentLocalId="codex" editable onEdit={vi.fn()} />)
}

describe('instruções de skills do Codex no chat', () => {
  it('usa o balão da engine com autoria e markdown, sem XML nem edição como mensagem do operador', () => {
    const items = applyEvent([], event())
    const { container } = show(items[0])
    expect(screen.getByText('by Codex')).toBeTruthy()
    expect(container.querySelector('.msg-bubble--engine')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Available skills' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('strong')?.textContent).toBe('imagegen')
    expect(container.querySelector('code')?.textContent).toBe('openai-docs')
    expect(container.textContent).not.toContain('<skills_instructions>')
    expect(container.textContent).not.toContain('</skills_instructions>')
    expect(container.querySelector('.msg-edit')).toBeNull()
    expect(isEditableUserText(items[0])).toBe(false)
    expect(lastUserTexts(items)).toEqual([])
    expect(items[0]).toMatchObject({ text: skill }) // original intacto para histórico/retag
  })

  it('mantém as mesmas tags literais quando foram digitadas pelo operador', () => {
    const items = applyEvent([], event(skill, false))
    const { container } = show(items[0])
    expect(screen.queryByText('by Codex')).toBeNull()
    expect(container.querySelector('.msg-bubble--engine')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(container.textContent).toContain(skill)
    expect(container.querySelector('.msg-edit')).toBeTruthy()
    expect(lastUserTexts(items)).toEqual([skill])
  })

  it('formata também skills longas ao expandir, preservando exemplos de código e instruções seguintes', () => {
    const body = '## Skills\n' + Array.from({ length: 16 }, (_, i) => `- skill ${i + 1}`).join('\n')
    const text = `<skills_instructions>\n${body}\n\n\u0060\u0060\u0060xml\n<skills_instructions>exemplo</skills_instructions>\n\u0060\u0060\u0060\n</skills_instructions>\n\n## Permissões\nInstruções seguintes.`
    const { container } = show(applyEvent([], event(text))[0])
    expect(screen.queryByText('skill 16')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /mostrar tudo/i }))
    expect(screen.getByText('skill 16')).toBeTruthy()
    expect(container.querySelector('pre code')?.textContent).toContain('<skills_instructions>exemplo</skills_instructions>')
    expect(screen.getByRole('heading', { name: 'Permissões' })).toBeTruthy()
    expect(screen.getByText('Instruções seguintes.')).toBeTruthy()
  })

  it('corrige a autoria de uma mensagem já carregada em sessão longa', () => {
    const previous: ChatItem[] = [{ kind: 'user_text', text: skill }]
    const updated = mergeEngineFlags(previous, applyEvent([], event()))!
    show(updated[0])
    expect(screen.getByText('by Codex')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
    expect(previous[0]).not.toHaveProperty('fromEngine')
  })
})
