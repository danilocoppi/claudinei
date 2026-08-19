import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { parseIcon, iconToken, loadIconSet, brandPath, lucideNodes, allBrands } from '../icons'
import { Icon } from '../components/Icon'

afterEach(() => cleanup())

/**
 * O campo `icon` já existe e está cheio de emoji. O prefixo é o que deixa os três
 * formatos conviverem ali sem migrar dado nenhum e sem uma coluna nova.
 */
describe('o token do ícone', () => {
  it('emoji continua sendo emoji', () => {
    expect(parseIcon('📁')).toEqual({ kind: 'emoji', char: '📁' })
    expect(parseIcon('🅰️')).toEqual({ kind: 'emoji', char: '🅰️' })
  })

  it('reconhece marca e ícone de linha pelo prefixo', () => {
    expect(parseIcon('si:react')).toEqual({ kind: 'brand', id: 'react' })
    expect(parseIcon('lu:terminal')).toEqual({ kind: 'lucide', id: 'terminal' })
  })

  it('o que não casa o formato é tratado como emoji, não como erro', () => {
    expect(parseIcon('si:').kind).toBe('emoji')
    expect(parseIcon('xx:react').kind).toBe('emoji')
    expect(parseIcon('').kind).toBe('emoji')
    expect(parseIcon(undefined).kind).toBe('emoji')
  })

  it('monta o token de volta', () => {
    expect(iconToken('brand', 'docker')).toBe('si:docker')
    expect(iconToken('lucide', 'rocket')).toBe('lu:rocket')
  })
})

describe('os conjuntos chegam sob demanda', () => {
  it('marcas: milhares de logos, com o desenho de cada uma', async () => {
    await loadIconSet('brand')
    expect(allBrands().length).toBeGreaterThan(3000)
    expect(brandPath('react')).toMatch(/^[Mm]/)     // um path de SVG
    expect(brandPath('docker')).toBeTruthy()
  })

  it('lucide: árvore de elementos, não um único path', async () => {
    await loadIconSet('lucide')
    const nodes = lucideNodes('terminal')
    expect(nodes!.length).toBeGreaterThan(0)
    expect(nodes![0][0]).toMatch(/path|line|circle|rect|polyline/)
  })

  it('pedir duas vezes não reprocessa o conjunto', async () => {
    await loadIconSet('brand')
    const primeiro = allBrands()
    await loadIconSet('brand')
    // mesma referência = não reimportou nem remontou o índice
    expect(allBrands()).toBe(primeiro)
  })
})

describe('desenho', () => {
  it('emoji sai como texto', () => {
    const { container } = render(<Icon value="📁" />)
    expect(container.textContent).toBe('📁')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('marca vira um svg de um path só', async () => {
    await loadIconSet('brand')
    const { container } = render(<Icon value="si:react" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.querySelectorAll('path')).toHaveLength(1)
  })

  it('ícone de linha vira svg traçado, com os elementos do desenho', async () => {
    await loadIconSet('lucide')
    const { container } = render(<Icon value="lu:terminal" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.children.length).toBeGreaterThan(0)
  })

  /**
   * A cor vem do contexto (`currentColor`), não da marca: o azul do Docker é mais
   * reconhecível, mas some no tema cujo fundo por acaso é azul — e o cartão já
   * carrega a cor do terminal no trilho da esquerda.
   */
  it('o desenho herda a cor de quem o contém', async () => {
    await loadIconSet('brand')
    const { container } = render(<Icon value="si:docker" />)
    expect(container.querySelector('svg')!.getAttribute('fill')).toBe('currentColor')
  })

  it('slug inexistente não quebra a linha: reserva o espaço', async () => {
    await loadIconSet('brand')
    const { container } = render(<Icon value="si:nao-existe" size={20} />)
    expect(container.querySelector('svg')).toBeNull()
    expect((container.firstChild as HTMLElement).style.width).toBe('20px')
  })
})
