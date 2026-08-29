import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createTerminalManager } from '../src/terminal/manager.js'
import type { PtyProcess } from '../src/terminal/pty.js'

/**
 * A aposta que sustenta a feature inteira, medida em vez de suposta.
 *
 * O exemplo que originou a tela é `awsVAEXA` seguido de `npm run deploy`, e o
 * primeiro é um ALIAS (`alias awsVAEXA='export AWS_PROFILE=getvaexa'` no
 * `.bashrc`). Alias só existe em shell INTERATIVO, e `export` só alcança o
 * comando seguinte se os dois forem o MESMO processo. Este teste fixa as duas
 * coisas com um `.bashrc` de mentira — se um dia alguém trocar `-lic` por `-lc`
 * ou `&&` por processos separados, é aqui que estoura.
 */
describe('o shell que roda a ação', () => {
  const casa = mkdtempSync(join(tmpdir(), 'acbash-'))
  // A casa de mentira copia a cadeia do Ubuntu, e não um `.bashrc` solto: um shell
  // de LOGIN lê `~/.profile`, e é ELE que chama o `.bashrc` — que por sua vez
  // desiste na primeira linha se o shell não for interativo. É essa dupla guarda
  // que faz `-lic` achar o alias e `-lc` não achar; um `.bashrc` sozinho não seria
  // lido por nenhum dos dois, e o teste passaria pelo motivo errado.
  writeFileSync(join(casa, '.profile'), '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n')
  writeFileSync(join(casa, '.bashrc'),
    'case $- in *i*) ;; *) return;; esac\n' +
    "alias meuPerfil='export PERFIL=escolhido'\n")

  const rodar = (args: string[]) => new Promise<string>((resolve) => {
    // LD_LIBRARY_PATH zerado: o processo de teste herda o libstdc++ portátil do
    // Claudinei, e ele faz o `command-not-found` do sistema despejar um traceback
    // de GLIBCXX no meio da saída que este teste lê.
    execFile('bash', args, { env: { ...process.env, HOME: casa, PERFIL: '', LD_LIBRARY_PATH: '' } },
      (_e, out, err) => resolve(`${out}${err}`))
  })

  it('shell interativo enxerga o alias; login-só não enxerga', async () => {
    expect(await rodar(['-lic', 'meuPerfil && echo [$PERFIL]'])).toContain('[escolhido]')
    expect(await rodar(['-lc', 'meuPerfil && echo [$PERFIL]'])).not.toContain('[escolhido]')
  })

  it('em processos separados o export não alcança o comando seguinte', async () => {
    await rodar(['-lic', 'meuPerfil'])
    expect(await rodar(['-lic', 'echo [$PERFIL]'])).toContain('[]')
  })
})

/* ---------------------------------------------------------------------------
 * O caminho inteiro: cadastrar → rodar → ver a saída na janelinha → o fim chegar.
 *
 * PTY de mentira porque o node-pty é nativo (mesma escolha do terminal-e2e), mas
 * o resto é real: a rota, o token, o WebSocket e o broadcast.
 */
let db: Db
let app: FastifyInstance
let projectId: number
let avisos: any[]
let pty: { proc: PtyProcess; emit: (d: string) => void; sair: () => void }

