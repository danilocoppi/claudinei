import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { STASH_KEY, STASH_MAX, stashKey, readStash, pushStash, popStash, takeStash, type StashEntry } from '../stash'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

const entrada = (text: string, savedAt = 1): StashEntry => ({ text, attachments: [], savedAt })

/**
 * Ctrl+S guarda o prompt para depois, por terminal (projeto + motor). A lista
 * tem teto: passou de 10, o mais antigo sai.
 */
describe('guardados por terminal', () => {
  it('a chave é projeto:motor', () => {
    expect(stashKey(7, 'codex')).toBe('7:codex')
  })

  it('guarda até 10 e descarta o mais antigo', () => {
    const k = stashKey(1, 'claude')
    for (let i = 1; i <= STASH_MAX + 2; i++) pushStash(k, entrada(`p${i}`, i))
    const lista = readStash(k)
    expect(STASH_MAX).toBe(10)
    expect(lista).toHaveLength(10)
    // os dois primeiros saíram; o mais novo fica no fim
    expect(lista[0].text).toBe('p3')
    expect(lista[9].text).toBe('p12')
  })

  it('popStash devolve o mais novo e o tira', () => {
    const k = stashKey(1, 'claude')
    pushStash(k, entrada('primeiro'))
    pushStash(k, entrada('segundo'))
    expect(popStash(k)?.text).toBe('segundo')
    expect(readStash(k).map((e) => e.text)).toEqual(['primeiro'])
    expect(popStash(k)?.text).toBe('primeiro')
    expect(popStash(k)).toBeUndefined()
    // lista vazia não deixa a chave para trás
    expect(JSON.parse(localStorage.getItem(STASH_KEY)!)).toEqual({})
  })

  it('takeStash pelo índice', () => {
    const k = stashKey(1, 'claude')
    pushStash(k, entrada('a'))
    pushStash(k, entrada('b'))
    pushStash(k, entrada('c'))
    expect(takeStash(k, 1)?.text).toBe('b')
    expect(readStash(k).map((e) => e.text)).toEqual(['a', 'c'])
    expect(takeStash(k, 5)).toBeUndefined()
    expect(takeStash(k, -1)).toBeUndefined()
    expect(readStash(k).map((e) => e.text)).toEqual(['a', 'c'])
  })

  it('cada terminal tem a sua lista', () => {
    pushStash(stashKey(1, 'claude'), entrada('do claude'))
    pushStash(stashKey(1, 'codex'), entrada('do codex'))
    expect(readStash(stashKey(1, 'claude')).map((e) => e.text)).toEqual(['do claude'])
    expect(readStash(stashKey(1, 'codex')).map((e) => e.text)).toEqual(['do codex'])
    expect(readStash(stashKey(2, 'claude'))).toEqual([])
  })

  it('guarda o mapa token→caminho dos anexos', () => {
    const k = stashKey(1, 'claude')
    pushStash(k, { text: 'olha [📎 a.png]', attachments: [['[📎 a.png]', '/ups/a.png']], savedAt: 5 })
    expect(readStash(k)).toEqual([{ text: 'olha [📎 a.png]', attachments: [['[📎 a.png]', '/ups/a.png']], savedAt: 5 }])
  })

  it('pushStash diz se gravou de fato', () => {
    const k = stashKey(1, 'claude')
    expect(pushStash(k, entrada('ok'))).toBe(true)
    // cota estourada mesmo sem outros terminais para descartar: não gravou
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(pushStash(k, entrada('não cabe'))).toBe(false)
    vi.restoreAllMocks()
    expect(readStash(k).map((e) => e.text)).toEqual(['ok'])
  })

  it('lixo no localStorage vira lista vazia', () => {
    const k = stashKey(1, 'claude')
    localStorage.setItem(STASH_KEY, 'isto não é json')
    expect(readStash(k)).toEqual([])
    localStorage.setItem(STASH_KEY, JSON.stringify([1, 2, 3]))
    expect(readStash(k)).toEqual([])
    localStorage.setItem(STASH_KEY, JSON.stringify({ [k]: 'não é lista' }))
    expect(readStash(k)).toEqual([])
    // entradas estragadas no meio de boas: só as boas sobrevivem
    localStorage.setItem(STASH_KEY, JSON.stringify({
      [k]: [
        { text: 'boa', attachments: [], savedAt: 1 },
        { text: 3, attachments: [], savedAt: 1 },
        { text: 'anexo torto', attachments: [['só token']], savedAt: 1 },
        null,
        { text: 'sem data', attachments: [] },
      ],
    }))
    expect(readStash(k).map((e) => e.text)).toEqual(['boa'])
    // e dá para seguir guardando por cima do lixo
    pushStash(k, entrada('nova'))
    expect(readStash(k).map((e) => e.text)).toEqual(['boa', 'nova'])
  })

  it('cota cheia descarta os de outros terminais, não o atual', () => {
    const k = stashKey(1, 'claude')
    pushStash(stashKey(9, 'claude'), entrada('velho'))
    let estourar = true
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, v: string) {
      if (estourar && key === STASH_KEY && v.includes('velho')) throw new DOMException('quota', 'QuotaExceededError')
      real.call(this, key, v)
    })
    pushStash(k, entrada('o de agora'))
    estourar = false
    expect(readStash(k).map((e) => e.text)).toEqual(['o de agora'])
    expect(readStash(stashKey(9, 'claude'))).toEqual([])
  })

  it('sem armazenamento, segue sem guardar', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('bloqueado') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloqueado') })
    const k = stashKey(1, 'claude')
    expect(() => pushStash(k, entrada('x'))).not.toThrow()
    // e avisa que não guardou: quem chama não pode apagar o campo
    expect(pushStash(k, entrada('x'))).toBe(false)
    expect(readStash(k)).toEqual([])
    expect(popStash(k)).toBeUndefined()
  })
})
