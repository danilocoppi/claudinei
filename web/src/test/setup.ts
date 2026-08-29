import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

import i18n from '../i18n'
void i18n.changeLanguage('pt-BR') // asserções existentes são pt-BR

// jsdom não implementa Blob.prototype.arrayBuffer (gap conhecido: jsdom/jsdom#2555).
// pcmToWav() devolve um Blob e os testes leem os bytes de volta — sem isso, todo
// teste de WAV quebra com "arrayBuffer is not a function". Polyfill via FileReader,
// que o jsdom implementa de fato.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}

// O seletor de emoji observa a rolagem das categorias com IntersectionObserver,
// que o jsdom não implementa — sem isto, montar o seletor de ícone derruba a
// árvore inteira e o componente fica sem cobertura nenhuma.
if (typeof IntersectionObserver === 'undefined') {
  class Stub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds: number[] = []
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Stub
}

// O jsdom não implementa `matchMedia`, e o xterm consulta na abertura (ele checa
// preferências de contraste e movimento). Sem isto, montar um terminal em teste
// estoura antes de a tela existir.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// Idem para o ResizeObserver: o rodapé do chat mede a própria altura com ele para
// que a pílula da ação minimizada se afaste na medida certa.
if (!globalThis.ResizeObserver) {
  class Stub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Stub
}
