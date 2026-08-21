import { describe, it, expect } from 'vitest'
import { isIconValue } from '../src/icons/value.js'

/**
 * O defeito relatado: escolher um ícone para um GRUPO, clicar em Salvar, e nada
 * acontecer.
 *
 * O validador do grupo tinha um teto de 16 caracteres, de quando ícone era só
 * emoji. Um token do acervo passa ou não passa conforme o COMPRIMENTO do nome:
 *
 *   mdi:server                     10  passava
 *   tabler:credit-card             18  400 "ícone inválido"
 *   material-symbols:rocket-launch 30  400 "ícone inválido"
 *
 * E como o cliente engolia o erro, o Salvar simplesmente não fazia nada. O
 * terminal nunca sofreu disso porque a rota dele não validava nada — os dois
 * extremos do mesmo descuido.
 */
describe('o que serve como ícone', () => {
  it('aceita token do acervo, do curto ao comprido', () => {
    for (const v of [
      'mdi:server', 'lucide:wallet', 'tabler:credit-card', 'simple-icons:react',
      'material-symbols:rocket-launch', 'material-symbols-light:store-outline-rounded',
      'si:react', 'lu:terminal',
    ]) expect(isIconValue(v), v).toBe(true)
  })

  it('aceita emoji, inclusive os compostos', () => {
    for (const v of ['📁', '🗂️', '🇧🇷', '👨‍👩‍👧‍👦', '🧑🏽‍💻', '🅰️']) expect(isIconValue(v), v).toBe(true)
  })

  /** Um ícone é um desenho, não um recado: o que não tem essa cara vira texto na tela. */
  it('recusa texto solto no lugar do ícone', () => {
    for (const v of ['uma frase inteira aqui', 'nome com espaço', 'a'.repeat(40), '']) {
      expect(isIconValue(v), JSON.stringify(v)).toBe(false)
    }
  })

  it('recusa o que nem string é', () => {
    for (const v of [null, undefined, 42, {}, ['📁']]) expect(isIconValue(v), String(v)).toBe(false)
  })

  /** Quebra de linha e controle não desenham nada e sujam o layout. */
  it('recusa controle e espaço em branco', () => {
    for (const v of ['\n', '📁\n📁', '  ', '\t']) expect(isIconValue(v), JSON.stringify(v)).toBe(false)
  })

  it('apara o que veio com espaço em volta', () => {
    expect(isIconValue('  mdi:server  ')).toBe(true)
  })
})
