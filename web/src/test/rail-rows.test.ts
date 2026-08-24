import { describe, it, expect } from 'vitest'
import { buildEntries, railRows } from '../sidebarEntries'
import type { Group } from '../api'
import type { Project } from '../types'

const proj = (id: number, name: string, over: Partial<Project> = {}): Project =>
  ({ id, name, path: `/${name}`, color: '#888', icon: '📁', ...over })

const SETOR: Group = { id: 100, name: 'Produto', color: '#58c4dc', icon: '🏢' }
const G1: Group = { id: 10, name: 'Backend', color: '#e8992f', icon: '🗂️', sectorId: 100 }
const G2: Group = { id: 20, name: 'Solto', color: '#7c5cff', icon: '🗂️' }

/** Setor 100 → Grupo 10 → [Alpha, Beta]; Grupo 20 (raiz) → [Gama]; Delta na raiz. */
const arvore = () => buildEntries(
  [proj(1, 'Alpha', { groupId: 10 }), proj(2, 'Beta', { groupId: 10 }),
   proj(3, 'Gama', { groupId: 20 }), proj(4, 'Delta')],
  [G1, G2], [SETOR],
)
const abertos = () => false

/**
 * Na régua estreita não há recuo para gastar, então a profundidade vira CONTAGEM:
 * uma guia por contêiner que envolve a linha, na cor que o próprio contêiner tem.
 * Zero guias = raiz.
 */
describe('as linhas da régua', () => {
  it('traz a árvore inteira achatada, na mesma ordem', () => {
    const linhas = railRows(arvore(), abertos)
    expect(linhas.map((l) => l.kind)).toEqual(['sector', 'group', 'project', 'project', 'group', 'project', 'project'])
  })

  it('a profundidade é o número de guias', () => {
    const l = railRows(arvore(), abertos)
    expect(l.find((x) => x.project?.name === 'Alpha')!.guides).toHaveLength(2)   // setor > grupo
    expect(l.find((x) => x.project?.name === 'Gama')!.guides).toHaveLength(1)    // grupo solto
    expect(l.find((x) => x.project?.name === 'Delta')!.guides).toHaveLength(0)   // raiz
  })

  it('cada guia usa a cor do contêiner dela, do mais externo para o mais interno', () => {
    const alpha = railRows(arvore(), abertos).find((x) => x.project?.name === 'Alpha')!
    expect(alpha.guides.map((g) => g.color)).toEqual(['#58c4dc', '#e8992f'])
  })

  /** O traço nasce no próprio contêiner: é o que liga o chip aos filhos dele. */
  it('a guia começa na linha do contêiner', () => {
    const l = railRows(arvore(), abertos)
    const grupo = l.find((x) => x.group?.id === 10)!
    expect(grupo.guides.at(-1)).toMatchObject({ color: '#e8992f', start: true })
  })

  it('e termina no último filho', () => {
    const l = railRows(arvore(), abertos)
    const beta = l.find((x) => x.project?.name === 'Beta')!
    expect(beta.guides.at(-1)!.end).toBe(true)
    const alpha = l.find((x) => x.project?.name === 'Alpha')!
    expect(alpha.guides.at(-1)!.end).toBe(false)
  })

  /** Contêiner fechado é um traço de uma linha só: começa e acaba nele mesmo. */
  it('contêiner fechado não derrama filhos', () => {
    const l = railRows(arvore(), (k) => k === 'g-10')
    expect(l.some((x) => x.project?.name === 'Alpha')).toBe(false)
    const grupo = l.find((x) => x.group?.id === 10)!
    expect(grupo.guides.at(-1)).toMatchObject({ start: true, end: true })
    expect(grupo.collapsed).toBe(true)
  })

  it('setor fechado esconde os grupos dele também', () => {
    const l = railRows(arvore(), (k) => k === 's-100')
    expect(l.map((x) => x.kind)).toEqual(['sector', 'group', 'project', 'project'])
  })

  /** A guia do setor tem que sobreviver ao último filho do último grupo dele. */
  it('a guia do setor só fecha no fim de tudo que é dele', () => {
    const l = railRows(arvore(), abertos)
    const beta = l.find((x) => x.project?.name === 'Beta')!
    expect(beta.guides[0].end, 'setor fechou cedo demais').toBe(true)
    const alpha = l.find((x) => x.project?.name === 'Alpha')!
    expect(alpha.guides[0].end).toBe(false)
  })

  it('cada linha tem chave própria, para o React e para o clique', () => {
    const chaves = railRows(arvore(), abertos).map((l) => l.key)
    expect(new Set(chaves).size).toBe(chaves.length)
  })
})