const fakePty = () => {
  let dataCb: (d: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const proc: PtyProcess = {
    onData: (cb) => { dataCb = cb }, onExit: (cb) => { exitCb = cb },
    write: () => {}, resize: () => {}, kill: () => exitCb({ exitCode: 0 }),
  }
  return { proc, emit: (d: string) => dataCb(d), sair: () => exitCb({ exitCode: 0 }) }
}

beforeEach(async () => {
  avisos = []
  db = openDb(':memory:')
  projectId = createProjectsService(db).create({
    name: 'Alpha', path: mkdtempSync(join(tmpdir(), 'ace2e-')),
  }).id
  app = await buildApp({
    db,
    config: loadConfig({}),
    manager: createSessionManager({ db, broadcast: () => {} }),
    terminalManager: createTerminalManager({ ptyFactory: () => { pty = fakePty(); return pty.proc } }),
    // Hub de mentira só para escutar o broadcast: o `register` é o que instala a
    // rota /ws, que este teste não usa — ele fala com /ws/terminal.
    wsHub: { broadcast: (m: object) => avisos.push(m), register: () => {} } as never,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
})
afterEach(async () => { await app.close() })

const porta = () => (app.server.address() as { port: number }).port

const ligar = async (wsUrl: string, token: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${porta()}${wsUrl}?token=${token}`,
    { origin: `http://127.0.0.1:${porta()}` })
  const vistos: string[] = []
  ws.on('message', (d: Buffer) => vistos.push(d.toString('utf8')))
  await new Promise((r, rej) => { ws.once('open', r); ws.once('error', rej) })
  return { ws, vistos, tudo: () => vistos.join('') }
}

const espera = async (cond: () => boolean, ms = 3000) => {
  const inicio = Date.now()
  while (!cond()) {
    if (Date.now() - inicio > ms) throw new Error('esgotou a espera')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('a ação do começo ao fim', () => {
  const cadastrar = async (body: object) =>
    (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/actions`, payload: body })).json()

  it('a saída do comando chega na janelinha, e o fim é anunciado', async () => {
    const acao = await cadastrar({ name: 'Deploy', commands: ['npm run deploy'] })
    const { token, wsUrl } = (await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run` })).json()
    expect(wsUrl).toBe(`/ws/terminal/act-${acao.id}`)

    const janela = await ligar(wsUrl, token)
    pty.emit('publicando…\r\n')
    await espera(() => janela.tudo().includes('publicando'))

    pty.sair()
    await espera(() => avisos.some((m) => m.type === 'action_exit' && m.actionId === acao.id))
    janela.ws.close()
  })

  /**
   * O F5: a página cai, o processo não. Quem volta recebe um token novo para o
   * MESMO PTY e o buffer inteiro do que já tinha saído — sem isso, o deploy
   * seguiria rodando sem nada na tela que o mostrasse ou o parasse.
   */
  it('quem volta de um recarregamento reencontra o processo e o que já saiu', async () => {
    const acao = await cadastrar({ name: 'Deploy', commands: ['npm run deploy'] })
    const primeiro = (await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run` })).json()
    const antes = await ligar(primeiro.wsUrl, primeiro.token)
    pty.emit('etapa 1 de 3\r\n')
    await espera(() => antes.tudo().includes('etapa 1'))
    antes.ws.close() // a aba morreu

    const volta = (await app.inject({
      method: 'POST', url: `/api/actions/${acao.id}/run`, payload: { attachOnly: true },
    })).json()
    expect(volta.reattached).toBe(true)

    const depois = await ligar(volta.wsUrl, volta.token)
    await espera(() => depois.tudo().includes('etapa 1'))
    pty.emit('etapa 2 de 3\r\n')
    await espera(() => depois.tudo().includes('etapa 2'))
    depois.ws.close()
  })

  /** O token antigo morre no reatar: um link vazado não vira acesso perpétuo. */
  it('o token da sessão anterior não serve mais', async () => {
    const acao = await cadastrar({ name: 'Deploy', commands: ['npm run deploy'] })
    const primeiro = (await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run` })).json()
    await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run`, payload: { attachOnly: true } })

    const ws = new WebSocket(`ws://127.0.0.1:${porta()}${primeiro.wsUrl}?token=${primeiro.token}`,
      { origin: `http://127.0.0.1:${porta()}` })
    const codigo = await new Promise<number>((r) => ws.on('close', (c) => r(c)))
    expect(codigo).toBe(1008)
  })

  /** Fechar a janelinha é PARAR: nada de processo de pé sem tela que o mostre. */
  it('parar mata o processo e ele some da lista de rodando', async () => {
    const acao = await cadastrar({ name: 'Deploy', commands: ['npm run deploy'] })
    await app.inject({ method: 'POST', url: `/api/actions/${acao.id}/run` })
    expect((await app.inject({ url: `/api/projects/${projectId}/actions` })).json()[0].running).toBe(true)

    await app.inject({ method: 'DELETE', url: `/api/actions/${acao.id}/run` })
    expect((await app.inject({ url: `/api/projects/${projectId}/actions` })).json()[0].running).toBe(false)
  })
})
