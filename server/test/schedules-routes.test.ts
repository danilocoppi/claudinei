import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createSchedulesStore } from '../src/schedules/store.js'

let db: Db
let app: Awaited<ReturnType<typeof buildApp>>
let dirDosResultados: string
let auth: AuthService
let meu: Project, alheio: Project

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}
const login = async (username: string) =>
  cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))

const daily = { kind: 'daily', at: '12:00' }
const base = { name: 'Preços', task: 'buscar preços', cadence: daily }

beforeEach(async () => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  meu = projects.create({ name: 'meu', path: mkdtempSync(join(tmpdir(), 'sr-')) })
  alheio = projects.create({ name: 'alheio', path: mkdtempSync(join(tmpdir(), 'sr-')) })
  auth = createAuthService({ db })
  const manager = createSessionManager({ db, broadcast: () => {} })
  dirDosResultados = mkdtempSync(join(tmpdir(), 'sr-results-'))
  const config = { ...loadConfig({}), schedulesDir: dirDosResultados }
  app = await buildApp({ config, db, manager, auth })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [meu.id] })
})

describe('acesso', () => {
  it('quem opera o terminal administra os agendamentos dele (não precisa ser admin)', async () => {
    const ana = await login('ana')
    const res = await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: base, cookies: ana })
    expect(res.statusCode).toBe(201)
    expect(res.json().name).toBe('Preços')
  })

  it('terminal alheio é 403 na criação e na leitura', async () => {
    const ana = await login('ana')
    expect((await app.inject({ method: 'POST', url: `/api/projects/${alheio.id}/schedules`, payload: base, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/projects/${alheio.id}/schedules`, cookies: ana })).statusCode).toBe(403)
  })

  it('não deixa mexer no agendamento de um terminal alheio', async () => {
    const admin = await login('root')
    const ana = await login('ana')
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${alheio.id}/schedules`, payload: base, cookies: admin })).json()
    expect((await app.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { name: 'x' }, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${s.id}`, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/schedules/${s.id}/runs`, cookies: ana })).statusCode).toBe(403)
  })

  it('a lista global só traz o que o usuário alcança', async () => {
    const admin = await login('root')
    const ana = await login('ana')
    await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: base, cookies: admin })
    await app.inject({ method: 'POST', url: `/api/projects/${alheio.id}/schedules`, payload: { ...base, name: 'Alheio' }, cookies: admin })
    const sees = (await app.inject({ method: 'GET', url: '/api/schedules', cookies: ana })).json() as any[]
    expect(sees.map((s) => s.name)).toEqual(['Preços'])
  })

  it('agendamento inexistente é 404', async () => {
    const admin = await login('root')
    expect((await app.inject({ method: 'PATCH', url: '/api/schedules/999', payload: { name: 'x' }, cookies: admin })).statusCode).toBe(404)
  })
})

describe('validação', () => {
  const post = async (payload: unknown) => {
    const admin = await login('root')
    return app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: payload as any, cookies: admin })
  }

  it('recusa nome, tarefa, cadência e retenção fora de faixa', async () => {
    expect((await post({ ...base, name: '  ' })).statusCode).toBe(400)
    expect((await post({ ...base, name: 'x'.repeat(61) })).statusCode).toBe(400)
    expect((await post({ ...base, task: '' })).statusCode).toBe(400)
    expect((await post({ ...base, task: 'x'.repeat(8001) })).statusCode).toBe(400)
    expect((await post({ ...base, cadence: { kind: 'daily', at: '99:99' } })).statusCode).toBe(400)
    expect((await post({ ...base, cadence: { kind: 'cron', expr: '30 2 30 2 *' } })).statusCode).toBe(400)
    expect((await post({ ...base, keepResults: 0 })).statusCode).toBe(400)
    expect((await post({ ...base, keepResults: 51 })).statusCode).toBe(400)
  })
})

describe('edição', () => {
  it('pausa e retoma pelo mesmo PATCH', async () => {
    const admin = await login('root')
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: base, cookies: admin })).json()
    const paused = (await app.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { enabled: false }, cookies: admin })).json()
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBeNull()
    expect((await app.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { enabled: true }, cookies: admin })).json().nextRunAt).toBeTruthy()
  })

  /** enabled é aplicado por último: aplicá-lo antes gravaria o horário da cadência ANTIGA. */
  it('trocar a cadência e retomar na mesma chamada usa a cadência nova', async () => {
    const admin = await login('root')
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: base, cookies: admin })).json()
    await app.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { enabled: false }, cookies: admin })
    const out = (await app.inject({
      method: 'PATCH', url: `/api/schedules/${s.id}`,
      payload: { cadence: { kind: 'daily', at: '23:30' }, enabled: true }, cookies: admin,
    })).json()
    expect(new Date(out.nextRunAt).getHours()).toBe(23)
  })

  it('string vazia em engine/model/effort volta a "manter o atual"', async () => {
    const admin = await login('root')
    const s = (await app.inject({
      method: 'POST', url: `/api/projects/${meu.id}/schedules`,
      payload: { ...base, engine: 'codex', model: 'opus' }, cookies: admin,
    })).json()
    const out = (await app.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { engine: '', model: '' }, cookies: admin })).json()
    expect(out.engine).toBeNull()
    expect(out.model).toBeNull()
  })
})

