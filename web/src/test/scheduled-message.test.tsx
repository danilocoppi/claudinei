import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { applyEvent } from '../chat/applyEvent'
import { MessageBlock } from '../components/MessageBlock'
import type { ChatItem, ClaudeEvent } from '../types'

const userEvent = (text: string): ClaudeEvent =>
  ({ kind: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, raw: {} })

const reduce = (...events: ClaudeEvent[]) => events.reduce(applyEvent, [] as ChatItem[])

afterEach(() => cleanup())

/**
 * A mensagem agendada entra pelo mesmo canal de uma digitada (o backend escreve no
 * stdin da CLI), então no transcript o selo do prefixo é o único sinal que sobra de
 * que não foi o operador que escreveu — igual ao `[Task from …]` que já existia.
 */
describe('mensagem de agendamento no transcript', () => {
  it('vira um item próprio, com nome, número da execução e corpo', () => {
    const [item] = reduce(userEvent('[Agendamento: Preços do produto X #14]: Busque o produto e liste as 3 lojas'))
    expect(item).toEqual({
      kind: 'scheduled_message',
      name: 'Preços do produto X',
      run: 14,
      text: 'Busque o produto e liste as 3 lojas',
    })
  })

  it('aceita corpo com várias linhas e markdown', () => {
    const [item] = reduce(userEvent('[Agendamento: Diário #1]: linha 1\n\n- item\n- outro'))
    expect(item.kind).toBe('scheduled_message')
    expect((item as Extract<ChatItem, { kind: 'scheduled_message' }>).text).toBe('linha 1\n\n- item\n- outro')
  })

  it('não confunde com texto do operador que só menciona agendamento', () => {
    const [item] = reduce(userEvent('crie um Agendamento: Preços #1 pra mim'))
    expect(item.kind).toBe('user_text')
  })

  it('não engole a task de outro terminal', () => {
    const [item] = reduce(userEvent('[Task from Alpha]: revise o PR'))
    expect(item.kind).toBe('task_message')
  })
})

describe('bolha da mensagem agendada', () => {
  const item: ChatItem = { kind: 'scheduled_message', name: 'Preços do produto X', run: 14, text: '# Busque\nas **3 lojas**' }

  it('mostra o selo com o nome do agendamento e o número da execução', () => {
    render(<MessageBlock item={item} />)
    expect(screen.getByText(/Preços do produto X/)).toBeTruthy()
    expect(screen.getByText(/#14/)).toBeTruthy()
  })

  it('tem identidade própria — nem a do operador, nem a da task de outro terminal', () => {
    const { container } = render(<MessageBlock item={item} />)
    const bubble = container.querySelector('.msg-bubble')!
    expect(bubble.className).toMatch(/msg-bubble--scheduled/)
    expect(bubble.className).not.toMatch(/msg-bubble--task/)
  })

  it('renderiza o corpo como markdown, não como texto cru', () => {
    const { container } = render(<MessageBlock item={item} />)
    expect(container.querySelector('.markdown h1')).toBeTruthy()
    expect(container.querySelector('.markdown strong')?.textContent).toBe('3 lojas')
  })

  it('não oferece o lápis de editar (não foi o operador que escreveu)', () => {
    render(<MessageBlock item={item} />)
    expect(screen.queryByTitle(/editar/i)).toBeNull()
  })
})
