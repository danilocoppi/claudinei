import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import type { SessionStatus } from '../src/claude/session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')

const open = () =>
  new ClaudeSession({
    projectPath: mkdtempSync(join(tmpdir(), 'auto-turn-')),
    claudeBin: process.execPath,
    extraArgsOverride: [FAKE_CLAUDE],
  } as SessionOptions)

let session: ClaudeSession | undefined
afterEach(async () => { await session?.stop(); session = undefined })

/** Injeta um evento vindo da engine, como se tivesse saído do stdout do CLI. */
const feed = (s: ClaudeSession, obj: object) =>
  (s as unknown as { handleEvent: (e: unknown) => void }).handleEvent(obj)

/**
 * Um subagente despachado com run_in_background devolve o turno na hora: o CLI
 * emite `result` (o turno 1 fecha) e, quando a task termina, dispara um TURNO
 * NOVO sozinho — com `init`, conteúdo e um segundo `result`
 * (origin.kind='task-notification'). Medido no CLI real.
 *
 * A sessão só entrava em 'working' quando o OPERADOR enviava algo, então esse
 * turno autônomo rodava inteiro com a UI dizendo "idle": conteúdo pingando na
 * tela, bolinha apagada, e o filtro "somente ativos" escondendo o terminal.
 */
describe('turno que a engine inicia sozinha (task em background)', () => {
  it('volta para working quando a engine produz conteúdo estando idle', () => {
    session = open()
    session.start()
    feed(session, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
    expect(session.status).toBe('idle')

    feed(session, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'o subagente terminou' }] }, raw: {} })

    expect(session.status).toBe('working')
  })

  it('o result do turno autônomo devolve a sessão para needs_attention', () => {
    session = open()
    session.start()
    feed(session, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
    feed(session, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })
    feed(session, { kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0, raw: { origin: { kind: 'task-notification' } } })

    expect(session.status).toBe('needs_attention')
  })

  it('emite a mudança de status para os clientes', () => {
    session = open()
    session.start()
    feed(session, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
    const seen: SessionStatus[] = []
    session.on('status', (s: SessionStatus) => seen.push(s))

    feed(session, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })

    expect(seen).toContain('working')
  })

  it('sessão parada NÃO ressuscita por evento atrasado', () => {
    session = open()
    session.start()
    feed(session, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
    ;(session as unknown as { setStatus: (s: SessionStatus) => void }).setStatus('stopped')

    feed(session, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })

    expect(session.status).toBe('stopped')
  })

  it('sessão no terminal não é arrastada para working', () => {
    session = open()
    session.start()
    feed(session, { kind: 'init', sessionId: 's1', model: '', slashCommands: [], raw: {} })
    ;(session as unknown as { setStatus: (s: SessionStatus) => void }).setStatus('in_terminal')

    feed(session, { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, raw: {} })

    expect(session.status).toBe('in_terminal')
  })
})
