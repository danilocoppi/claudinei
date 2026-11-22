import { describe, it, expect } from 'vitest'
import {
  agentOpened, columnWidth, effectiveView, selectView, sideBorn, sideGone, tabsFor, toggleView,
  type ColumnState,
} from '../browser/columnModel'

/**
 * A coluna da direita, uma vista de cada vez (Acompanhamento, Lateral,
 * Navegador): as regras puras de quem toma a coluna, para onde ela volta e
 * as larguras. Ver o "Desenho — web" da spec do navegador embutido.
 */
const estado = (o: Partial<ColumnState> = {}): ColumnState =>
  ({ open: false, view: 'progress', previous: null, fullscreen: false, marked: [], ...o })

describe('modelo da coluna', () => {
  it('sideBorn com coluna fechada → abre em side; sideGone → fecha de novo', () => {
    const nasceu = sideBorn(estado())
    expect(nasceu).toMatchObject({ open: true, view: 'side', previous: 'closed' })
    const foi = sideGone(nasceu)
    expect(foi.open).toBe(false)
    expect(foi.previous).toBeNull()
  })

  it('sideBorn com coluna em browser → side; sideGone → volta a browser', () => {
    const nasceu = sideBorn(estado({ open: true, view: 'browser' }))
    expect(nasceu).toMatchObject({ open: true, view: 'side', previous: 'browser' })
    expect(sideGone(nasceu)).toMatchObject({ open: true, view: 'browser', previous: null })
  })

  it('sideGone com o operador já noutra vista não mexe nela', () => {
    const nasceu = sideBorn(estado({ open: true, view: 'browser' }))
    const trocou = selectView(nasceu, 'progress')
    expect(sideGone(trocou)).toMatchObject({ open: true, view: 'progress', previous: null })
  })

  it('agentOpened: fechada → abre em browser; em progress → browser; em side → só marca browser', () => {
    expect(agentOpened(estado())).toMatchObject({ open: true, view: 'browser' })
    expect(agentOpened(estado({ open: true, view: 'progress' }))).toMatchObject({ open: true, view: 'browser' })
    const naLateral = agentOpened(estado({ open: true, view: 'side' }))
    expect(naLateral).toMatchObject({ open: true, view: 'side', marked: ['browser'] })
    // Marca uma vez só; escolher a vista tira a marca.
    expect(agentOpened(naLateral).marked).toEqual(['browser'])
    expect(selectView(naLateral, 'browser')).toMatchObject({ view: 'browser', marked: [] })
  })

  it('toggleView na vista aberta fecha; noutra vista troca', () => {
    const aberta = estado({ open: true, view: 'progress', fullscreen: true })
    expect(toggleView(aberta, 'progress')).toMatchObject({ open: false, fullscreen: false })
    expect(toggleView(aberta, 'browser')).toMatchObject({ open: true, view: 'browser' })
    expect(toggleView(estado(), 'browser')).toMatchObject({ open: true, view: 'browser' })
    expect(toggleView(estado({ marked: ['browser'] }), 'browser').marked).toEqual([])
  })

  it('effectiveView sem side disponível cai em progress', () => {
    const avail = { side: false, browser: true }
    expect(effectiveView(estado({ open: true, view: 'side' }), avail)).toBe('progress')
    expect(effectiveView(estado({ open: true, view: 'browser' }), { side: false, browser: false })).toBe('progress')
    expect(effectiveView(estado({ open: true, view: 'browser' }), avail)).toBe('browser')
    expect(effectiveView(estado({ open: false, view: 'browser' }), avail)).toBeNull()
  })

  it('tabsFor sem side e sem aba → [\'progress\']', () => {
    expect(tabsFor({ side: false, browser: false })).toEqual(['progress'])
    expect(tabsFor({ side: true, browser: false })).toEqual(['progress', 'side'])
    expect(tabsFor({ side: true, browser: true })).toEqual(['progress', 'side', 'browser'])
  })

  it('columnWidth: browser padrão é metade da área; mínimo 360; máximo área − 320; progress padrão 340', () => {
    expect(columnWidth('browser', undefined, 1200)).toBe(600)
    expect(columnWidth('browser', 100, 1200)).toBe(360)
    expect(columnWidth('browser', 2000, 1200)).toBe(880)
    expect(columnWidth('progress', undefined, 1200)).toBe(340)
    expect(columnWidth('side', undefined, 1200)).toBe(340)
    expect(columnWidth('progress', 100, 1200)).toBe(280)
    expect(columnWidth('side', 1000, 1200)).toBe(880)
    // Área estreita demais: o mínimo vence (no celular o CSS cobre o chat).
    expect(columnWidth('progress', undefined, 400)).toBe(280)
  })
})
