import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, openSync, writeSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFromTail } from '../src/tail.js'
import { parseRollout } from '../src/engine/codex/rollout.js'
import { readTranscript } from '../src/history.js'

/**
 * Histórico que sumia: o chat do Codex voltava VAZIO ao trocar de terminal ou
 * depois de reiniciar o serviço.
 *
 * Não era a sessão perdida nem o id: o rollout estava lá, com o id certo. O
 * arquivo é que tinha 5,5 GB — e `readFile` recusa acima de 2 GiB ("File size
 * is greater than 2 GiB"). O `catch { return [] }` transformava esse erro em
 * "conversa vazia", sem aviso nenhum. Só o Codex chegava nesse tamanho: ele
 * grava world_state e item_completed a cada passo, e o maior transcript do
 * Claude na mesma máquina tinha 232 MB.
 *
 * A leitura inteira nunca fez sentido, aliás: a rota devolve só os últimos 300
 * eventos. Agora se lê pela cauda, em blocos que crescem até juntar o que a
 * tela vai usar. Medido no arquivo real de 5,5 GB: 256 MB de cauda saem em
 * ~80 ms de leitura.
 */

const TMPs: string[] = []
const novoDir = (nome: string) => {
  const d = mkdtempSync(join(tmpdir(), nome))
  TMPs.push(d)
  return d
}
afterEach(() => {
  for (const d of TMPs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Arquivo ESPARSO: as linhas ficam depois de um buraco de `offset` bytes, então
 * o `size` passa dos 2 GiB sem gastar disco de verdade. É a única forma honesta
 * de testar o limite do Node sem escrever gigabytes num teste.
 */
function escreverDepoisDoBuraco(file: string, offset: number, linhas: unknown[]): void {
  // O `\n` inicial faz o buraco terminar como uma linha própria — que é o que
  // acontece num log de verdade, onde a linha anterior já fechou. Sem ele o lixo
  // grudaria na primeira mensagem, e descartá-la seria o certo a fazer.
  const corpo = Buffer.from('\n' + linhas.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const fd = openSync(file, 'w')
  try { writeSync(fd, corpo, 0, corpo.length, offset) } finally { closeSync(fd) }
}

const DOIS_GIB = 2 * 1024 * 1024 * 1024

const msgUsuario = (text: string) =>
  ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const msgAssistente = (text: string) =>
  ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

describe('rollout do Codex maior que 2 GiB', () => {
  const criar = (linhas: unknown[]) => {
    const dir = novoDir('tail-codex-')
    const file = join(dir, 'rollout-2026-09-10T01-05-45-01a0897e.jsonl')
    escreverDepoisDoBuraco(file, DOIS_GIB + 1024, linhas)
    expect(statSync(file).size, 'o arquivo do teste precisa passar dos 2 GiB').toBeGreaterThan(DOIS_GIB)
    return file
  }

  it('entrega a conversa em vez de devolver vazio', async () => {
    const file = criar([msgUsuario('o que falta?'), msgAssistente('só o deploy')])
    const eventos = await parseRollout(file)
    expect(eventos, 'histórico vazio num arquivo que TEM a conversa').toHaveLength(2)
    expect(eventos[0]).toMatchObject({ kind: 'user' })
    expect((eventos[1] as any).message.content[0].text).toBe('só o deploy')
  })

  /** O buraco vira lixo binário na leitura: não pode virar evento nem exceção. */
  it('o trecho ilegível antes das linhas não vira evento', async () => {
    const eventos = await parseRollout(criar([msgAssistente('fim')]))
    expect(eventos).toHaveLength(1)
  })
})

describe('leitura pela cauda', () => {
  const arquivoCom = (linhas: string[]): string => {
    const dir = novoDir('tail-')
    const file = join(dir, 'dados.jsonl')
    const fd = openSync(file, 'w')
    const corpo = Buffer.from(linhas.join('\n') + '\n')
    try { writeSync(fd, corpo, 0, corpo.length, 0) } finally { closeSync(fd) }
    return file
  }

  it('arquivo pequeno: lê inteiro, do começo ao fim', async () => {
    const file = arquivoCom(['a', 'b', 'c'])
    const linhas = await parseFromTail(file, (t) => t.split('\n').filter(Boolean), { minItems: 100 })
    expect(linhas).toEqual(['a', 'b', 'c'])
  })

  /** A primeira linha de um bloco cortado está pela metade — usá-la inventaria
   *  um evento truncado. Só o começo REAL do arquivo aproveita a primeira. */
  it('bloco cortado descarta a linha partida ao meio', async () => {
    const file = arquivoCom(['linha-inteira-numero-um', 'dois', 'tres'])
    const linhas = await parseFromTail(file, (t) => t.split('\n').filter(Boolean), {
      minItems: 1, firstChunkBytes: 12, // cai no meio da última linha para trás
    })
    expect(linhas).not.toContain('linha-inteira-numero-um')
    expect(linhas.at(-1)).toBe('tres')
  })

  /** Cresce até juntar o que a tela pede, em vez de parar no primeiro bloco. */
  it('aumenta a janela até alcançar o mínimo pedido', async () => {
    const file = arquivoCom(Array.from({ length: 400 }, (_, i) => `l${i}`))
    const linhas = await parseFromTail(file, (t) => t.split('\n').filter(Boolean), {
      minItems: 300, firstChunkBytes: 64,
    })
    expect(linhas.length).toBeGreaterThanOrEqual(300)
    expect(linhas.at(-1)).toBe('l399')
  })

  /** Teto: um arquivo absurdo não pode virar leitura de gigabytes por request. */
  it('respeita o teto de bytes mesmo sem alcançar o mínimo', async () => {
    const file = arquivoCom(Array.from({ length: 400 }, (_, i) => `l${i}`))
    const linhas = await parseFromTail(file, (t) => t.split('\n').filter(Boolean), {
      minItems: 400, firstChunkBytes: 32, maxBytes: 64,
    })
    expect(linhas.length).toBeLessThan(400)
    expect(linhas.at(-1)).toBe('l399')
  })

  it('arquivo que não existe → vazio, sem lançar', async () => {
    expect(await parseFromTail('/nao/existe.jsonl', (t) => t.split('\n'), {})).toEqual([])
  })
})

/** O mesmo `readFile` estava no transcript do Claude — mesma falha esperando o
 *  mesmo tamanho. O maior em uso hoje tem 232 MB; o limite é 2 GiB. */
describe('transcript do Claude maior que 2 GiB', () => {
  it('entrega a conversa em vez de devolver vazio', async () => {
    const cfg = novoDir('tail-claude-')
    const projeto = '/home/eu/proj'
    const dir = join(cfg, 'projects', '-home-eu-proj')
    mkdirSync(dir, { recursive: true })
    const id = '11111111-2222-3333-4444-555555555555'
    escreverDepoisDoBuraco(join(dir, `${id}.jsonl`), DOIS_GIB + 1024, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'e aí?' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tudo certo' }] } },
    ])
    const eventos = await readTranscript(cfg, projeto, id)
    expect(eventos.length).toBeGreaterThanOrEqual(2)
  })
})
