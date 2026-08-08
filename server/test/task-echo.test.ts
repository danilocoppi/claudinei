import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import type { ClaudeEvent } from '../src/claude/events.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')

const open = (): ClaudeSession =>
  new ClaudeSession({
    projectPath: mkdtempSync(join(tmpdir(), 'task-echo-')),
    claudeBin: process.execPath,
    extraArgsOverride: [FAKE_CLAUDE],
  } as SessionOptions)

let session: ClaudeSession | undefined
afterEach(() => { session?.stop?.(); session = undefined })

describe('eco de mensagem injetada pelo servidor', () => {
  /**
   * O CLI não devolve a mensagem que recebe, e a UI só desenha o que ela mesma
   * inseriu ao digitar. Sem este eco, uma task despachada por outro terminal só
   * aparecia depois de recarregar o histórico.
   */
  it('send com echoToClients emite um evento user para os clientes', () => {
    session = open()
    session.start()
    const seen: ClaudeEvent[] = []
    session.on('event', (e: ClaudeEvent) => seen.push(e))

    session.send('[Task from Alfa]: mude o sizing', { echoToClients: true })

    const evt = seen.find((e) => e.kind === 'user')
    expect(evt).toBeTruthy()
    expect((evt as { message: { content: { text: string }[] } }).message.content[0].text)
      .toBe('[Task from Alfa]: mude o sizing')
  })

  it('send normal (usuário digitando) NÃO ecoa — a UI já inseriu localmente', () => {
    session = open()
    session.start()
    const seen: ClaudeEvent[] = []
    session.on('event', (e: ClaudeEvent) => seen.push(e))

    session.send('mensagem digitada')

    expect(seen.find((e) => e.kind === 'user')).toBeUndefined()
  })
})
