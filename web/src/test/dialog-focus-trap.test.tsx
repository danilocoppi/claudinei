import { describe, it, expect, afterEach } from 'vitest'
import { useRef } from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { useDialogKeys } from '../components/undo/useDialogKeys'

/**
 * Os diálogos do desfazer prendem o foco: Tab no último volta ao primeiro, e
 * Shift+Tab no primeiro (ou no próprio diálogo, onde o foco entra) vai ao último.
 * Sem isso o Shift+Tab levava o foco ao campo do chat, atrás do diálogo.
 */
function Dialogo() {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = useDialogKeys(ref, () => {})
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" onKeyDown={onKeyDown} data-testid="dlg">
      <button>primeiro</button>
      <button disabled>desligado</button>
      <input aria-label="meio" />
      <button>último</button>
    </div>
  )
}

afterEach(() => cleanup())

describe('foco preso nos diálogos do desfazer', () => {
  it('Tab no último volta ao primeiro; Shift+Tab no primeiro vai ao último', () => {
    render(<><textarea aria-label="campo do chat" /><Dialogo /></>)
    const ultimo = screen.getByText('último')
    ultimo.focus()
    expect(fireEvent.keyDown(ultimo, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByText('primeiro'))
    expect(fireEvent.keyDown(screen.getByText('primeiro'), { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(ultimo)
  })

  it('Shift+Tab com o foco no próprio diálogo (onde ele entra ao abrir) vai ao último, nunca ao campo de trás', () => {
    render(<><textarea aria-label="campo do chat" /><Dialogo /></>)
    const dlg = screen.getByTestId('dlg')
    expect(document.activeElement).toBe(dlg)
    fireEvent.keyDown(dlg, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('último'))
  })

  it('Tab no meio segue o navegador (não intercepta)', () => {
    render(<Dialogo />)
    const meio = screen.getByLabelText('meio')
    meio.focus()
    expect(fireEvent.keyDown(meio, { key: 'Tab' })).toBe(true)
  })
})
