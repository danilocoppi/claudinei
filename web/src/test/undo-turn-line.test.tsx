import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TurnLine } from '../components/undo/TurnLine'
import type { TurnDto } from '../../../shared/undo'
import type { ChatItem } from '../types'

const turn = (over: Partial<TurnDto> = {}): TurnDto => ({
  id: 7, localId: 'a', projectId: 1, engine: 'claude', origin: 'operator', key: 'faça X', midTurn: false,
  state: 'ok', limited: false, endKind: 'result',
  summary: { files: 3, added: 40, removed: 12, outside: 0, uncertain: 0, unsnapshotted: 0 },
  lastRun: null, startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:01:00Z', ...over,
})

const NENHUM: ChatItem[] = []
const handlers = () => ({ onOpen: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() })

afterEach(() => cleanup())

describe('TurnLine', () => {
  it('linha com resumo e botões; Refazer depois de desfeito', () => {
    const h = handlers()
    const t = turn()
    const { rerender } = render(<TurnLine turn={t} items={NENHUM} {...h} />)
    expect(screen.getByText('3 arquivos')).toBeTruthy()
    expect(screen.getByText('+40 −12')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ver mudanças' }))
    expect(h.onOpen).toHaveBeenCalledWith({ turnId: 7 })
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }))
    expect(h.onUndo).toHaveBeenCalledWith(t)
    expect(screen.queryByRole('button', { name: 'Refazer' })).toBeNull()

    // Desfeito e não refeito: o Desfazer vira Refazer.
    const desfeito = turn({ lastRun: { id: 3, redone: false } })
    rerender(<TurnLine turn={desfeito} items={NENHUM} {...h} />)
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }))
    expect(h.onRedo).toHaveBeenCalledWith(desfeito)

    // Refeito: volta o Desfazer.
    rerender(<TurnLine turn={turn({ lastRun: { id: 3, redone: true } })} items={NENHUM} {...h} />)
    expect(screen.getByRole('button', { name: 'Desfazer' })).toBeTruthy()
  })

  it('um arquivo no singular e os incertos contam para a linha', () => {
    render(<TurnLine turn={turn({ summary: { files: 1, added: 2, removed: 0, outside: 0, uncertain: 2, unsnapshotted: 0 } })} items={NENHUM} {...handlers()} />)
    expect(screen.getByText('1 arquivo')).toBeTruthy()
    expect(screen.getByText('2 podem ser de outro terminal')).toBeTruthy()
  })

  it('retrato atrasado desliga o Desfazer', () => {
    const h = handlers()
    render(<TurnLine turn={turn({ state: 'late' })} items={NENHUM} {...h} />)
    expect(screen.getByText('retrato atrasado')).toBeTruthy()
    const btn = screen.getByRole('button', { name: 'Desfazer' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(h.onUndo).not.toHaveBeenCalled()
    // Ver mudanças continua valendo.
    expect(screen.getByRole('button', { name: 'Ver mudanças' })).toBeTruthy()
  })

  it('selos: sem ponto de restauração, perdido, fim incerto, limitado e fora do projeto', () => {
    const h = handlers()
    const { rerender } = render(<TurnLine turn={turn({ state: 'failed', stateReason: 'disco cheio', summary: null })} items={NENHUM} {...h} />)
    expect(screen.getByText('sem ponto de restauração: disco cheio')).toBeTruthy()
    // Sem retrato não há o que ver nem desfazer.
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ver mudanças' })).toBeNull()

    rerender(<TurnLine turn={turn({ state: 'lost' })} items={NENHUM} {...h} />)
    expect(screen.getByText('retrato perdido')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull()

    rerender(<TurnLine turn={turn({ endKind: 'uncertain', limited: true, summary: { files: 2, added: 1, removed: 1, outside: 4, uncertain: 0, unsnapshotted: 0 } })} items={NENHUM} {...h} />)
    expect(screen.getByText('fim incerto')).toBeTruthy()
    expect(screen.getByText('Esta pasta tem muitos arquivos fora do git; ponha-os no .gitignore para o retrato completo')).toBeTruthy()
    expect(screen.getByText('4 arquivos fora deste projeto')).toBeTruthy()
  })

  it('sem git: linha declarada só com declarações e o aviso fixo', () => {
    const h = handlers()
    const semGit = turn({ state: 'no_git', summary: null })
    const comEdit: ChatItem[] = [
      { kind: 'user_text', text: 'faça X' },
      { kind: 'tool_call', id: 't1', name: 'Edit', input: { file_path: '/p/a.txt', old_string: 'x', new_string: 'y' } },
      { kind: 'tool_call', id: 't2', name: 'Bash', input: { command: 'rm b.txt' } },
      { kind: 'assistant_text', text: 'feito' },
    ]
    const { rerender, container } = render(<TurnLine turn={semGit} items={comEdit} {...h} />)
    expect(screen.getByText('Mudanças declaradas pelo agente')).toBeTruthy()
    expect(screen.getByText('1 arquivo')).toBeTruthy()
    expect(screen.getByText('Sem git: mudanças feitas por comandos não aparecem e não dá para desfazer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }))
    expect(h.onOpen).toHaveBeenCalledWith({ declared: [{ path: '/p/a.txt', kind: 'edit', pairs: [{ old: 'x', new: 'y' }] }] })

    // Sem declarações (só Bash), nada.
    rerender(<TurnLine turn={semGit} items={[comEdit[0], comEdit[2], comEdit[3]]} {...h} />)
    expect(container.innerHTML).toBe('')
  })

  it('turno sem mudanças não desenha linha', () => {
    const h = handlers()
    const zero = { files: 0, added: 0, removed: 0, outside: 0, uncertain: 0, unsnapshotted: 0 }
    const { container, rerender } = render(<TurnLine turn={turn({ summary: zero })} items={NENHUM} {...h} />)
    expect(container.innerHTML).toBe('')
    rerender(<TurnLine turn={turn({ summary: null })} items={NENHUM} {...h} />)
    expect(container.innerHTML).toBe('')
    // Só fora da pasta do projeto: nada a ver nem desfazer aqui.
    rerender(<TurnLine turn={turn({ summary: { ...zero, outside: 3 } })} items={NENHUM} {...h} />)
    expect(container.innerHTML).toBe('')
    // Em andamento: nada, mesmo com resumo.
    rerender(<TurnLine turn={turn({ state: 'running', endedAt: null })} items={NENHUM} {...h} />)
    expect(container.innerHTML).toBe('')
  })
})
