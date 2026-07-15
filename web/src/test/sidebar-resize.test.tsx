import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { SidebarResizer, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../components/SidebarResizer'

const KEY = 'claudinei:sidebarWidth'
const varW = () => document.documentElement.style.getPropertyValue('--sidebar-w')
const move = (clientX: number) => fireEvent(window, new MouseEvent('mousemove', { clientX }))
const up = () => fireEvent(window, new MouseEvent('mouseup'))

beforeEach(() => {
  localStorage.removeItem(KEY)
  document.documentElement.style.removeProperty('--sidebar-w')
})
afterEach(() => cleanup())

describe('SidebarResizer', () => {
  it('arrastar a alça pra direita expande e persiste no mouseup', () => {
    const { container } = render(<SidebarResizer />)
    const handle = container.querySelector('.sidebar-resizer')!
    expect(varW()).toBe(`${SIDEBAR_DEFAULT}px`)

    fireEvent.mouseDown(handle, { clientX: 100 })
    move(180) // +80px
    expect(varW()).toBe(`${SIDEBAR_DEFAULT + 80}px`)
    up()
    expect(localStorage.getItem(KEY)).toBe(String(SIDEBAR_DEFAULT + 80))
  })

  it('arrastar pra esquerda encolhe, com clamp no mínimo', () => {
    const { container } = render(<SidebarResizer />)
    fireEvent.mouseDown(container.querySelector('.sidebar-resizer')!, { clientX: 500 })
    move(0) // muito além do mínimo
    expect(varW()).toBe(`${SIDEBAR_MIN}px`)
    up()
  })

  it('clamp no máximo ao expandir demais', () => {
    const { container } = render(<SidebarResizer />)
    fireEvent.mouseDown(container.querySelector('.sidebar-resizer')!, { clientX: 0 })
    move(2000)
    expect(varW()).toBe(`${SIDEBAR_MAX}px`)
    up()
  })

  it('depois do mouseup, mover o mouse NÃO redimensiona mais', () => {
    const { container } = render(<SidebarResizer />)
    fireEvent.mouseDown(container.querySelector('.sidebar-resizer')!, { clientX: 100 })
    move(150)
    up()
    const after = varW()
    move(400)
    expect(varW()).toBe(after)
  })

  it('duplo clique restaura o padrão', () => {
    localStorage.setItem(KEY, '400')
    const { container } = render(<SidebarResizer />)
    expect(varW()).toBe('400px')
    fireEvent.doubleClick(container.querySelector('.sidebar-resizer')!)
    expect(varW()).toBe(`${SIDEBAR_DEFAULT}px`)
    expect(localStorage.getItem(KEY)).toBe(String(SIDEBAR_DEFAULT))
  })

  it('largura salva (localStorage) é aplicada no mount, com clamp de lixo', () => {
    localStorage.setItem(KEY, '99999')
    const { unmount } = render(<SidebarResizer />)
    expect(varW()).toBe(`${SIDEBAR_MAX}px`)
    unmount()
    localStorage.setItem(KEY, 'banana')
    render(<SidebarResizer />)
    expect(varW()).toBe(`${SIDEBAR_DEFAULT}px`)
  })
})
