import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { createGroupsService } from '../src/groups.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let app: FastifyInstance
let grupo: { id: number }
let setor: { id: number }
let projeto: { id: number }

beforeEach(async () => {
  db = openDb(':memory:')
  const groups = createGroupsService(db)
  grupo = groups.create('Backend')
  setor = groups.createSector('Produto')
  projeto = createProjectsService(db).create({ name: 'Alpha', path: mkdtempSync(join(tmpdir(), 'gi-')) })
  app = await buildApp({ db, manager: createSessionManager({ db, broadcast: () => {} }), config: loadConfig({}) })
})
afterEach(async () => { await app.close() })

const salvar = (url: string, icon: string) =>
  app.inject({ method: 'PATCH', url, payload: { name: 'Backend', icon, color: '#7c5cff' } })

/**
 * O defeito relatado: escolher ícone para um grupo, clicar em Salvar, e nada
 * acontecer. O validador tinha teto de 16 caracteres, de quando ícone era só
 * emoji — então passar ou não passar virou uma loteria pelo comprimento do nome
 * do desenho.
 */
describe('ícone de grupo e setor aceita o acervo inteiro', () => {
  it('token comprido não é mais recusado', async () => {
    for (const icon of ['tabler:credit-card', 'material-symbols:rocket-launch', 'simple-icons:react']) {
      const r = await salvar(`/api/groups/${grupo.id}`, icon)
      expect(r.statusCode, icon).toBe(200)
      expect(r.json().icon, icon).toBe(icon)
    }
  })

  it('o mesmo vale para o setor', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/api/sectors/${setor.id}`,
      payload: { name: 'Produto', icon: 'material-symbols:rocket-launch', color: '#58c4dc' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().icon).toBe('material-symbols:rocket-launch')
  })

  it('e o que foi salvo é o que volta na listagem', async () => {
    await salvar(`/api/groups/${grupo.id}`, 'lucide:list-ordered')
    const lista = (await app.inject({ method: 'GET', url: '/api/groups' })).json()
    expect(lista.find((g: { id: number }) => g.id === grupo.id).icon).toBe('lucide:list-ordered')
  })

  it('emoji continua valendo', async () => {
    expect((await salvar(`/api/groups/${grupo.id}`, '🗂️')).json().icon).toBe('🗂️')
  })

  /** Um ícone é um desenho, não um recado. */
  it('texto solto continua recusado', async () => {
    const r = await salvar(`/api/groups/${grupo.id}`, 'isto aqui é uma frase')
    expect(r.statusCode).toBe(400)
  })

  /**
   * O terminal nunca quebrou porque a rota dele não validava NADA — aceitava
   * qualquer string como ícone. Os dois extremos do mesmo descuido; agora ambos
   * usam a mesma regra.
   */
  it('o terminal passa a usar a mesma régua', async () => {
    const ok = await app.inject({
      method: 'PATCH', url: `/api/projects/${projeto.id}`, payload: { icon: 'material-symbols:rocket-launch' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().icon).toBe('material-symbols:rocket-launch')

    const ruim = await app.inject({
      method: 'PATCH', url: `/api/projects/${projeto.id}`, payload: { icon: 'uma frase inteira no lugar do ícone' },
    })
    expect(ruim.statusCode).toBe(400)
  })
})
