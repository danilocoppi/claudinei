// O app real (buildApp) com o host do navegador montado sobre o dublê do
// Chromium, auth multiusuário e um hub falso que guarda os broadcasts. Usado
// pelos testes das rotas do hermes e do operador do navegador.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { createBrowserHost, type BrowserHost } from '../src/browser/host.js'
import type { BrowserFeature } from '../src/browser/feature.js'
import type { WsHub } from '../src/routes/ws.js'
import { fakeLaunch, type FakeLaunch } from './browser-fakes.js'

export interface BrowserAppFixture {
  app: Awaited<ReturnType<typeof buildApp>>
  db: Db
  auth: AuthService
  host: BrowserHost
  fl: FakeLaunch
  feature: BrowserFeature | undefined
  uploadsDir: string
  broadcasts: any[]
  p1: { id: number }
  p2: { id: number }
  adminCookie: Record<string, string>
  /** Só tem acesso ao p1. */
  anaCookie: Record<string, string>
  close(): Promise<void>
}

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

export async function browserApp(): Promise<BrowserAppFixture> {
  // O host resolve o Chromium antes do launch: aponta para um arquivo que existe.
  process.env.CLAUDINEI_CHROMIUM = process.execPath
  const fl = fakeLaunch()
  const host = createBrowserHost({ log: () => {}, launch: fl.launch })
  const db = openDb(':memory:')
  const auth = createAuthService({ db })
  const manager = createSessionManager({
    db, broadcast: () => {},
    sessionFactory: () => { throw new Error('nenhuma sessão nestes testes') },
  })
  const broadcasts: any[] = []
  const wsHub = { broadcast: (m: object) => { broadcasts.push(m) }, register: () => {}, closeAll: () => {}, closeUser: () => {} } as unknown as WsHub
  const uploadsDir = mkdtempSync(join(tmpdir(), 'navegador-uploads-'))
  let feature: BrowserFeature | undefined
  const app = await buildApp({
    config: loadConfig({ CLAUDINEI_UPLOADS: uploadsDir }), db, manager, auth, wsHub, browserHost: host,
    onBrowserReady: (b) => { feature = b },
  })
  const projects = createProjectsService(db)
  const p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'nav-p1-')) })
  const p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'nav-p2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  const login = async (username: string) =>
    cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))
  const adminCookie = await login('root')
  const anaCookie = await login('ana')
  return {
    app, db, auth, host, fl, get feature() { return feature }, uploadsDir, broadcasts, p1, p2, adminCookie, anaCookie,
    async close() {
      await host.shutdown()
      await app.close()
    },
  }
}

/** Deixa as promessas encadeadas nos ouvintes terminarem. */
export const flush = () => new Promise((r) => setTimeout(r, 0))

/** Espera a condição (polling curto), ou falha depois de `ms`. */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condição não chegou')
    await new Promise((r) => setTimeout(r, 5))
  }
}
