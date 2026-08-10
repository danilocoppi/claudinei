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