describe('preview', () => {
  it('devolve as próximas execuções da cadência', async () => {
    const admin = await login('root')
    const res = await app.inject({ method: 'POST', url: '/api/schedules/preview', payload: { cadence: daily }, cookies: admin })
    const { next } = res.json()
    expect(next).toHaveLength(4)
    expect(new Date(next[0]).getHours()).toBe(12)
    expect(new Date(next[0]).getTime()).toBeGreaterThan(Date.now())
  })

  it('cadência inválida é 400 com a explicação', async () => {
    const admin = await login('root')
    const res = await app.inject({ method: 'POST', url: '/api/schedules/preview', payload: { cadence: { kind: 'weekly', weekdays: [], at: '09:00' } }, cookies: admin })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/dia da semana/)
  })
})

describe('conteúdo de uma execução', () => {
  it('devolve content nulo (e não 404) quando o arquivo se perdeu', async () => {
    const admin = await login('root')
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/schedules`, payload: base, cookies: admin })).json()
    const res = await app.inject({ method: 'GET', url: `/api/schedules/${s.id}/runs/99/content`, cookies: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json().content).toBeNull()
  })
})

/**
 * Limpeza em lote dos resultados (pedida na tela: selecionar vários e apagar).
 *
 * `DELETE` com corpo, e não um seq por vez: dez resultados virariam dez
 * requisições, cada uma podendo falhar no meio e deixar a lista pela metade.
 */
describe('apagar resultados em lote', () => {
  /** Gera execuções de verdade pelo store — é o que a rota vai apagar. */
  const comResultados = async (projectId: number, n: number) => {
    const admin = await login('root')
    const s = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/schedules`, payload: base, cookies: admin })).json()
    const store = createSchedulesStore(db, { dir: dirDosResultados })
    for (let i = 0; i < n; i++) {
      const run = store.startRun(s.id, {})
      store.finishRun(run.id, { status: 'ok', content: `resultado ${i}` })
    }
    return s
  }
  const seqs = async (id: number, cookies: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: `/api/schedules/${id}/runs`, cookies })).json().map((r: any) => r.seq).sort()

  it('apaga os selecionados e deixa os outros', async () => {
    const admin = await login('root')
    const s = await comResultados(meu.id, 4)
    const res = await app.inject({
      method: 'DELETE', url: `/api/schedules/${s.id}/runs`, payload: { seqs: [1, 3] }, cookies: admin,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deleted: 2 })
    expect(await seqs(s.id, admin)).toEqual([2, 4])
  })

  it('quem opera o terminal pode limpar; terminal alheio é 403', async () => {
    const admin = await login('root')
    const ana = await login('ana')
    const meuSched = await comResultados(meu.id, 2)
    const alheioSched = await comResultados(alheio.id, 2)

    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${meuSched.id}/runs`, payload: { seqs: [1] }, cookies: ana })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${alheioSched.id}/runs`, payload: { seqs: [1] }, cookies: ana })).statusCode).toBe(403)
    // e o alheio continua intacto
    expect(await seqs(alheioSched.id, admin)).toEqual([1, 2])
  })

  it('corpo inválido é 400, não apaga nada por engano', async () => {
    const admin = await login('root')
    const s = await comResultados(meu.id, 2)
    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${s.id}/runs`, payload: {}, cookies: admin })).statusCode).toBe(400)
    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${s.id}/runs`, payload: { seqs: 'tudo' }, cookies: admin })).statusCode).toBe(400)
    expect(await seqs(s.id, admin)).toEqual([1, 2])
  })

  /** Um `IN (...)` sem teto é jeito barato de segurar o banco — e a lista da tela
   *  mostra no máximo 50, então nada legítimo passa disso. */
  it('recusa lote absurdo', async () => {
    const admin = await login('root')
    const s = await comResultados(meu.id, 1)
    const enorme = Array.from({ length: 201 }, (_, i) => i + 1)
    expect((await app.inject({ method: 'DELETE', url: `/api/schedules/${s.id}/runs`, payload: { seqs: enorme }, cookies: admin })).statusCode).toBe(400)
  })
})
