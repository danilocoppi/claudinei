import { describe, it, expect, afterEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { KimiSession } from '../src/engine/kimi/kimi-session.js'
import type { AgentEvent } from '../src/engine/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_KIMI = join(__dirname, 'fake-kimi.mjs')

const open = () =>
  new KimiSession({
    projectPath: mkdtempSync(join(tmpdir(), 'kimi-stuck-')),
    binOverride: process.execPath,
    extraArgsOverride: [FAKE_KIMI],
    // Janela curta: no teste não faz sentido esperar os segundos do default.
    turnEndGraceMs: 60,
  } as never)

let session: KimiSession | undefined
afterEach(async () => {
  delete process.env.KIMI_FAKE_HANG_AFTER_TURN
  await session?.stop()
  session = undefined
})

/**
 * Bug real, medido em produção: o `kimi-code` conclui o turno (emite o
 * session.resume_hint e grava turn.ended no wire) e NÃO encerra o processo —
 * fica ocioso em ep_poll. Como a sessão só finalizava o turno no 'close', a UI
 * ficava presa em "working" indefinidamente, sem nada acontecendo.
 */
describe('Kimi — turno concluído com processo que não encerra', () => {
  it('finaliza o turno mesmo sem o processo sair', async () => {
    process.env.KIMI_FAKE_HANG_AFTER_TURN = '1'
    session = open()
    session.start()
    const results: AgentEvent[] = []
    session.on('event', (e: AgentEvent) => { if (e.kind === 'result') results.push(e) })

    session.send('oi')
    expect(session.status).toBe('working')

    await vi.waitFor(() => expect(session!.status).toBe('needs_attention'), { timeout: 5000 })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ isError: false })
  })

  it('não marca a sessão como morta ao encerrar o processo pendurado', async () => {
    process.env.KIMI_FAKE_HANG_AFTER_TURN = '1'
    session = open()
    session.start()
    session.send('oi')
    await vi.waitFor(() => expect(session!.status).toBe('needs_attention'), { timeout: 5000 })
    expect(session!.status).not.toBe('dead')
  })

  it('turno normal (processo sai sozinho) continua funcionando igual', async () => {
    session = open()
    session.start()
    const results: AgentEvent[] = []
    session.on('event', (e: AgentEvent) => { if (e.kind === 'result') results.push(e) })

    session.send('oi')
    await vi.waitFor(() => expect(session!.status).toBe('needs_attention'), { timeout: 5000 })
    expect(results).toHaveLength(1)
  })
})
