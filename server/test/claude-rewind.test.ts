import { describe, it, expect, afterEach, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { turnKey } from '../../shared/undo.js'
import { transcriptPath } from '../src/history.js'
import { claudeForkArgs, createClaudeRewind, findClaudeCut } from '../src/undo/rewind-claude.js'
import { UserError } from '../src/user-error.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/rewind-transcript.jsonl', import.meta.url))
// uuids sintéticos do fixture: U(n) = 00000000-0000-4000-8000-<n com 12 dígitos>
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NEW_ID = '22222222-2222-4222-8222-222222222222'
const OLD_ID = '11111111-1111-4111-8111-111111111111'

const roots: string[] = []
const savedConfig = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
})

/** Manager espião: só o que o adaptador do Claude usa. */
function spyManager(engineSessionId: string | null = OLD_ID) {
  return {
    relaunch: vi.fn(async (_localId: string, _opts: { resumeSessionId: string | null; extraArgs?: string[]; holdEngineId?: boolean }) => ({}) as any),
    get: vi.fn((_localId: string) => ({ localId: 'L1', engine: 'claude', engineSessionId }) as any),
  }
}

describe('findClaudeCut', () => {
  it('devolve o parentUuid da mensagem, não o uuid (ensaio C2: o corte é inclusivo)', async () => {
    const cut = await findClaudeCut(FIXTURE, turnKey('repete isto'), 1)
    // A mensagem é U(4); o corte fica na entrada anterior, o stop_hook_summary U(3).
    expect(cut).toEqual({ kind: 'claude', parentUuid: U(3) })
  })

  it('ignora isMeta, isSidechain, tool_result e resumo de compactação', async () => {
    // Só U(4) e U(15) valem: as entradas U(6), U(7), U(8), U(11) e U(14) têm o mesmo texto e não contam.
    expect(await findClaudeCut(FIXTURE, turnKey('repete isto'), 0)).toEqual({ kind: 'claude', parentUuid: U(14) })
    expect(await findClaudeCut(FIXTURE, turnKey('repete isto'), 2)).toBeNull()
    // Comando de barra não é mensagem do operador.
    expect(await findClaudeCut(FIXTURE, turnKey('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'), 0)).toBeNull()
  })

  it('occurrence conta de trás para frente entre textos iguais', async () => {
    const latest = await findClaudeCut(FIXTURE, turnKey('repete isto'), 0)
    const earlier = await findClaudeCut(FIXTURE, turnKey('repete isto'), 1)
    expect(latest?.parentUuid).toBe(U(14))
    expect(earlier?.parentUuid).toBe(U(3))
  })

  it('primeira mensagem: parentUuid null', async () => {
    expect(await findClaudeCut(FIXTURE, turnKey('olá, primeira mensagem'), 0)).toEqual({ kind: 'claude', parentUuid: null })
  })

  it('texto que não existe: null', async () => {
    expect(await findClaudeCut(FIXTURE, turnKey('nunca foi dito'), 0)).toBeNull()
    expect(await findClaudeCut(join(tmpdir(), 'nao-existe-rewind.jsonl'), turnKey('repete isto'), 0)).toBeNull()
    expect(await findClaudeCut(FIXTURE, turnKey('repete isto'), -1)).toBeNull()
  })

  it('a nota do Claudinei na frente da mensagem não entra na chave', async () => {
    expect(await findClaudeCut(FIXTURE, turnKey('mensagem depois da volta'), 0)).toEqual({ kind: 'claude', parentUuid: U(17) })
  })
})

describe('claudeForkArgs', () => {
  it('monta o corte, o fork e o id novo', () => {
    expect(claudeForkArgs(U(3), NEW_ID)).toEqual(['--resume-session-at', U(3), '--fork-session', '--session-id', NEW_ID])
  })

  it('claudeForkArgs recusa valor que não é uuid', () => {
    expect(() => claudeForkArgs('msg_01abc', NEW_ID)).toThrow()
    expect(() => claudeForkArgs(U(3), '--dangerously-skip-permissions')).toThrow()
    expect(() => claudeForkArgs(`${U(3)}\n`, NEW_ID)).toThrow()
    expect(() => claudeForkArgs('', NEW_ID)).toThrow()
  })
})

