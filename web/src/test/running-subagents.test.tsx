import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { RunningSubagents } from '../components/RunningSubagents'
import type { ChatItem } from '../types'

const agent = (id: string, description: string, type = 'general-purpose', result?: string): ChatItem => ({
  kind: 'tool_call', id, name: 'Agent',
  input: { description, subagent_type: type, prompt: `tarefa completa de ${description}` },
  ...(result ? { result } : {}),
})

const act = (parentId: string, name: string): ChatItem =>
  ({ kind: 'tool_call', id: `${parentId}-${name}`, name, input: {}, fromSubagent: true, parentId })

afterEach(() => cleanup())

describe('RunningSubagents', () => {
  it('não renderiza nada sem subagente em execução', () => {
    const { container } = render(<RunningSubagents items={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('não renderiza nada quando o subagente já terminou', () => {
    const { container } = render(<RunningSubagents items={[agent('t1', 'x', 'general-purpose', 'pronto')]} />)
    expect(container.innerHTML).toBe('')
  })

  it('mostra a contagem de subagentes trabalhando', () => {
    render(<RunningSubagents items={[agent('t1', 'Um'), agent('t2', 'Dois')]} />)
    expect(screen.getByText(/2 subagentes/i)).toBeTruthy()
  })

  it('usa singular com um só', () => {
    render(<RunningSubagents items={[agent('t1', 'Um')]} />)
    expect(screen.getByText(/1 subagente\b/i)).toBeTruthy()
  })

  it('lista a descrição de cada subagente', () => {
    render(<RunningSubagents items={[agent('t1', 'Mapear ALPHA'), agent('t2', 'Scaffold')]} />)
    expect(screen.getByText('Mapear ALPHA')).toBeTruthy()
    expect(screen.getByText('Scaffold')).toBeTruthy()
  })

  it('começa recolhido: o prompt não aparece antes do clique', () => {
    render(<RunningSubagents items={[agent('t1', 'Mapear ALPHA')]} />)
    expect(screen.queryByText(/tarefa completa de Mapear ALPHA/)).toBeNull()
  })

  it('clicar no chip revela o prompt e o tipo do subagente', () => {
    render(<RunningSubagents items={[agent('t1', 'Mapear ALPHA', 'Explore')]} />)
    fireEvent.click(screen.getByText('Mapear ALPHA'))
    expect(screen.getByText(/tarefa completa de Mapear ALPHA/)).toBeTruthy()
    expect(screen.getByText('Explore')).toBeTruthy()
  })

  it('mostra a atividade daquele subagente ao expandir', () => {
    render(<RunningSubagents items={[agent('t1', 'Um'), act('t1', 'Read'), act('t1', 'Edit')]} />)
    fireEvent.click(screen.getByText('Um'))
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('Edit')).toBeTruthy()
  })

  it('não mistura a atividade de subagentes diferentes', () => {
    render(<RunningSubagents items={[agent('t1', 'Um'), agent('t2', 'Dois'), act('t1', 'Read'), act('t2', 'Grep')]} />)
    fireEvent.click(screen.getByText('Um'))
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.queryByText('Grep')).toBeNull()
  })

  it('clicar de novo recolhe', () => {
    render(<RunningSubagents items={[agent('t1', 'Um')]} />)
    fireEvent.click(screen.getByText('Um'))
    expect(screen.getByText(/tarefa completa/)).toBeTruthy()
    fireEvent.click(screen.getByText('Um'))
    expect(screen.queryByText(/tarefa completa/)).toBeNull()
  })
})

/**
 * Subagente de background: continua rodando DEPOIS que o turno que o despachou
 * fecha, e seu tool_call já recebeu resultado no despacho — a detecção pelo chat
 * não o alcança. O servidor manda a lista pelo status da sessão.
 */
describe('RunningSubagents — tasks em background', () => {
  const bg = (id: string, description: string, type = 'general-purpose', prompt = '') => ({ id, description, type, prompt })

  it('lista a task de background mesmo sem nada pendente no chat', () => {
    render(<RunningSubagents items={[]} backgroundTasks={[bg('a1', 'Contar de 1 a 5')]} />)
    expect(screen.getByText('Contar de 1 a 5')).toBeTruthy()
    expect(screen.getByText(/1 subagente\b/i)).toBeTruthy()
  })

  it('soma background com os de primeiro plano na contagem', () => {
    render(<RunningSubagents items={[agent('t1', 'Primeiro plano')]} backgroundTasks={[bg('a1', 'Em background')]} />)
    expect(screen.getByText(/2 subagentes/i)).toBeTruthy()
    expect(screen.getByText('Primeiro plano')).toBeTruthy()
    expect(screen.getByText('Em background')).toBeTruthy()
  })

  it('não duplica quando a mesma task aparece nas duas fontes', () => {
    render(<RunningSubagents items={[agent('a1', 'Mesma')]} backgroundTasks={[bg('a1', 'Mesma')]} />)
    expect(screen.getByText(/1 subagente\b/i)).toBeTruthy()
    expect(screen.getAllByText('Mesma')).toHaveLength(1)
  })

  it('nada a mostrar sem chat pendente e sem background', () => {
    const { container } = render(<RunningSubagents items={[]} backgroundTasks={[]} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('RunningSubagents — painel sem conteúdo', () => {
  it('mostra o prompt da task de background ao expandir', () => {
    render(<RunningSubagents items={[]} backgroundTasks={[{ id: 'a1', description: 'Tokens', type: 'Explore', prompt: 'gere os tokens de tema' }]} />)
    fireEvent.click(screen.getByText('Tokens'))
    expect(screen.getByText('gere os tokens de tema')).toBeTruthy()
  })

  /** Sem tipo, sem prompt e sem atividade o painel saía como um retângulo vazio. */
  it('avisa em vez de abrir um painel em branco', () => {
    const { container } = render(<RunningSubagents items={[]} backgroundTasks={[{ id: 'a1', description: 'Só descrição', type: '', prompt: '' }]} />)
    fireEvent.click(screen.getByText('Só descrição'))
    const detail = container.querySelector('.subagent__detail')
    expect(detail).toBeTruthy()
    expect(detail?.textContent?.trim()).not.toBe('')
  })
})

describe('RunningSubagents — parar um subagente pelo chip', () => {
  it('oferece o ✕ apenas em task de background (é a que tem task_id)', () => {
    render(<RunningSubagents items={[agent('t1', 'Primeiro plano')]}
      backgroundTasks={[{ id: 'a1', description: 'Em background', type: '', prompt: '' }]}
      onStopTask={() => {}} />)
    expect(screen.getByTitle(/parar em background/i)).toBeTruthy()
    expect(screen.queryByTitle(/parar primeiro plano/i)).toBeNull()
  })

  it('clicar no ✕ para aquele subagente', () => {
    const stopped: string[] = []
    render(<RunningSubagents items={[]}
      backgroundTasks={[{ id: 'a1', description: 'Um', type: '', prompt: '' }, { id: 'a2', description: 'Dois', type: '', prompt: '' }]}
      onStopTask={(id) => stopped.push(id)} />)
    fireEvent.click(screen.getByTitle(/parar dois/i))
    expect(stopped).toEqual(['a2'])
  })

  it('sem handler, não mostra o ✕', () => {
    render(<RunningSubagents items={[]} backgroundTasks={[{ id: 'a1', description: 'Um', type: '', prompt: '' }]} />)
    expect(screen.queryByTitle(/parar um/i)).toBeNull()
  })

  it('o ✕ não abre nem fecha o detalhe do chip', () => {
    render(<RunningSubagents items={[]}
      backgroundTasks={[{ id: 'a1', description: 'Um', type: 'Explore', prompt: 'faça' }]}
      onStopTask={() => {}} />)
    fireEvent.click(screen.getByTitle(/parar um/i))
    expect(screen.queryByText('faça')).toBeNull()
  })
})

describe('RunningSubagents — markdown no detalhe', () => {
  const md = '**Leia primeiro** e edite `src/pages/login/index.jsx`\n\n- item um\n- item dois'

  it('renderiza negrito do prompt em vez de mostrar os asteriscos', () => {
    const { container } = render(<RunningSubagents items={[]}
      backgroundTasks={[{ id: 'a1', description: 'Task 13', type: 'general-purpose', prompt: md }]} />)
    fireEvent.click(screen.getByText('Task 13'))
    expect(container.querySelector('.subagent__prompt strong')?.textContent).toBe('Leia primeiro')
    expect(container.textContent).not.toContain('**Leia primeiro**')
  })

  it('renderiza caminho em crase como código', () => {
    const { container } = render(<RunningSubagents items={[]}
      backgroundTasks={[{ id: 'a1', description: 'Task 13', type: '', prompt: md }]} />)
    fireEvent.click(screen.getByText('Task 13'))
    expect(container.querySelector('.subagent__prompt code')?.textContent).toBe('src/pages/login/index.jsx')
  })

  it('renderiza lista do prompt', () => {
    const { container } = render(<RunningSubagents items={[]}
      backgroundTasks={[{ id: 'a1', description: 'Task 13', type: '', prompt: md }]} />)
    fireEvent.click(screen.getByText('Task 13'))
    expect(container.querySelectorAll('.subagent__prompt li')).toHaveLength(2)
  })
})
