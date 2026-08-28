import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readDraft, saveDraft, DRAFTS_KEY } from '../drafts'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

/**
 * O texto digitado e não enviado sobrevive à troca de terminal. O `ChatInput` é
 * remontado a cada troca (`key={session.localId}`), então sem isto o que estava
 * escrito simplesmente sumia — e não havia como recuperá-lo.
 */
describe('rascunho por terminal', () => {
  it('guarda e devolve', () => {
    saveDraft('s1', 'metade de uma frase')
    expect(readDraft('s1')).toBe('metade de uma frase')
  })

  it('cada terminal tem o seu', () => {
    saveDraft('s1', 'texto do primeiro')
    saveDraft('s2', 'texto do segundo')
    expect(readDraft('s1')).toBe('texto do primeiro')
    expect(readDraft('s2')).toBe('texto do segundo')
  })

  it('terminal sem rascunho começa vazio', () => {
    expect(readDraft('nunca-usado')).toBe('')
  })

  /** Esvaziar o campo é apagar o rascunho, não gravar vazio — é assim que o envio
   *  limpa o que ficou para trás, sem precisar saber que rascunho existe. */
  it('texto vazio apaga a entrada', () => {
    saveDraft('s1', 'algo')
    saveDraft('s1', '')
    expect(readDraft('s1')).toBe('')
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({})
  })

  it('espaço em branco também conta como texto (é recuo, indentação)', () => {
    saveDraft('s1', '  ')
    expect(readDraft('s1')).toBe('  ')
  })

  it('sobrevive ao reload — mora no disco, não na memória', () => {
    saveDraft('s1', 'continua aqui')
    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY)!)).toEqual({ s1: 'continua aqui' })
  })

  it('armazenamento estragado é rascunho vazio, não erro', () => {
    localStorage.setItem(DRAFTS_KEY, 'isto não é json')
    expect(readDraft('s1')).toBe('')
    saveDraft('s1', 'agora vai')
    expect(readDraft('s1')).toBe('agora vai')
  })

  /**
   * Cota cheia não pode custar o que está sendo escrito AGORA: os rascunhos
   * antigos saem primeiro, e só eles.
   */
  it('cota estourada sacrifica os antigos, não o atual', () => {
    saveDraft('velho1', 'a')
    saveDraft('velho2', 'b')
    let estourar = true
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      // estoura enquanto ainda houver rascunho velho no que se tenta gravar
      if (estourar && k === DRAFTS_KEY && v.includes('velho1')) throw new DOMException('quota', 'QuotaExceededError')
      real.call(this, k, v)
    })
    saveDraft('atual', 'o que estou escrevendo')
    estourar = false
    expect(readDraft('atual')).toBe('o que estou escrevendo')
    expect(readDraft('velho1')).toBe('')
  })

  /** Sem localStorage (aba privada, navegador travado) nada quebra — só não guarda. */
  it('sem armazenamento, segue sem guardar', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('bloqueado') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloqueado') })
    expect(() => saveDraft('s1', 'x')).not.toThrow()
    expect(readDraft('s1')).toBe('')
  })
})
