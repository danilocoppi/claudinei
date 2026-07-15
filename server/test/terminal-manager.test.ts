import { describe, it, expect } from 'vitest'
import { createTerminalManager } from '../src/terminal/manager.js'
import type { PtyProcess } from '../src/terminal/pty.js'

function makeFakePty() {
  let dataCb: (d: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let killed = false
  const proc: PtyProcess = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    write: (d) => { writes.push(d) },
    resize: (cols, rows) => { resizes.push({ cols, rows }) },
    kill: () => { killed = true; exitCb({ exitCode: 0 }) },
  }
  return { proc, emit: (d: string) => dataCb(d), exit: (c = 0) => exitCb({ exitCode: c }), writes, resizes, get killed() { return killed } }
}

function makeSocket() {
  const sent: string[] = []
  return { sent, readyState: 1 as number, send: (d: string) => { sent.push(d) } }
}

function setup() {
  const fakes: ReturnType<typeof makeFakePty>[] = []
  const factory = () => { const f = makeFakePty(); fakes.push(f); return f.proc }
  const tm = createTerminalManager({ ptyFactory: factory })
  return { tm, fakes }
}

const OPTS = { cwd: '/tmp', file: 'claude', args: ['--resume', 'sid-1', '--dangerously-skip-permissions'], onExit: () => {} }

describe('TerminalManager', () => {
  it('open cria PTY, retorna token e has() vira true', () => {
    const { tm, fakes } = setup()
    const token = tm.open('l1', OPTS)
    expect(token).toMatch(/^[a-f0-9]+$/)
    expect(tm.has('l1')).toBe(true)
    expect(fakes).toHaveLength(1)
  })

  it('attach valida token, replaya buffer e recebe dados novos', () => {
    const { tm, fakes } = setup()
    const token = tm.open('l1', OPTS)
    fakes[0].emit('linha-anterior')
    const sock = makeSocket()
    expect(tm.attach('l1', sock, token)).toBe(true)
    expect(sock.sent.join('')).toContain('linha-anterior')
    fakes[0].emit('ao-vivo')
    expect(sock.sent.join('')).toContain('ao-vivo')
  })

  it('attach com token errado é rejeitado', () => {
    const { tm } = setup()
    tm.open('l1', OPTS)
    expect(tm.attach('l1', makeSocket(), 'errado')).toBe(false)
  })

  it('write e resize chegam ao PTY', () => {
    const { tm, fakes } = setup()
    tm.open('l1', OPTS)
    tm.write('l1', 'y\r')
    tm.resize('l1', 120, 40)
    expect(fakes[0].writes).toContain('y\r')
    expect(fakes[0].resizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('buffer respeita o limite de 256 KB', () => {
    const { tm, fakes } = setup()
    tm.open('l1', OPTS)
    fakes[0].emit('x'.repeat(300 * 1024))
    const sock = makeSocket()
    tm.attach('l1', sock, tm.open('l1', OPTS)) // reusa entry vivo, token novo
    expect(sock.sent.join('').length).toBeLessThanOrEqual(256 * 1024)
  })

  it('open em localId já vivo reusa o PTY e devolve token novo', () => {
    const { tm, fakes } = setup()
    const t1 = tm.open('l1', OPTS)
    const t2 = tm.open('l1', OPTS)
    expect(fakes).toHaveLength(1)
    expect(t2).not.toBe(t1)
  })

  it('close mata o PTY e dispara onExit', () => {
    let exited = false
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const tm = createTerminalManager({ ptyFactory: () => { const f = makeFakePty(); fakes.push(f); return f.proc } })
    tm.open('l1', { ...OPTS, onExit: () => { exited = true } })
    tm.close('l1')
    expect(fakes[0].killed).toBe(true)
    expect(exited).toBe(true)
    expect(tm.has('l1')).toBe(false)
  })

  it('PTY que sai sozinho avisa os clientes e dispara onExit', () => {
    let exited = false
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const tm = createTerminalManager({ ptyFactory: () => { const f = makeFakePty(); fakes.push(f); return f.proc } })
    const token = tm.open('l1', { ...OPTS, onExit: () => { exited = true } })
    const sock = makeSocket()
    tm.attach('l1', sock, token)
    fakes[0].exit(0)
    expect(sock.sent.join('')).toContain('sessão encerrada')
    expect(exited).toBe(true)
    expect(tm.has('l1')).toBe(false)
  })

  it('closeAndWait resolve só depois do exit REAL do PTY (status já persistido)', async () => {
    // fake com kill assíncrono: o exit só vem quando o teste mandar — como o node-pty real
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const factory = () => { const f = makeFakePty(); f.proc.kill = () => {}; fakes.push(f); return f.proc }
    let exited = false
    const tm = createTerminalManager({ ptyFactory: factory })
    tm.open('l1', { ...OPTS, onExit: () => { exited = true } })
    let resolved = false
    const p = tm.closeAndWait('l1', 3000).then(() => { resolved = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false) // ainda esperando o exit real
    fakes[0].exit(0)             // PTY morre de fato → onExit persiste status ANTES do resolve
    await p
    expect(resolved).toBe(true)
    expect(exited).toBe(true)
  })

  it('closeAndWait com PTY que nunca sai resolve pelo timeout (não trava a rota)', async () => {
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const factory = () => { const f = makeFakePty(); f.proc.kill = () => {}; fakes.push(f); return f.proc }
    const tm = createTerminalManager({ ptyFactory: factory })
    tm.open('l1', OPTS)
    const t0 = Date.now()
    await tm.closeAndWait('l1', 60)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
  })

  it('closeAndWait de localId inexistente resolve na hora', async () => {
    const { tm } = setup()
    await tm.closeAndWait('nao-existe', 1000)
  })

  it('close() seguido de open() no mesmo localId cria um PTY novo (sem reusar o que está morrendo)', () => {
    const { tm, fakes } = setup()
    tm.open('l1', OPTS)
    tm.close('l1')
    tm.open('l1', OPTS)
    expect(fakes).toHaveLength(2)
  })

  it('exit assíncrono de um PTY antigo não apaga a entry nova do mesmo localId', () => {
    // node-pty real dispara onExit de forma assíncrona; aqui controlamos o timing
    // usando um fake cujo kill() NÃO dispara exit sozinho.
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const factory = () => {
      const f = makeFakePty()
      // sobrescreve kill para não emitir exit imediatamente (simula assíncrono real)
      f.proc.kill = () => {}
      fakes.push(f)
      return f.proc
    }
    const tm = createTerminalManager({ ptyFactory: factory })
    tm.open('l1', OPTS)     // entry A (fakes[0])
    tm.close('l1')          // marca A como exited, kill não emite
    tm.open('l1', OPTS)     // entry B (fakes[1]) — A ainda não emitiu exit
    fakes[0].exit(0)        // agora A emite exit tardio
    expect(tm.has('l1')).toBe(true) // B continua viva; o exit tardio de A não a apagou
  })

  it('refreshToken rotaciona e devolve o token de uma entry viva; null se ausente/morta', () => {
    const { tm, fakes } = setup()
    const t1 = tm.open('l1', OPTS)
    const t2 = tm.refreshToken('l1')
    expect(t2).toBeTruthy()
    expect(t2).not.toBe(t1)
    // token antigo não anexa mais; o novo sim
    expect(tm.attach('l1', makeSocket(), t1!)).toBe(false)
    expect(tm.attach('l1', makeSocket(), t2!)).toBe(true)
    expect(tm.refreshToken('ausente')).toBeNull()
    fakes[0].exit(0)
    expect(tm.refreshToken('l1')).toBeNull()
  })
})
