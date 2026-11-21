import { describe, it, expect } from 'vitest'
import { inProjectOf, NOWHERE, underTop } from '../src/undo/scope.js'

describe('inProjectOf: a regra única de "dentro do projeto"', () => {
  it('barra final não muda nada', () => {
    for (const rel of ['server', 'server/', 'server//']) {
      const inside = inProjectOf(rel)
      expect(inside('server'), rel).toBe(true)
      expect(inside('server/a.ts'), rel).toBe(true)
      expect(inside('server/src/b.ts'), rel).toBe(true)
      expect(inside('web/a.ts'), rel).toBe(false)
    }
  })

  it('serverx não é server/', () => {
    const inside = inProjectOf('server')
    expect(inside('serverx')).toBe(false)
    expect(inside('serverx/a.ts')).toBe(false)
    expect(inside('server.ts')).toBe(false)
  })

  it('vazio, `.` e `./` são o repositório inteiro', () => {
    for (const rel of ['', '.', './']) {
      const inside = inProjectOf(rel)
      expect(inside('a.txt'), rel).toBe(true)
      expect(inside('fundo/b.txt'), rel).toBe(true)
      expect(inside('.config/x'), rel).toBe(true)
    }
  })

  it('pasta que começa com ponto: `.config`', () => {
    const inside = inProjectOf('.config')
    expect(inside('.config')).toBe(true)
    expect(inside('.config/app.json')).toBe(true)
    expect(inside('.configx/app.json')).toBe(false)
    expect(inside('config/app.json')).toBe(false)
    expect(inProjectOf('./.config')('.config/app.json')).toBe(true)
  })

  it('projeto fora do topo (NOWHERE): nada cai dentro', () => {
    const inside = inProjectOf(NOWHERE)
    expect(inside('a.txt')).toBe(false)
    expect(inside('')).toBe(false)
  })
})

describe('underTop', () => {
  it('o topo e o que está abaixo; não o irmão com o mesmo prefixo', () => {
    expect(underTop('/r/repo', '/r/repo')).toBe(true)
    expect(underTop('/r/repo/sub', '/r/repo')).toBe(true)
    expect(underTop('/r/repox', '/r/repo')).toBe(false)
  })
})
