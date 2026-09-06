import { describe, it, expect, afterEach } from 'vitest'
import { ClaudeSession, buildClaudeArgs } from '../src/claude/session.js'
import type { ClaudeEvent } from '../src/claude/events.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const mk = (opts = {}) => new ClaudeSession({
  projectPath: mkdtempSync(join(tmpdir(), 'tm-')),
  claudeBin: process.execPath, extraArgsOverride: [FAKE], controlTimeoutMs: 400, ...opts,
})
const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)) }
}
let live: ClaudeSession[] = []
afterEach(async () => { for (const s of live) await s.stop(); live = [] })
const start = (opts = {}) => { const s = mk(opts); live.push(s); s.start(); return s }

describe('buildClaudeArgs', () => {
  it('sempre usa --dangerously-skip-permissions e nunca --permission-mode', () => {
    const args = buildClaudeArgs({})
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
  })

  it('liga o prompt de permissão via stdio — sem ele a AskUserQuestion nem existe para o modelo', () => {
    const args = buildClaudeArgs({})
    const i = args.indexOf('--permission-prompt-tool')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('stdio')
  })
})

describe('ClaudeSession control_request', () => {
  it('setModel resolve no control_response de sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setModel('haiku')).resolves.toBeUndefined()
  })

  it('setPermissionMode resolve no sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('plan')).resolves.toBeUndefined()
  })

  it('control com error rejeita com a mensagem', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('fail-test' as any)).rejects.toThrow(/inválido/)
  })

  it('sem resposta dentro do timeout, rejeita', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('timeout-test' as any)).rejects.toThrow(/resposta/)
  })

  it('recusa control quando não está ativa (após stop)', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await s.stop()
    await expect(s.setModel('opus')).rejects.toThrow(/status/)
  })

  it('falha na auto-aplicação do modo no init é emitida no stderr (não silenciosa)', async () => {
    const errs: string[] = []
    const s = mk({ permissionMode: 'timeout-test' as any })
    live.push(s)
    s.on('stderr', (m: string) => errs.push(m))
    s.start()
    await waitUntil(() => s.status === 'idle')
    await waitUntil(() => errs.some((e) => e.includes('falha ao aplicar modo')), 3000)
    expect(errs.some((e) => e.includes('bypassPermissions'))).toBe(true)
  })
})

/**
 * O defeito relatado: interromper o turno e a UI continuar com as três bolinhas
 * de "processando" para sempre.
 *
 * A saída de `working` acontece num lugar só — o `result` do CLI —, e ele é
 * ignorado quando ainda há task de background em aberto (isso existe de
 * propósito: o turno que despachou o subagente acabou, mas o subagente não).
 * Só que na INTERRUPÇÃO isso vira uma armadilha: o `interrupt` é enviado ANTES de
 * as tasks serem paradas, então o `result` chega com a lista ainda cheia, o
 * status não muda — e não vem outro `result` depois. A sessão fica "trabalhando"
 * até o próximo turno.
 *
 * As outras três engines já caem em `idle` ao interromper; o Claude é a única com
 * processo longo, e a única que não mexia no status.
 */
describe('interromper encerra o turno', () => {
  it('sai de working mesmo com task de background em aberto', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    s.send('com-bg')
    await waitUntil(() => s.status === 'working')
    await waitUntil(() => s.backgroundTasks.length > 0)

    await s.interrupt()
    await waitUntil(() => s.status !== 'working')
    // O mesmo destino do caso sem task pendente: o turno acabou e a vez é sua.
    expect(s.status).toBe('needs_attention')
  })

  it('sai de working no caso simples também', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    s.send('demorada')
    await waitUntil(() => s.status === 'working')
    await s.interrupt()
    await waitUntil(() => s.status !== 'working')
  })

  /** Interromper quem não está trabalhando não pode mexer no estado de ninguém. */
  it('interromper fora de working não muda nada', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await s.interrupt()
    expect(s.status).toBe('idle')
  })
})

describe('AskUserQuestion (can_use_tool vindo da CLI)', () => {
  it('a pergunta vira pendência com perguntas + tool_use_id e re-emite status (sem mudar de working)', async () => {
    const s = start()
    const statuses: string[] = []
    s.on('status', (st: string) => statuses.push(st))
    await waitUntil(() => s.status === 'idle')
    const antes = statuses.length
    s.send('faz-pergunta')
    await waitUntil(() => s.pendingQuestion !== undefined)
    expect(s.pendingQuestion).toMatchObject({ toolUseId: 'toolu_q_1' })
    expect(s.pendingQuestion!.questions.map((q) => q.header)).toEqual(['Cor', 'Frutas'])
    expect(s.pendingQuestion!.questions[0].multiSelect).toBe(false)
    expect(s.pendingQuestion!.questions[1].multiSelect).toBe(true)
    expect(s.pendingQuestion!.questions[0].options[0]).toEqual({ label: 'Azul', description: 'Cor azul' })
    // O status não muda (segue working), mas é re-emitido: é assim que o manager
    // rebroadcasta o SessionInfo — o mesmo canal do authExpired.
    expect(s.status).toBe('working')
    // dois 'working' desde o send(): o do próprio send() e o re-emitido pela pendência
    expect(statuses.slice(antes).filter((st) => st === 'working').length).toBeGreaterThanOrEqual(2)
  })

  it('morte do processo limpa a pendência', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    s.send('faz-pergunta')
    await waitUntil(() => s.pendingQuestion !== undefined)
    s.send('crash')
    await waitUntil(() => s.status === 'dead')
    expect(s.pendingQuestion).toBeUndefined()
  })
})
