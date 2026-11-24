import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { revealInList } from '../revealInList'
import { SlashMenu } from '../components/SlashMenu'
import { MentionMenu } from '../components/MentionMenu'
import type { Project } from '../types'

/**
 * Menus com altura máxima e item ativo mudado pela seta (o `/` dos comandos e o
 * `@@` das menções): a seta trocava o destaque, mas a lista não rolava, e o
 * item ativo sumia abaixo da borda. O jsdom não faz layout, então cada item
 * ganha uma caixa de 30 px numa lista de 90 px de altura, rolada por scrollTop.
 */
const ITEM = 30
const VISIVEL = 90

function layout(lista: HTMLElement, itens: HTMLElement[]) {
  Object.defineProperty(lista, 'clientHeight', { configurable: true, get: () => VISIVEL })
  lista.getBoundingClientRect = () => ({ top: 0, bottom: VISIVEL, height: VISIVEL } as DOMRect)
  itens.forEach((el, i) => {
    el.getBoundingClientRect = () => {
      const top = i * ITEM - lista.scrollTop
      return { top, bottom: top + ITEM, height: ITEM } as DOMRect
    }
  })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('revealInList', () => {
  const montar = () => {
    const lista = document.createElement('div')
    const itens = Array.from({ length: 10 }, () => lista.appendChild(document.createElement('div')))
    layout(lista, itens)
    return { lista, itens }
  }
  it('rola para baixo só o bastante para o item abaixo da borda aparecer inteiro', () => {
    const { lista, itens } = montar()
    revealInList(lista, itens[4])
    expect(lista.scrollTop).toBe(5 * ITEM - VISIVEL)
  })
  it('rola para cima quando o item está acima da borda', () => {
    const { lista, itens } = montar()
    lista.scrollTop = 200
    revealInList(lista, itens[2])
    expect(lista.scrollTop).toBe(2 * ITEM)
  })
  it('conta a borda e o recuo da lista: o primeiro item volta a mostrar o topo inteiro', () => {
    const { lista, itens } = montar()
    // Lista com 1 px de borda e 6 px de recuo: o conteúdo começa 7 px abaixo do topo da caixa.
    lista.style.paddingTop = '6px'; lista.style.paddingBottom = '6px'
    Object.defineProperty(lista, 'clientTop', { configurable: true, get: () => 1 })
    itens.forEach((el, i) => {
      el.getBoundingClientRect = () => {
        const top = 7 + i * ITEM - lista.scrollTop
        return { top, bottom: top + ITEM, height: ITEM } as DOMRect
      }
    })
    lista.scrollTop = 100
    revealInList(lista, itens[0])
    expect(lista.scrollTop).toBe(0)
  })
  it('não mexe quando o item já está à vista', () => {
    const { lista, itens } = montar()
    lista.scrollTop = 30
    revealInList(lista, itens[2])
    expect(lista.scrollTop).toBe(30)
  })
})

describe('menu de comandos (/) com a seta', () => {
  it('rola a lista até o item ativo', () => {
    const items = Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    const { getByTestId, getAllByTestId, rerender } = render(<SlashMenu items={items} activeIndex={0} onPick={() => {}} />)
    const lista = getByTestId('slash-menu')
    layout(lista, getAllByTestId('slash-item'))
    rerender(<SlashMenu items={items} activeIndex={5} onPick={() => {}} />)
    expect(lista.scrollTop).toBe(6 * ITEM - VISIVEL)
    rerender(<SlashMenu items={items} activeIndex={0} onPick={() => {}} />)
    expect(lista.scrollTop).toBe(0)
  })
})

describe('menu de menções (@@) com a seta', () => {
  it('rola a lista até o item ativo', () => {
    const projects = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Projeto ${i}` })) as unknown as Project[]
    const { getByTestId, getAllByTestId, container } = render(<MentionMenu projects={projects} onPick={() => {}} onClose={() => {}} />)
    const lista = container.querySelector('.mention-menu__list') as HTMLElement
    layout(lista, getAllByTestId('mention-item'))
    const busca = getByTestId('mention-search')
    for (let i = 0; i < 4; i++) fireEvent.keyDown(busca, { key: 'ArrowDown' })
    expect(lista.scrollTop).toBe(5 * ITEM - VISIVEL)
  })
})

describe('menu de comandos (/) re-renderizado sem mudar nada', () => {
  it('não puxa de volta a lista que o usuário rolou com o mouse', () => {
    const items = Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    const { getByTestId, getAllByTestId, rerender } = render(<SlashMenu items={items} activeIndex={0} onPick={() => {}} />)
    const lista = getByTestId('slash-menu')
    layout(lista, getAllByTestId('slash-item'))
    lista.scrollTop = 120 // rodinha do mouse
    rerender(<SlashMenu items={[...items]} activeIndex={0} onPick={() => {}} />)
    expect(lista.scrollTop).toBe(120)
  })
})
