import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
/** O corpo de todas as regras cujo seletor é exatamente `sel`, juntos. */
const regra = (sel: string) => {
  const esc = sel.replace(/[.,]/g, (c) => `\\${c}`).replace(/ /g, '\\s*')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';')
}

/**
 * Pergunta do agente mais alta que a tela (celular): o corpo do painel era
 * cortado pelo overflow e o rodapé, com o botão de responder, saía da tela sem
 * ter onde rolar. Agora o painel encolhe e só o corpo rola; cabeçalho e rodapé
 * ficam sempre à vista. E o "ir para o fim" some com a conversa espremida.
 */
describe('painel de pergunta numa tela baixa', () => {
  it('o painel pode encolher e o corpo rola', () => {
    expect(regra('.qpanel')).toMatch(/min-height:\s*0/)
    expect(regra('.qpanel__body')).toMatch(/overflow-y:\s*auto/)
    expect(regra('.qpanel__body')).toMatch(/min-height:\s*0/)
  })

  it('cabeçalho e rodapé não encolhem', () => {
    expect(regra('.qpanel__head, .qpanel__foot')).toMatch(/flex:\s*none/)
  })

  it('o "ir para o fim" some quando a área da conversa fica espremida', () => {
    expect(regra('.chat-scroll-wrap')).toMatch(/container-type:\s*size/)
    expect(css).toMatch(/@container chat-scroll \(max-height: 90px\) \{ \.chat-scroll-wrap > \.chat-tofoot \{ display: none; \} \}/)
  })
})
