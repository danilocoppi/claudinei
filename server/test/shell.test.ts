import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell, MAX_OUTPUT, shellFor } from '../src/shell.js'

const dir = () => mkdtempSync(join(tmpdir(), 'sh-'))

/**
 * `!ls` no chat: um atalho para olhar a pasta sem pedir à engine.
 *
 * Não amplia o que já era possível — os agentes rodam com
 * `--dangerously-skip-permissions`, então quem conversa com um terminal já
 * consegue pedir "roda ls". O que muda é a fricção. Mesmo assim vale só da
 * máquina do servidor (ver a rota), e com teto de tempo e de tamanho: um
 * `tail -f` sem eles prenderia a conversa para sempre.
 */
describe('rodar um comando', () => {
  it('devolve a saída', async () => {
    const r = await runShell('echo oi', dir())
    expect(r.output.trim()).toBe('oi')
    expect(r.isError).toBe(false)
  })

  it('roda NA PASTA do terminal', async () => {
    const d = dir()
    writeFileSync(join(d, 'marca.txt'), 'x')
    expect((await runShell('ls', d)).output).toContain('marca.txt')
  })

  /** Pipe, glob e `&&` são o motivo de existir um shell aqui, e não um spawn cru. */
  it('é um shell de verdade', async () => {
    const r = await runShell('echo um && echo dois | tr a-z A-Z', dir())
    expect(r.output).toContain('um')
    expect(r.output).toContain('DOIS')
  })

  it('comando que falha vira erro, com o motivo', async () => {
    const r = await runShell('ls /nao/existe/mesmo', dir())
    expect(r.isError).toBe(true)
    expect(r.output.toLowerCase()).toMatch(/no such file|não|not found/)
  })

  it('comando vazio não vira execução', async () => {
    expect((await runShell('   ', dir())).output).toMatch(/vazio|empty/i)
  })

  /** Sem teto, `tail -f` deixaria a conversa presa até alguém reiniciar o serviço. */
  it('mata quem passa do tempo e diz que matou', async () => {
    const r = await runShell('sleep 5', dir(), { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(r.isError).toBe(true)
  }, 10000)

  /** Nem `cat` de um arquivo enorme pode virar uma mensagem de 40 MB. */
  it('corta saída gigante e avisa', async () => {
    const r = await runShell(`yes abcdefghij | head -c ${MAX_OUTPUT * 2}`, dir())
    expect(r.truncated).toBe(true)
    expect(r.output.length).toBeLessThanOrEqual(MAX_OUTPUT + 200)
  }, 15000)

  /**
   * O Claudinei roda com um libstdc++ portátil no LD_LIBRARY_PATH, e todo filho
   * herda — foi o que fazia "Abrir terminal" não abrir nada. Um comando digitado
   * aqui tem que nascer no ambiente do SISTEMA, pelo mesmo motivo.
   */
  it('não passa adiante o LD_LIBRARY_PATH do Claudinei', async () => {
    // Ambiente REAL mais a injeção: o `-lc` carrega o .profile do usuário, e um
    // env pelado (sem HOME) faria o profile reclamar e sujar a saída.
    const r = await runShell('echo "[$LD_LIBRARY_PATH]"', dir(), {
      env: { ...process.env, LD_LIBRARY_PATH: '/cache/claudinei/stdcxx', CLAUDINEI_ORIG_LD_LIBRARY_PATH: '' },
    })
    expect(r.output.trim()).toBe('[]')
  })

  it('junta stderr com stdout, na ordem em que saíram', async () => {
    const r = await runShell('echo antes; echo meio >&2; echo depois', dir())
    for (const parte of ['antes', 'meio', 'depois']) expect(r.output, parte).toContain(parte)
  })
})

/**
 * `bash -lc` vira pai de outros processos. No estouro do tempo é o GRUPO inteiro
 * que tem que morrer: matar só o shell deixaria o neto rodando, órfão, segurando
 * os canos abertos — e a promessa nunca resolveria.
 */
describe('o timeout leva os filhos junto', () => {
  it('não deixa neto órfão', async () => {
    const d = dir()
    const marca = join(d, 'vivo.txt')
    // o neto escreveria a marca 3s depois; se ele morrer junto, ela nunca aparece
    const r = await runShell(`(sleep 3; touch ${marca}) & wait`, d, { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    await new Promise((res) => setTimeout(res, 3500))
    expect(existsSync(marca), 'o neto sobreviveu ao timeout').toBe(false)
  }, 15000)
})

/**
 * O ramo do Windows não roda nesta máquina, então fica fixado aqui.
 *
 * O `&&` funciona nos dois shells — o `cmd.exe` o suporta com o mesmo sentido de
 * "só siga se deu certo". O que NÃO funciona sozinho é o quoting: sem o modo
 * verbatim, o libuv escapa as aspas do comando à moda do compilador C (`\"`), e o
 * cmd não trata `\` como escape — um `!git commit -m "oi"` chegaria com barras
 * literais e a mensagem partida ao meio.
 */
describe('o shell de cada sistema', () => {
  it('no Unix é bash de login', () => {
    expect(shellFor('linux')).toEqual({ bin: '/bin/bash', flag: '-lc', verbatim: false })
  })

  it('no Windows é o cmd, e sem o quoting automático', () => {
    const { bin, flag, verbatim } = shellFor('win32')
    expect([bin, flag]).toEqual(['cmd.exe', '/c'])
    expect(verbatim, 'sem verbatim, as aspas do comando chegam escapadas com \\').toBe(true)
  })
})
