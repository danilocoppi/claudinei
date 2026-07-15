import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Roda APENAS com RUN_REAL=1 (usa o claude real; custa tokens).
describe.runIf(process.env.RUN_REAL === '1')('e2e com claude real', () => {
  it('cria sessão, executa tarefa com ferramenta e termina o turno', async () => {
    const db = openDb(':memory:')
    const projects = createProjectsService(db)
    const dir = mkdtempSync(join(tmpdir(), 'tm-e2e-'))
    const project = projects.create({ name: 'E2E', path: dir })

    const broadcasts: any[] = []
    const mgr = createSessionManager({ db, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)

    const waitUntil = async (cond: () => boolean, ms = 120_000) => {
      const start = Date.now()
      while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout e2e')
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    mgr.send(info.localId, "crie um arquivo chamado ola.txt com o conteúdo exato 'claudinei funciona' e nada mais")
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')

    expect(existsSync(join(dir, 'ola.txt'))).toBe(true)
    expect(broadcasts.some((b) => b.type === 'session_event' && b.event?.kind === 'result' && !b.event.isError)).toBe(true)
    await mgr.stop(info.localId)
  }, 180_000)
})
