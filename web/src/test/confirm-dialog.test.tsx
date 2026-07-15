import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from '../components/ConfirmDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConfirmDialog', () => {
  it('renderiza título e mensagem', () => {
    render(
      <ConfirmDialog title="Excluir X?" message="Isso remove o projeto." onConfirm={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByText('Excluir X?')).toBeTruthy()
    expect(screen.getByText('Isso remove o projeto.')).toBeTruthy()
  })

  it('clicar em Cancelar chama onClose', () => {
    const onClose = vi.fn()
    render(
      <ConfirmDialog title="Excluir X?" message="msg" onConfirm={() => {}} onClose={onClose} />,
    )
    fireEvent.click(screen.getByText('Cancelar'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clicar em Confirmar (label default) chama onConfirm', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog title="Excluir X?" message="msg" onConfirm={onConfirm} onClose={() => {}} />,
    )
    fireEvent.click(screen.getByText('Confirmar'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('usa confirmLabel customizado', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        title="Excluir X?"
        message="msg"
        confirmLabel="Excluir"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('Excluir'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('mostra error quando passado', () => {
    render(
      <ConfirmDialog title="Excluir X?" message="msg" error="Sessão ativa" onConfirm={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByText('Sessão ativa')).toBeTruthy()
  })

  it('não mostra nenhum erro quando não passado', () => {
    render(<ConfirmDialog title="Excluir X?" message="msg" onConfirm={() => {}} onClose={() => {}} />)
    expect(screen.queryByText('Sessão ativa')).toBeNull()
  })

  it('usa o overlay temático modal-overlay', () => {
    render(<ConfirmDialog title="Excluir X?" message="msg" onConfirm={() => {}} onClose={() => {}} />)
    expect(document.querySelector('.modal-overlay')).toBeTruthy()
  })

  it('clicar no overlay (fora do glass) chama onClose', () => {
    const onClose = vi.fn()
    render(<ConfirmDialog title="Excluir X?" message="msg" onConfirm={() => {}} onClose={onClose} />)
    fireEvent.click(document.querySelector('.modal-overlay') as Element)
    expect(onClose).toHaveBeenCalled()
  })
})

it('mensagem com URL comprida não vaza do modal (pre-line + overflow-wrap anywhere)', () => {
  render(
    <ConfirmDialog title="Abrir link externo?" onConfirm={() => {}} onClose={() => {}}
                   message={'Este link sai do Claudinei:\nhttps://docs.exemplo.io/reference/umcaminhosemespacomuitolongoquenaoquebra'} />,
  )
  const p = screen.getByText(/docs\.exemplo\.io/)
  expect(p.style.overflowWrap).toBe('anywhere')
  expect(p.style.whiteSpace).toBe('pre-line')
})
