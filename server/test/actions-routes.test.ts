import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createActionsStore } from '../src/actions.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createTerminalManager } from '../src/terminal/manager.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { shellFor, joinCommands, runKey } from '../src/routes/actions.js'

let db: Db
let app: FastifyInstance
let projectId: number
let pasta: string
let spawned: { file: string; args: string[] | string; cwd: string; env?: Record<string, string> }[]
let vivos: Map<string, () => void>

/** PTY de mentira: registra o que foi pedido e deixa matar na mão. */
const ptyFalso = () => {
  const p = {
    onData: () => {}, write: () => {}, resize: () => {},
    onExit: (cb: (e: { exitCode: number }) => void) => { p._exit = () => cb({ exitCode: 0 }) },
    kill: () => p._exit?.(),
    _exit: undefined as undefined | (() => void),
  }
  return p
}

beforeEach(async () => {
  spawned = []
  vivos = new Map()
  db = openDb(':memory:')
  pasta = mkdtempSync(join(tmpdir(), 'acr-'))
  projectId = createProjectsService(db).create({ name: 'Alpha', path: pasta }).id
  const terminalManager = createTerminalManager({
    ptyFactory: (file, args, opts) => {
      spawned.push({ file, args, cwd: opts.cwd, env: opts.env })
      const p = ptyFalso()
      vivos.set(`${file} ${[args].flat().join(' ')}`, () => p.kill())
      return p
    },
  })
  app = await buildApp({
    db, terminalManager, config: loadConfig({}),
    manager: createSessionManager({ db, broadcast: () => {} }),
  })
})
afterEach(async () => { await app.close(); vi.restoreAllMocks() })

const criar = (body: object) =>
  app.inject({ method: 'POST', url: `/api/projects/${projectId}/actions`, payload: body })

/**
 * O exemplo que originou a tela: `awsVAEXA` seguido de `npm run deploy`. O
 * primeiro é um ALIAS que faz `export AWS_PROFILE=...` — daí as duas exigências
 * que os testes abaixo fixam: mesmo shell, e shell interativo.
 */
describe('como a ação vira um comando de verdade', () => {
  it('os comandos rodam no MESMO shell, encadeados', () => {
    // Em processos separados o `export` do alias morreria antes do deploy.
    expect(joinCommands(['awsVAEXA', 'npm run deploy'])).toBe('awsVAEXA && npm run deploy')
  })

  it('encadeia com && — deploy não segue depois do que falhou', () => {
    expect(joinCommands(['a', 'b'])).not.toContain(';')
  })

  /** `bash -lc 'awsVAEXA'` responde "command not found": o .bashrc só carrega em
   *  shell INTERATIVO, e é lá que moram os aliases do operador. Medido. */
  it('o shell é de login E interativo, senão os aliases somem', () => {
    const { file, args } = shellFor(['awsVAEXA'], 'linux')
    expect(file).toBe('bash')
    expect(args[0], 'sem -i o alias do .bashrc não existe').toBe('-lic')
  })

  /**
   * O Windows não é um detalhe de portabilidade aqui: a linha vai CRUA para o
   * `cmd.exe`, e não como lista de argumentos.
   *
   * O motivo está no teste seguinte — com lista, o node-pty escapa as aspas do
   * jeito do compilador C, e o cmd não fala essa língua.
   */
  it('no Windows manda a linha crua para o cmd', () => {
    expect(shellFor(['dir'], 'win32')).toEqual({ file: 'cmd.exe', args: '/c dir' })
    expect(shellFor(['awsVAEXA', 'npm run deploy'], 'win32'))
      .toEqual({ file: 'cmd.exe', args: '/c awsVAEXA && npm run deploy' })
  })

  /**
   * A prova de que a linha chega inteira no Windows — usando a MESMA função de
   * quoting que o node-pty vai usar em produção, não uma imitação dela.
   *
   * Sem isto o defeito era invisível daqui: `git commit -m "mensagem"` virava
   * `git commit -m \"mensagem\"`, e como o `cmd.exe` não trata `\` como escape,
   * o commit sairia com barras literais e a mensagem partida ao meio.
   */
  it('as aspas do comando sobrevivem até a linha de comando do Windows', async () => {
    // Import por caminho: é interno do node-pty e não tem tipos publicados — mas é
    // ELE que monta a linha de comando no Windows, e uma imitação aqui só provaria
    // que a imitação está certa.
    const { argsToCommandLine } = (await import(
      // @ts-expect-error módulo interno do node-pty, sem declaração de tipos
      'node-pty/lib/windowsPtyAgent.js'
    )) as { argsToCommandLine: (file: string, args: string[] | string) => string }
    const { file, args } = shellFor(['npm run build', 'git commit -m "mensagem do deploy"'], 'win32')
    const linha = argsToCommandLine(file, args)

    expect(linha).toBe('cmd.exe /c npm run build && git commit -m "mensagem do deploy"')
    expect(linha, 'aspas escapadas à moda do C não valem para o cmd').not.toContain('\\"')

    // E o contraste: é isto que a lista de argumentos produziria.
    expect(argsToCommandLine(file, ['/c', 'git commit -m "x"'])).toContain('\\"')
  })
})

