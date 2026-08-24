import { describe, it, expect } from 'vitest'
import { isLoopbackIp, isLocalRequest } from '../src/auth/plugin.js'

/**
 * O gate de "só da máquina do servidor" libera coisas fortes: abrir editor,
 * revelar arquivo, e o `!comando` do chat, que é execução de shell. Ele tem que
 * olhar o PAR TCP de verdade.
 *
 * `req.ip` do Fastify vira o `X-Forwarded-For` quando `trustProxy` está ligado.
 * Hoje o app não liga — mas o dia em que alguém ligar, para pôr um nginx na
 * frente, a decisão de segurança passaria a vir de um cabeçalho que qualquer um
 * escreve. O par TCP não se forja.
 */
describe('quem está mesmo na outra ponta', () => {
  it('reconhece as formas de loopback', () => {
    for (const ip of ['127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackIp(ip), ip).toBe(true)
    }
  })

  it('não confunde endereço de rede com loopback', () => {
    for (const ip of ['10.0.0.9', '192.168.1.4', '1.2.3.4', '::ffff:10.0.0.9', '', '2001:db8::1']) {
      expect(isLoopbackIp(ip), ip).toBe(false)
    }
  })

  /** O nome parecido é a armadilha: 127.0.0.1.evil.com não é loopback nenhum. */
  it('não cai em nome que só parece', () => {
    for (const ip of ['127.0.0.1.evil.com', 'x127.0.0.1', '0127.0.0.1']) {
      expect(isLoopbackIp(ip), ip).toBe(false)
    }
  })

  it('lê o socket, não o cabeçalho', () => {
    const daRede = { ip: '127.0.0.1', socket: { remoteAddress: '10.0.0.9' } }
    expect(isLocalRequest(daRede as never), 'X-Forwarded-For forjado passou').toBe(false)

    const daMaquina = { ip: '10.0.0.9', socket: { remoteAddress: '127.0.0.1' } }
    expect(isLocalRequest(daMaquina as never)).toBe(true)
  })

  it('socket sem endereço não é local', () => {
    expect(isLocalRequest({ ip: '127.0.0.1', socket: {} } as never)).toBe(false)
  })
})
