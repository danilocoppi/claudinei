import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { IconPicker } from '../components/IconPicker'
import { loadIconSet } from '../icons'

afterEach(() => cleanup())

const openTab = async (tab: 'brand' | 'lucide', props: Partial<Parameters<typeof IconPicker>[0]> = {}) => {
  await loadIconSet(tab)
  render(<IconPicker onSelect={props.onSelect ?? (() => {})} onClose={props.onClose ?? (() => {})} value={props.value} />)
  fireEvent.click(screen.getByTestId(`icon-tab-${tab}`))
  return screen.getByTestId('icon-grid')
}

describe('as três abas', () => {
  it('abre na aba do ícone que já está escolhido', async () => {
    await loadIconSet('brand')
    render(<IconPicker value="si:react" onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('icon-tab-brand').className).toMatch(/\bon\b/)
  })

  it('emoji é a aba padrão de quem ainda usa emoji', async () => {
    render(<IconPicker value="📁" onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('icon-tab-emoji').className).toMatch(/\bon\b/)
  })
})

describe('marcas', () => {
  it('mostra logos e diz quantos há ao todo', async () => {
    const grid = await openTab('brand')
    expect(grid.querySelectorAll('svg').length).toBeGreaterThan(50)
    expect(screen.getByText(/de \d{4}/)).toBeTruthy()   // milhares no total
  })

  /** Seis mil nós de SVG de uma vez travam a aba: a grade mostra um pedaço. */
  it('não desenha tudo de uma vez', async () => {
    const grid = await openTab('brand')
    expect(grid.querySelectorAll('.icon-picker__cell').length).toBeLessThanOrEqual(300)
  })

  it('"mostrar mais" traz o próximo pedaço', async () => {
    const grid = await openTab('brand')
    const antes = grid.querySelectorAll('.icon-picker__cell').length
    fireEvent.click(screen.getByText(/mostrar mais/i))
    expect(grid.querySelectorAll('.icon-picker__cell').length).toBeGreaterThan(antes)
  })

  it('busca por nome da marca', async () => {
    await openTab('brand')
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'docker' } })
    await vi.waitFor(() => {
      const grid = screen.getByTestId('icon-grid')
      expect(grid.querySelectorAll('.icon-picker__cell').length).toBeLessThan(20)
      expect(within(grid).getByTitle('Docker')).toBeTruthy()
    })
  })

  it('escolher devolve o TOKEN, não o desenho', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await openTab('brand', { onSelect, onClose })
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'docker' } })
    await vi.waitFor(() => expect(screen.getByTitle('Docker')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Docker'))
    expect(onSelect).toHaveBeenCalledWith('si:docker')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ícones de linha', () => {
  it('lista e busca', async () => {
    await openTab('lucide')
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'terminal' } })
    await vi.waitFor(() => {
      const grid = screen.getByTestId('icon-grid')
      expect(grid.querySelectorAll('.icon-picker__cell').length).toBeGreaterThan(0)
      expect(grid.querySelectorAll('svg')[0].getAttribute('stroke')).toBe('currentColor')
    })
  })

  it('busca sem resultado avisa em vez de mostrar grade vazia', async () => {
    await openTab('lucide')
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'zzzznaoexiste' } })
    await vi.waitFor(() => expect(screen.getByText(/nada encontrado/i)).toBeTruthy())
  })

  it('trocar de aba limpa a busca (o termo de uma não serve para a outra)', async () => {
    await openTab('lucide')
    fireEvent.change(screen.getByTestId('icon-search'), { target: { value: 'terminal' } })
    fireEvent.click(screen.getByTestId('icon-tab-brand'))
    expect((screen.getByTestId('icon-search') as HTMLInputElement).value).toBe('')
  })
})
