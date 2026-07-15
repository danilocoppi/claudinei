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
