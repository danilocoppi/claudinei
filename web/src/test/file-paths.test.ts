import { describe, it, expect } from 'vitest'
import { toRelativePath, toFullPath, isLocalHost } from '../filePaths'

const ROOT = '/home/coppi/Projects/43-AiFinex/wl-backend'

describe('toRelativePath', () => {
  it('remove a raiz do projeto de um caminho absoluto', () => {
    expect(toRelativePath(`${ROOT}/engine/sizing.js`, ROOT)).toBe('engine/sizing.js')
  })

  it('deixa intacto um caminho que já é relativo', () => {
    expect(toRelativePath('engine/sizing.js', ROOT)).toBe('engine/sizing.js')
  })

  it('tolera raiz com barra final', () => {
    expect(toRelativePath(`${ROOT}/engine/sizing.js`, `${ROOT}/`)).toBe('engine/sizing.js')
  })

  it('não corta caminho de FORA do projeto', () => {
    expect(toRelativePath('/etc/hosts', ROOT)).toBe('/etc/hosts')
  })

  it('sem raiz conhecida, devolve o caminho como veio', () => {
    expect(toRelativePath('/x/y.js', undefined)).toBe('/x/y.js')
  })

  it('não confunde raiz que é prefixo de outro diretório', () => {
    expect(toRelativePath('/home/coppi/Projects/43-AiFinex/wl-backend-old/a.js', ROOT))
      .toBe('/home/coppi/Projects/43-AiFinex/wl-backend-old/a.js')
  })
})

describe('toFullPath', () => {
  it('junta a raiz do projeto a um caminho relativo', () => {
    expect(toFullPath('engine/sizing.js', ROOT)).toBe(`${ROOT}/engine/sizing.js`)
  })

  it('mantém um caminho que já é absoluto', () => {
    expect(toFullPath(`${ROOT}/engine/sizing.js`, ROOT)).toBe(`${ROOT}/engine/sizing.js`)
  })

  it('não duplica a barra quando a raiz termina em /', () => {
    expect(toFullPath('a.js', `${ROOT}/`)).toBe(`${ROOT}/a.js`)
  })

  it('sem raiz conhecida, devolve o relativo como veio', () => {
    expect(toFullPath('a.js', undefined)).toBe('a.js')
  })

  it('remove o ./ inicial ao juntar', () => {
    expect(toFullPath('./a.js', ROOT)).toBe(`${ROOT}/a.js`)
  })
})

describe('isLocalHost', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    it(`reconhece ${h} como local`, () => expect(isLocalHost(h)).toBe(true))
  }
  for (const h of ['192.168.0.10', 'deskcoppi.local', 'claudinei.exemplo.com', '10.0.0.2']) {
    it(`reconhece ${h} como remoto`, () => expect(isLocalHost(h)).toBe(false))
  }
})
