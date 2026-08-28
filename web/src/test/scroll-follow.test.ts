import { describe, it, expect } from 'vitest'
import { isAtBottom, SLACK } from '../scrollFollow'

const caixa = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) =>
  ({ scrollTop, scrollHeight, clientHeight })

/**
 * Quem manda no auto-scroll é a barra de rolagem, não um botão: subir para ler é
 * o gesto que solta a tela, e voltar ao fim é o que a prende de novo. É a regra
 * de todo chat e de todo `tail -f` — e a mais ágil possível, porque não custa
 * nenhum clique.
 */
describe('estou no fim da rolagem?', () => {
  it('encostado no fim, sim', () => {
    expect(isAtBottom(caixa(600))).toBe(true)
  })

  it('lá em cima, não', () => {
    expect(isAtBottom(caixa(0))).toBe(false)
    expect(isAtBottom(caixa(200))).toBe(false)
  })

  /**
   * A folga existe porque "no fim" nunca é exato: a última linha que chega muda a
   * altura entre o cálculo e a pintura, e um sub-pixel de sobra soltaria a tela
   * sozinho no meio do streaming.
   */
  it('uns pixels de sobra ainda contam como fim', () => {
    expect(isAtBottom(caixa(600 - SLACK + 5))).toBe(true)
    expect(isAtBottom(caixa(600 - SLACK - 5))).toBe(false)
  })

  /** Conversa que ainda não enche a tela: não há para onde rolar, e isso é o fim. */
  it('conteúdo menor que a janela é sempre o fim', () => {
    expect(isAtBottom(caixa(0, 300, 400))).toBe(true)
  })

  it('rolagem negativa (elástico do trackpad) não solta a tela', () => {
    expect(isAtBottom(caixa(620))).toBe(true)
  })
})
