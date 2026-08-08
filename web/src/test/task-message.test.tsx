import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MessageBlock } from '../components/MessageBlock'
import { useStore } from '../store'
import type { ChatItem } from '../types'

const task = (text: string, from = 'AIFinex - Frontend'): ChatItem =>
  ({ kind: 'task_message', from, text })

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️' }],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, fileResolved: {},
  })
})
afterEach(() => cleanup())

describe('MessageBlock — task de outro terminal', () => {
  it('mostra o chip com o terminal de origem', () => {
    render(<MessageBlock item={task('faça algo')} />)
    expect(screen.getByText(/AIFinex - Frontend/)).toBeTruthy()
  })

  it('renderiza o corpo como markdown, não como texto cru', () => {
    const { container } = render(<MessageBlock item={task('**negrito** normal')} />)
    expect(container.querySelector('strong')?.textContent).toBe('negrito')
    expect(container.textContent).not.toContain('**negrito**')
  })

  it('renderiza bloco de código markdown', () => {
    const { container } = render(<MessageBlock item={task('```js\nconst a = 1\n```')} />)
    expect(container.querySelector('code')).toBeTruthy()
  })

  it('usa a bolha própria de task, distinta da bolha do usuário', () => {
    const { container } = render(<MessageBlock item={task('x')} />)
    expect(container.querySelector('.msg-bubble--task')).toBeTruthy()
  })

  it('não oferece editar — a task não foi digitada pelo operador', () => {
    render(<MessageBlock item={task('x')} onEdit={() => {}} />)
    expect(screen.queryByLabelText(/editar/i)).toBeNull()
  })

  it('mensagem digitada de verdade continua oferecendo editar', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'oi' }} onEdit={() => {}} />)
    expect(screen.queryByLabelText(/editar/i)).toBeTruthy()
  })
})
