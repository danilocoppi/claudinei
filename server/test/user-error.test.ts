import { describe, it, expect } from 'vitest'
import { UserError, errorBody } from '../src/user-error.js'

/**
 * O texto do erro continua em português (logs e clientes da API leem `error`);
 * o `code` e os `params` deixam a interface traduzir para o idioma escolhido.
 */
describe('errorBody', () => {
  it('erro da tela leva código e parâmetros junto do texto', () => {
    expect(errorBody(new UserError('folder_exists', 'a pasta já existe: /x', { path: '/x' })))
      .toEqual({ error: 'a pasta já existe: /x', code: 'folder_exists', params: { path: '/x' } })
  })
  it('erro comum vai só com o texto, como antes', () => {
    expect(errorBody(new Error('falhou'))).toEqual({ error: 'falhou' })
  })
  it('código de erro do sistema (EEXIST, ENOENT) não vira código da tela', () => {
    expect(errorBody(Object.assign(new Error('x'), { code: 'EEXIST' }))).toEqual({ error: 'x' })
  })
})