describe('rodar a ação', () => {
  it('abre um terminal na pasta do projeto com os comandos', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['awsVAEXA', 'npm run deploy'] })).json()
    const r = await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ wsUrl: `/ws/terminal/${runKey(a.id)}`, reattached: false })
    expect(r.json().token).toBeTruthy()
    expect(spawned[0]).toMatchObject({ cwd: pasta, file: 'bash', args: ['-lic', 'awsVAEXA && npm run deploy'] })
  })

  /**
   * O ponto mais fino do pedido: dar F5 não pode deixar um deploy rodando às
   * cegas. Rodar de novo o que já roda REATA — mesmo processo, token novo.
   */
  it('rodar de novo o que já está rodando reata, não relança', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['npm run deploy'] })).json()
    const um = (await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })).json()
    const dois = (await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })).json()
    expect(spawned, 'relançou o deploy em cima do que já rodava').toHaveLength(1)
    expect(dois.reattached).toBe(true)
    expect(dois.token).not.toBe(um.token)   // token novo a cada ligação
  })

  it('a listagem diz quem está rodando', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['ls'] })).json()
    const b = (await criar({ name: 'Seed', commands: ['ls'] })).json()
    await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })
    const lista = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/actions` })).json()
    expect(lista.find((x: { id: number }) => x.id === a.id).running).toBe(true)
    expect(lista.find((x: { id: number }) => x.id === b.id).running).toBe(false)
  })

  /**
   * O node-pty parte do env do SERVIDOR, que carrega o libstdc++ portátil do
   * Claudinei — e um `npm run build` morreria com o mesmo GLIBCXX que derrubou o
   * "Abrir terminal".
   */
  it('não empurra o libstdc++ do Claudinei para dentro do build', async () => {
    const a = (await criar({ name: 'Build', commands: ['npm run build'] })).json()
    await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })
    expect(spawned[0].env?.LD_LIBRARY_PATH ?? '').not.toMatch(/claudinei/)
  })

  /** Fechar é parar: a janelinha some e o processo vai junto. */
  it('fechar a execução mata o processo', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['ls'] })).json()
    await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })
    const r = await app.inject({ method: 'DELETE', url: `/api/actions/${a.id}/run` })
    expect(r.statusCode).toBe(204)
    const lista = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/actions` })).json()
    expect(lista[0].running).toBe(false)
  })

  it('excluir a ação para o que ela estava rodando', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['ls'] })).json()
    await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run` })
    await app.inject({ method: 'DELETE', url: `/api/actions/${a.id}` })
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/actions` })).json()).toEqual([])
  })

  /** Rodar é execução de shell: vale a mesma régua do `!comando`. */
  it('pela rede, não roda', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['ls'] })).json()
    const r = await app.inject({ method: 'POST', url: `/api/actions/${a.id}/run`, remoteAddress: '10.0.0.9' })
    expect(r.statusCode).toBe(403)
    expect(spawned).toHaveLength(0)
  })

  it('ação que não existe não roda nada', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/actions/9999/run' })).statusCode).toBe(404)
  })
})

describe('cadastro pela rota', () => {
  it('cria, edita e apaga', async () => {
    const a = (await criar({ name: 'Deploy', commands: ['ls'], autoClose: true })).json()
    expect(a).toMatchObject({ name: 'Deploy', autoClose: true })
    const b = (await app.inject({
      method: 'PATCH', url: `/api/actions/${a.id}`,
      payload: { name: 'Deploy prod', commands: ['awsVAEXA', 'npm run deploy'], autoClose: false },
    })).json()
    expect(b).toMatchObject({ name: 'Deploy prod', autoClose: false })
    await app.inject({ method: 'DELETE', url: `/api/actions/${a.id}` })
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/actions` })).json()).toEqual([])
  })

  it('recusa cadastro sem nome ou sem comando', async () => {
    expect((await criar({ name: '  ', commands: ['ls'] })).statusCode).toBe(400)
    expect((await criar({ name: 'X', commands: [] })).statusCode).toBe(400)
  })

  it('a ação é do terminal: outro terminal não a vê', async () => {
    const outro = createProjectsService(db).create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'acr-')) })
    await criar({ name: 'Deploy', commands: ['ls'] })
    expect((await app.inject({ method: 'GET', url: `/api/projects/${outro.id}/actions` })).json()).toEqual([])
  })
})

/**
 * Voltar de um F5 é RE-LIGAR ao que ficou de pé, nunca disparar de novo. Quem
 * volta pede `attachOnly`, e a decisão de recusar é do servidor: conferir antes
 * de pedir deixaria uma fresta entre a conferência e o pedido, e nessa fresta um
 * deploy que acabou de terminar seria publicado uma segunda vez.
 */
describe('reatar depois de um F5', () => {
  it('attachOnly liga na execução viva', async () => {
    const acao = (await criar({ name: 'Deploy', commands: ['sleep 5'] })).json()
    const primeiro = await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run` })
    expect(primeiro.json().reattached).toBe(false)

    const volta = await app.inject({
      method: 'POST', url: `/api/actions/${acao.id}/run`, payload: { attachOnly: true },
    })
    expect(volta.statusCode).toBe(200)
    expect(volta.json().reattached).toBe(true)
    expect(volta.json().wsUrl).toBe(primeiro.json().wsUrl)
  })

  it('attachOnly NÃO dispara nada quando não há execução', async () => {
    const acao = (await criar({ name: 'Deploy', commands: ['echo oi'] })).json()
    const r = await app.inject({
      method: 'POST', url: `/api/actions/${acao.id}/run`, payload: { attachOnly: true },
    })
    expect(r.statusCode).toBe(409)
    expect(spawned.length).toBe(0)
  })
})
