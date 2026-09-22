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

  it('o medidor mostra a conversa, não a soma do turno: turno com 5 ferramentas', async () => {
    const db = openDb(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'tm-ctx-'))
    const project = createProjectsService(db).create({ name: 'CTX', path: dir })

    const broadcasts: any[] = []
    const mgr = createSessionManager({ db, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project, { model: 'opus' })

    const waitUntil = async (cond: () => boolean, ms = 300_000) => {
      const start = Date.now()
      while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout e2e')
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    mgr.send(info.localId, 'Execute em 5 chamadas Bash SEPARADAS, uma por vez: echo 1 ; echo 2 ; echo 3 ; echo 4 ; echo 5. Depois responda apenas: pronto')
    await waitUntil(() => ['idle', 'needs_attention'].includes(mgr.get(info.localId)?.status ?? ''))

    const eventos = broadcasts.filter((b) => b.type === 'session_event').map((b) => b.event)
    const ultimaAssistant = eventos.filter((e) => e?.kind === 'assistant' && typeof e.contextTokens === 'number'
      && !(e.raw as { parent_tool_use_id?: string })?.parent_tool_use_id).at(-1)
    const result = eventos.filter((e) => e?.kind === 'result').at(-1)
    const u = (result?.raw as { usage?: Record<string, number> })?.usage ?? {}
    const somaDoTurno = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

    // O medidor é a conversa da última requisição do turno principal...
    expect(mgr.get(info.localId)?.contextTokens).toBe(ultimaAssistant?.contextTokens)
    // ...e é bem menor que a soma do turno, que é o que inflava a medição.
    expect(somaDoTurno).toBeGreaterThan(mgr.get(info.localId)!.contextTokens!)
    // A janela vem do modelUsage do próprio CLI (opus: 1M).
    expect(mgr.get(info.localId)?.contextWindow).toBe(1_000_000)
    console.log(`medidor=${mgr.get(info.localId)?.contextTokens} soma-do-turno=${somaDoTurno} janela=${mgr.get(info.localId)?.contextWindow}`)
    await mgr.stop(info.localId)
  }, 360_000)
})

/**
 * O seletor de modelos anuncia um número de versão ("Opus 5.5"), mas o que o
 * Claudinei passa para a CLI é o ALIAS (`opus`), que aponta sempre para o Opus
 * mais recente. Quando a família avançar, o rótulo vira mentira em silêncio —
 * e ninguém percebe, porque nada no código liga um ao outro.
 *
 * Este teste é essa ligação: roda a CLI de verdade com o alias e confere que o
 * modelo servido é o que a tela promete. Vermelho aqui = hora de atualizar o
 * rótulo nos três idiomas.
 */
describe.runIf(process.env.RUN_REAL === '1')('o rótulo do seletor bate com o modelo servido', () => {
  it('o alias `opus` serve o modelo que a UI anuncia', async () => {
    const { readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')

    const en = readFileSync(new URL('../../web/src/i18n/en.ts', import.meta.url).pathname, 'utf8')
    const rotulo = /modelOpus:\s*'([^']+)'/.exec(en)?.[1] ?? ''
    const versaoAnunciada = /(\d+(?:\.\d+)?)/.exec(rotulo)?.[1]
    expect(versaoAnunciada, `o rótulo "${rotulo}" não traz versão`).toBeTruthy()

    const saida = execFileSync('claude', ['-p', '--model', 'opus', '--output-format', 'json', 'responda apenas: ok'],
      { encoding: 'utf8', timeout: 120_000 })
    const servido = Object.keys(JSON.parse(saida).modelUsage ?? {}).find((m) => m.includes('opus')) ?? ''

    // "5.5" no rótulo ↔ "claude-opus-5-5" no modelo servido
    expect(servido, `a UI anuncia Opus ${versaoAnunciada}, a CLI serviu ${servido}`)
      .toContain(`opus-${versaoAnunciada!.replace('.', '-')}`)
  }, 180_000)
})
