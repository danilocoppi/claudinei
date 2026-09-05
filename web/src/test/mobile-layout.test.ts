import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Mesmo motivo do engine-tabs-overflow.test.ts para resolver o caminho assim.
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8')

// SÓ o bloco do celular: sem recortar, uma regra de desktop passaria por engano.
const inicio = css.indexOf('@media (max-width: 768px)')
const mobile = css.slice(inicio, css.indexOf('@media', inicio + 10))

describe('a altura do app acompanha a tela VISÍVEL', () => {
  it('.app usa dvh, com vh de fallback', () => {
    const regra = css.match(/^\.app \{[^}]*\}/m)?.[0] ?? ''
    // `100vh` no celular é a altura com a barra do navegador escondida: o rodapé
    // de digitação nascia abaixo da dobra e o teclado o cobria.
    expect(regra).toMatch(/height:\s*100vh/)
    expect(regra).toMatch(/height:\s*100dvh/)
  })

  it('a página pede que o teclado ENCOLHA o layout, não deslize por baixo dele', () => {
    expect(html).toMatch(/interactive-widget=resizes-content/)
    // Instalado como PWA a página vai até a borda — daí os env(safe-area-*).
    expect(html).toMatch(/viewport-fit=cover/)
  })
})

describe('campo de mensagem no celular', () => {
  it('ocupa a linha inteira; os botões descem para a segunda', () => {
    // Medido no aparelho antes disto: dos 390px de tela, mic + engrenagem +
    // Enviar comiam 165px e sobravam 177px para escrever.
    expect(mobile).toMatch(/\.chat-compose \{[^}]*flex-wrap:\s*wrap/)
    expect(mobile).toMatch(/\.chat-compose__area \{[^}]*flex:\s*1 0 100%/)
  })

  it('fonte de 16px no mínimo — abaixo disso o Safari do iPhone dá zoom ao focar', () => {
    const regra = mobile.match(/\.chat-compose__area \{[^}]*\}/)?.[0] ?? ''
    const px = Number(regra.match(/font-size:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? 0)
    expect(px).toBeGreaterThanOrEqual(16)
  })

  it('deixa passar a faixa do gesto embaixo da tela', () => {
    expect(mobile).toMatch(/\.chat-foot \{[^}]*env\(safe-area-inset-bottom\)/)
  })

  it('o estilo do rodapé vive no CSS, não no style inline do ChatInput', () => {
    // Isto é o que TORNA o resto possível: regra inline vence media query, e
    // enquanto padding/flex moravam no style={{}} do componente o celular não
    // tinha como reorganizar a linha de jeito nenhum.
    const tsx = readFileSync(join(here, '..', 'components', 'ChatInput.tsx'), 'utf8')
    expect(tsx).toMatch(/className="chat-foot"/)
    expect(tsx).toMatch(/className="chat-compose"/)
  })
})

describe('cabeçalho do chat cabe em UMA linha no celular', () => {
  it('não quebra linha e larga o que a topbar já mostra', () => {
    // Quebrando linha ele media 130px; com a topbar eram 185px dos 844px do
    // aparelho gastos antes da primeira mensagem aparecer.
    expect(mobile).toMatch(/\.chat-header \{[^}]*flex-wrap:\s*nowrap/)
    expect(mobile).toMatch(/\.chat-header__project \{\s*display:\s*none/)
    expect(mobile).toMatch(/\.chat-header \.btn-label \{\s*display:\s*none/)
  })

  it('a aba da engine larga o status por extenso — o pontinho já diz', () => {
    expect(mobile).toMatch(/\.engine-tab__status \{\s*display:\s*none/)
  })
})
