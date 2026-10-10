import { describe, it, expect } from 'vitest'
import { isTyping } from '../src/terminal/typing.js'

/**
 * O xterm do navegador também escreve sozinho no PTY — foco, mouse, resposta a
 * consultas do programa. Nada disso é a pessoa mexendo no terminal, e contar
 * faria a coluna de rostinhos reordenar só por abrir a tela para ler.
 */
describe('isTyping: o que chegou do terminal foi digitação?', () => {
  it.each([
    ['letra', 'a'],
    ['Enter', '\r'],
    ['Backspace', '\x7f'],
    ['Ctrl+C', '\x03'],
    ['Esc sozinho (interromper o agente)', '\x1b'],
    ['Alt+letra', '\x1bx'],
    ['colagem entre marcadores', '\x1b[200~git status\x1b[201~'],
    ['texto com foco no meio', 'x\x1b[I'],
  ])('%s conta', (_nome, dado) => {
    expect(isTyping(dado)).toBe(true)
  })

  it.each([
    ['foco entrou', '\x1b[I'],
    ['foco saiu', '\x1b[O'],
    ['mouse SGR (rolar ou clicar)', '\x1b[<64;10;5M'],
    ['mouse no formato antigo, com bytes imprimíveis', '\x1b[M !!'],
    ['posição do cursor', '\x1b[12;40R'],
    ['atributos do terminal', '\x1b[?1;2c'],
    ['cor de fundo (OSC com ST)', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['cor do texto (OSC com BEL)', '\x1b]10;rgb:ffff/ffff/ffff\x07'],
    ['seta', '\x1b[A'],
    ['seta no modo aplicação', '\x1bOA'],
    ['vazio', ''],
  ])('%s não conta', (_nome, dado) => {
    expect(isTyping(dado)).toBe(false)
  })
})