describe('createClaudeRewind', () => {
  const ctx = { localId: 'L1', projectPath: '/tmp/projeto-ficticio', engineSessionId: OLD_ID }

  it('apply chama relaunch com --resume do id atual, os args do fork e holdEngineId', async () => {
    const manager = spyManager()
    const rewind = createClaudeRewind({ manager, newId: () => NEW_ID })
    const out = await rewind.apply(ctx, { kind: 'claude', parentUuid: U(3) })
    expect(out).toEqual({ newConversationId: NEW_ID })
    expect(manager.relaunch).toHaveBeenCalledTimes(1)
    expect(manager.relaunch).toHaveBeenCalledWith('L1', {
      resumeSessionId: OLD_ID,
      extraArgs: ['--resume-session-at', U(3), '--fork-session', '--session-id', NEW_ID],
      holdEngineId: true,
    })
  })

  it('apply sem engineSessionId no ctx pega o id do manager', async () => {
    const manager = spyManager('33333333-3333-4333-8333-333333333333')
    const rewind = createClaudeRewind({ manager, newId: () => NEW_ID })
    await rewind.apply({ ...ctx, engineSessionId: null }, { kind: 'claude', parentUuid: U(3) })
    expect(manager.relaunch.mock.calls[0][1].resumeSessionId).toBe('33333333-3333-4333-8333-333333333333')
  })

  it('apply sem conversa nenhuma recusa com no_session e não relança', async () => {
    const manager = spyManager(null)
    const rewind = createClaudeRewind({ manager, newId: () => NEW_ID })
    const err = await rewind.apply({ ...ctx, engineSessionId: null }, { kind: 'claude', parentUuid: U(3) }).catch((e) => e)
    expect(err).toBeInstanceOf(UserError)
    expect(err.code).toBe('no_session')
    expect(manager.relaunch).not.toHaveBeenCalled()
  })

  it('apply da primeira mensagem relança sem resume', async () => {
    const manager = spyManager()
    const rewind = createClaudeRewind({ manager, newId: () => NEW_ID })
    const out = await rewind.apply(ctx, { kind: 'claude', parentUuid: null })
    expect(out).toEqual({})
    expect(manager.relaunch).toHaveBeenCalledWith('L1', { resumeSessionId: null, holdEngineId: true })
  })

  it('apply recusa corte de outro motor', async () => {
    const manager = spyManager()
    const rewind = createClaudeRewind({ manager, newId: () => NEW_ID })
    await expect(rewind.apply(ctx, { kind: 'codex', beforeTurnId: 't1', midTurn: false })).rejects.toThrow()
    expect(manager.relaunch).not.toHaveBeenCalled()
  })

  it('newId padrão é um uuid aleatório', async () => {
    const manager = spyManager()
    const rewind = createClaudeRewind({ manager })
    const out = await rewind.apply(ctx, { kind: 'claude', parentUuid: U(3) })
    expect(out.newConversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('locate lê o transcript da conversa atual na pasta de config do Claude', async () => {
    const config = mkdtempSync(join(tmpdir(), 'claude-rewind-'))
    roots.push(config)
    process.env.CLAUDE_CONFIG_DIR = config
    const file = transcriptPath(config, ctx.projectPath, OLD_ID)
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(FIXTURE, file)
    const rewind = createClaudeRewind({ manager: spyManager() })
    expect(await rewind.locate(ctx, turnKey('repete isto'), 1)).toEqual({ kind: 'claude', parentUuid: U(3) })
    // Sem id no ctx, o do manager.
    expect(await rewind.locate({ ...ctx, engineSessionId: null }, turnKey('repete isto'), 0)).toEqual({ kind: 'claude', parentUuid: U(14) })
  })

  it('locate sem conversa ou com id estranho: null', async () => {
    const rewind = createClaudeRewind({ manager: spyManager(null) })
    expect(await rewind.locate({ ...ctx, engineSessionId: null }, turnKey('repete isto'), 0)).toBeNull()
    expect(await rewind.locate({ ...ctx, engineSessionId: '../../etc/passwd' }, turnKey('repete isto'), 0)).toBeNull()
  })
})
