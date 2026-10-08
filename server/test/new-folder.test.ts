import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderNameOf, withNewFolder } from '../src/files/new-folder.js'

let base: string
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'nova-pasta-')) })

describe('folderNameOf', () => {
  it('aceita nome com espaço, acento e ponto, sem as bordas em branco', () => {
    expect(folderNameOf('  Meu App ')).toBe('Meu App')
    expect(folderNameOf('ação-1.2')).toBe('ação-1.2')
  })
  it('recusa o que sairia da pasta-base ou não é nome', () => {
    for (const ruim of ['', '   ', '.', '..', 'a/b', '../fora', 'a\\b', 'a\0b', 'x'.repeat(121), 42, null]) {
      expect(folderNameOf(ruim)).toBeNull()
    }
  })
})

describe('withNewFolder', () => {
  it('cria a pasta dentro da base e entrega o caminho', () => {
    const r = withNewFolder(base, 'meu-app', (path) => path)
    expect(r).toBe(join(base, 'meu-app'))
    expect(readdirSync(base)).toEqual(['meu-app'])
  })
  it('pasta que já existe é recusada com EEXIST e não é tocada', () => {
    mkdirSync(join(base, 'existe'))
    writeFileSync(join(base, 'existe', 'dado.txt'), 'x')
    let usou = false
    expect(() => withNewFolder(base, 'existe', () => { usou = true })).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(usou).toBe(false)
    expect(readdirSync(join(base, 'existe'))).toEqual(['dado.txt'])
  })
  it('base que não existe é recusada sem criar nada', () => {
    expect(() => withNewFolder(join(base, 'nao-existe'), 'app', () => 1)).toThrow(/pasta-base não existe/)
    expect(existsSync(join(base, 'nao-existe'))).toBe(false)
  })
  it('se o uso falha, a pasta recém-criada sai junto', () => {
    expect(() => withNewFolder(base, 'app', () => { throw new Error('banco recusou') })).toThrow('banco recusou')
    expect(readdirSync(base)).toEqual([])
  })
})
