import { describe, it, expect } from 'vitest'
import { isSafeIconBody } from '../src/icons/safety.js'

/**
 * O miolo do SVG vem de um terceiro (api.iconify.design) e é injetado como HTML no
 * navegador. Se aquele servidor fosse comprometido, um `onload=` num `<image>`
 * rodaria script dentro da sessão de quem só queria escolher um ícone.
 *
 * A defesa é RECUSAR, não limpar: um desenho de ícone é um punhado de formas
 * geométricas, e o que não se parece com isso simplesmente não entra no cache. Um
 * limpador erra pela metade; uma lista branca erra fechando a porta — e o pior que
 * acontece é um ícone não aparecer.
 */
describe('o que é um desenho de ícone', () => {
  it('aceita as formas de que um ícone é feito', () => {
    for (const body of [
      '<path fill="currentColor" d="M4 1h16a1 1 0 0 1 1 1z"/>',
      '<circle cx="12" cy="12" r="9"/><rect x="1" y="2" width="4" height="4"/>',
      '<g fill="none" stroke="currentColor"><polyline points="1,2 3,4"/><line x1="0" y1="0" x2="9" y2="9"/></g>',
      '<defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0"/>',
      '<ellipse cx="5" cy="5" rx="2" ry="3"/><polygon points="0,0 5,5 0,5"/>',
    ]) expect(isSafeIconBody(body), body).toBe(true)
  })

  it('recusa o que executa', () => {
    for (const body of [
      '<script>fetch("/api/projects")</script>',
      '<path d="M0 0" onload="alert(1)"/>',
      '<image href="x" onerror="alert(1)"/>',
      '<foreignObject><img src=x onerror="alert(1)"></foreignObject>',
      '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
      '<animate onbegin="alert(1)" attributeName="x"/>',
      '<path d="M0 0" style="background:url(javascript:alert(1))"/>',
      '<iframe src="//evil"></iframe>',
      '<set onbegin="alert(1)"/>',
    ]) expect(isSafeIconBody(body), body).toBe(false)
  })

  /** Referência externa é vazamento (e pedido a servidor de terceiro por render). */
  it('recusa referência que sai da página', () => {
    expect(isSafeIconBody('<use href="https://evil/x.svg#a"/>')).toBe(false)
    expect(isSafeIconBody('<use xlink:href="//evil/x.svg#a"/>')).toBe(false)
    expect(isSafeIconBody('<use href="#local"/>')).toBe(true)
  })

  it('recusa desenho vazio ou gigante (não é ícone)', () => {
    expect(isSafeIconBody('')).toBe(false)
    expect(isSafeIconBody('   ')).toBe(false)
    expect(isSafeIconBody(`<path d="${'M0 0'.repeat(40000)}"/>`)).toBe(false)
  })

  /** Maiúsculas e espaços esquisitos não podem ser um jeito de passar. */
  it('não se engana com disfarce', () => {
    expect(isSafeIconBody('<SCRIPT>alert(1)</SCRIPT>')).toBe(false)
    expect(isSafeIconBody('<path d="M0 0" OnLoad="alert(1)"/>')).toBe(false)
    expect(isSafeIconBody('<path\n  d="M0 0"\n  on\tload="x"/>')).toBe(false)
  })
})
