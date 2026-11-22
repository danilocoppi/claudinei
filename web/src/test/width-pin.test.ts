import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { prenderFimNaLargura, PRENDER_MS } from '../chat/widthPin'

/**
 * A largura da rolagem do chat que muda (coluna da direita abrindo ou
 * fechando) com a tela no fim: ela volta ao fim e SEGUE presa por um instante,
 * porque a lista virtual remede os itens 15–30 ms depois e recua a posição
 * para manter o item do topo — no navegador real, 11323→10223 ao fechar o
 * Navegador. Caixa e relógio falsos; o observador de tamanho é um dublê.
 */
type Caixa = HTMLElement & { medir: (h: number, w: number) => void; rolar: (top: number) => void }

function caixaFalsa(scrollHeight: number, clientWidth: number, clientHeight = 600): Caixa {
  const el = document.createElement('div') as unknown as Caixa
  let top = scrollHeight - clientHeight
  let h = scrollHeight
  let w = clientWidth
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    // Como no navegador: a posição fica entre 0 e o máximo, e mudar avisa `scroll`.
    set: (v: number) => { top = Math.max(0, Math.min(v, h - clientHeight)); el.dispatchEvent(new Event('scroll')) },
    configurable: true,
  })
  Object.defineProperty(el, 'scrollHeight', { get: () => h, configurable: true })
  Object.defineProperty(el, 'clientWidth', { get: () => w, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true })
  el.medir = (nh, nw) => { h = nh; w = nw; top = Math.min(top, h - clientHeight) }
  el.rolar = (v) => { el.scrollTop = v }
  return el
}

let avisar: (() => void) | null
let desligados: number
beforeEach(() => {
  avisar = null
  desligados = 0
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { avisar = cb }
    observe() {}
    unobserve() {}
    disconnect() { desligados++ }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const dist = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

function montar(el: Caixa, presa = () => true) {
  let agora = 1000
  const p = prenderFimNaLargura(el, presa, () => agora)
  avisar!() // a primeira medida é a de partida
  return { p, passar: (ms: number) => { agora += ms } }
}

describe('prenderFimNaLargura', () => {
  it('a coluna que fecha: a lista que remede e recua a posição logo depois não tira a tela do fim', () => {
    const el = caixaFalsa(12000, 625)
    const { p, passar } = montar(el)
    // Fecha: mais largura, menos linhas, a conversa encolhe.
    el.medir(11800, 1250)
    avisar!()
    expect(dist(el)).toBe(0)
    // 20 ms depois a lista remede os itens, recua para manter o item do topo
    // e avisa a altura total nova.
    passar(20)
    el.rolar(10223)
    el.medir(11700, 1250)
    p.alturaMudou()
    expect(dist(el)).toBe(0)
  })

  it('o `scroll` sozinho não puxa: quem prende é a altura total que muda (puxar a cada `scroll` brigou com a lista)', () => {
    const el = caixaFalsa(12000, 625)
    const { passar } = montar(el)
    el.medir(11800, 1250)
    avisar!()
    passar(20)
    el.rolar(10223)
    expect(el.scrollTop).toBe(10223)
  })

  it('a altura total que se acomoda depois (sem `scroll`) também volta ao fim', () => {
    const el = caixaFalsa(12000, 625)
    const { p, passar } = montar(el)
    el.medir(11800, 1250)
    avisar!()
    passar(30)
    el.medir(12400, 1250)
    p.alturaMudou()
    expect(dist(el)).toBe(0)
  })

  it('passado o instante da mudança, um recuo não é mais da largura: a tela fica onde foi posta', () => {
    const el = caixaFalsa(12000, 625)
    const { p, passar } = montar(el)
    el.medir(11800, 1250)
    avisar!()
    passar(PRENDER_MS + 1)
    el.rolar(9000)
    expect(el.scrollTop).toBe(9000)
    el.medir(12400, 1250)
    p.alturaMudou()
    expect(el.scrollTop).toBe(9000)
  })

  it('um gesto do operador no meio solta na hora', () => {
    const el = caixaFalsa(12000, 625)
    const { p, passar } = montar(el)
    el.medir(11800, 1250)
    avisar!()
    passar(10)
    p.gesto()
    el.rolar(9000)
    expect(el.scrollTop).toBe(9000)
  })

  it('lendo mais acima, a largura que muda não leva a tela ao fim', () => {
    const el = caixaFalsa(12000, 625)
    const { passar } = montar(el)
    el.rolar(5000)
    el.medir(11800, 1250)
    avisar!()
    expect(el.scrollTop).toBe(5000)
    passar(20)
    el.rolar(4800)
    expect(el.scrollTop).toBe(4800)
  })

  it('no fim mas solta pela lista (grupo de ações aberto no fim), a largura que muda não prende', () => {
    const el = caixaFalsa(12000, 625)
    const { passar } = montar(el, () => false)
    el.medir(12600, 625)
    el.medir(13200, 1250)
    avisar!()
    expect(el.scrollTop).toBe(12000 - 600)
    passar(20)
    el.rolar(11000)
    expect(el.scrollTop).toBe(11000)
  })

  it('o `scroll` do reflow, já na largura nova, não apaga o "no fim" de antes', () => {
    const el = caixaFalsa(7200, 500)
    montar(el)
    // A ancoragem do navegador deixa a posição no meio, e o `scroll` chega antes do observador.
    el.medir(6600, 800)
    el.rolar(5500)
    avisar!()
    expect(dist(el)).toBe(0)
  })

  it('só a altura que muda (mesma largura) não mexe na tela', () => {
    const el = caixaFalsa(12000, 625)
    const { p } = montar(el)
    el.medir(12400, 625)
    avisar!()
    p.alturaMudou()
    expect(el.scrollTop).toBe(12000 - 600)
  })

  it('soltar desliga o observador e o `scroll`', () => {
    const el = caixaFalsa(12000, 625)
    const { p } = montar(el)
    el.medir(11800, 1250)
    avisar!()
    p.soltar()
    expect(desligados).toBe(1)
    el.rolar(9000)
    expect(el.scrollTop).toBe(9000)
  })
})
