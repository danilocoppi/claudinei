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
    render(<MessageBlock item={{ kind: 'user_text', text: 'oi' }} editable onEdit={() => {}} />)
    expect(screen.queryByLabelText(/editar/i)).toBeTruthy()
  })
})

describe('MessageBlock — conteúdo injetado pela engine (skills)', () => {
  const injected = (text: string): ChatItem => ({ kind: 'user_text', text, fromEngine: true })

  it('renderiza markdown: títulos viram heading, não "#" literal', () => {
    const { container } = render(<MessageBlock item={injected('# Frontend Design\n\ntexto')} />)
    expect(container.querySelector('h1')?.textContent).toBe('Frontend Design')
    expect(container.textContent).not.toContain('# Frontend Design')
  })

  it('renderiza negrito e lista do corpo da skill', () => {
    const { container } = render(<MessageBlock item={injected('**forte**\n\n- um\n- dois')} />)
    expect(container.querySelector('strong')?.textContent).toBe('forte')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('mantém a bolha de engine (marcação de que não foi digitado)', () => {
    const { container } = render(<MessageBlock item={injected('# t')} />)
    expect(container.querySelector('.msg-bubble--engine')).toBeTruthy()
  })

  // Regressão: o que o operador DIGITA continua literal — um "#" ou "*" no meio de
  // um caminho não pode virar título ou itálico sozinho.
  it('mensagem digitada pelo operador NÃO interpreta markdown', () => {
    const { container } = render(<MessageBlock item={{ kind: 'user_text', text: '# nao vira titulo' }} />)
    expect(container.querySelector('h1')).toBeNull()
    expect(container.textContent).toContain('# nao vira titulo')
  })
})

describe('MessageBlock — instrução enviada a um subagente', () => {
  const toSub = (text: string): ChatItem => ({ kind: 'user_text', text, fromSubagent: true })

  it('renderiza markdown do prompt, não "##" literal', () => {
    const { container } = render(<MessageBlock item={toSub('## Task Description\n\ncorpo')} />)
    expect(container.querySelector('h2')?.textContent).toBe('Task Description')
    expect(container.textContent).not.toContain('## Task Description')
  })

  it('renderiza lista e código inline do prompt', () => {
    const { container } = render(<MessageBlock item={toSub('- `utils/cookies.js` (AUTH)\n- outro')} />)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('code')?.textContent).toBe('utils/cookies.js')
  })

  it('usa bolha própria, distinta da do operador e da de engine', () => {
    const { container } = render(<MessageBlock item={toSub('x')} />)
    expect(container.querySelector('.msg-bubble--subagent')).toBeTruthy()
    expect(container.querySelector('.msg-bubble--engine')).toBeNull()
  })

  // Mira no chip em si: o wrapper "↳ subagente" já contém essa palavra, então
  // buscar só pelo texto passaria mesmo sem o chip existir.
  it('mostra o chip identificando que é instrução ao subagente', () => {
    const { container } = render(<MessageBlock item={toSub('x')} />)
    expect(container.querySelector('.msg-subagent__to')?.textContent).toMatch(/instrução ao subagente/i)
  })

  it('não oferece editar — não foi o operador que escreveu', () => {
    render(<MessageBlock item={toSub('x')} onEdit={() => {}} />)
    expect(screen.queryByLabelText(/editar/i)).toBeNull()
  })

  it('mantém o wrapper de subagente que já existia', () => {
    const { container } = render(<MessageBlock item={toSub('x')} />)
    expect(container.textContent).toMatch(/subagent/i)
  })
})
