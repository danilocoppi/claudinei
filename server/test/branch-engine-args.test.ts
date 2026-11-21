import { describe, it, expect } from 'vitest'
import { claudeBranchArgs, codexForkParams } from '../src/branch/engine-args.js'
import { buildClaudeArgs } from '../src/claude/session.js'

/**
 * Cópia nativa: os args do Claude e os params do `thread/fork` do Codex.
 * Funções puras; nada de CLI. Os valores seguem os ensaios com as CLIs reais
 * (corte do Claude = `uuid` da entrada; fork efêmero do Codex exige `excludeTurns`).
 */

/** Valor da flag (o argumento seguinte). */
const valueOf = (args: string[], flag: string) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
/** A sequência aparece contígua nos args. */
const hasRun = (args: string[], run: string[]) =>
  args.some((_, i) => run.every((v, j) => args[i + j] === v))

describe('claudeBranchArgs', () => {
  it('sem nenhum campo devolve os args iguais', () => {
    const base = buildClaudeArgs({ resumeSessionId: 'abc', model: 'opus' })
    expect(claudeBranchArgs(base, {})).toEqual(base)
  })

  it('lateral do Claude: cópia sem rastro, só leitura e sem hermes', () => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    const args = claudeBranchArgs(buildClaudeArgs({ continueLatest: true, model: 'sonnet' }), {
      forkFrom: { sourceId: 'src-session', cut: uuid },
      sessionId: 'side-id',
      readOnly: true,
      ephemeral: true,
    })
    expect(hasRun(args, ['--resume', 'src-session', '--fork-session'])).toBe(true)
    expect(valueOf(args, '--resume-session-at')).toBe(uuid)
    expect(args).toContain('--no-session-persistence')
    expect(valueOf(args, '--session-id')).toBe('side-id')
    expect(valueOf(args, '--permission-mode')).toBe('plan')
    // AskUserQuestion e ExitPlanMode também: a lateral não responde pergunta
    // (o turno travaria em "trabalhando") e sair do modo plano a tiraria do só leitura.
    expect(hasRun(args, ['--disallowed-tools', 'Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'ExitPlanMode'])).toBe(true)
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--continue')
    // O resto do launch continua lá.
    expect(valueOf(args, '--model')).toBe('sonnet')
    expect(args).toContain('--permission-prompt-tool')
    // A lista variádica vem seguida de outra flag ou do fim (nunca de um valor solto).
    const i = args.indexOf('--disallowed-tools')
    const after = args[i + 6]
    expect(after === undefined || after.startsWith('--')).toBe(true)
  })

  it('ramo do Claude: troca o --resume do original pela cópia e mantém o bypass', () => {
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const args = claudeBranchArgs(buildClaudeArgs({ resumeSessionId: 'velho' }), {
      forkFrom: { sourceId: 'src', cut: uuid },
      sessionId: 'X',
    })
    expect(args.filter((a) => a === '--resume')).toHaveLength(1)
    expect(args).not.toContain('velho')
    expect(hasRun(args, ['--resume', 'src', '--fork-session'])).toBe(true)
    expect(valueOf(args, '--session-id')).toBe('X')
    expect(valueOf(args, '--resume-session-at')).toBe(uuid)
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--no-session-persistence')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--disallowed-tools')
  })

  it('--resume-session-at só com cut', () => {
    const args = claudeBranchArgs(buildClaudeArgs({}), { forkFrom: { sourceId: 'src' } })
    expect(hasRun(args, ['--resume', 'src', '--fork-session'])).toBe(true)
    expect(args).not.toContain('--resume-session-at')
    expect(args).not.toContain('--session-id')
  })

  it('não altera o array recebido', () => {
    const base = buildClaudeArgs({ resumeSessionId: 'velho' })
    const copy = [...base]
    claudeBranchArgs(base, { forkFrom: { sourceId: 'src' }, readOnly: true, ephemeral: true, sessionId: 'S' })
    expect(base).toEqual(copy)
  })

  it('sessionId e ephemeral valem também sem forkFrom', () => {
    const args = claudeBranchArgs(['-p'], { sessionId: 'S', ephemeral: true })
    expect(args).toEqual(['-p', '--session-id', 'S', '--no-session-persistence'])
  })
})

describe('codexForkParams', () => {
  const base = {
    cwd: '/proj', approvalPolicy: 'never', sandbox: 'danger-full-access',
    model: 'gpt-x', config: { model_reasoning_effort: 'high' },
  }

  it('excludeTurns: true sempre, mesmo no ramo persistente', () => {
    expect(codexForkParams(base, { forkFrom: { sourceId: 'T1' } })).toMatchObject({ excludeTurns: true })
    expect(codexForkParams(base, { forkFrom: { sourceId: 'T1' }, ephemeral: true })).toMatchObject({ excludeTurns: true })
  })

  it('lateral: ephemeral e sandbox read-only, cortada no turno', () => {
    const p = codexForkParams(base, { forkFrom: { sourceId: 'T1', cut: 'turn-9' }, readOnly: true, ephemeral: true })
    expect(p).toEqual({
      cwd: '/proj', approvalPolicy: 'never', model: 'gpt-x', config: { model_reasoning_effort: 'high' },
      threadId: 'T1', lastTurnId: 'turn-9', excludeTurns: true, ephemeral: true, sandbox: 'read-only',
    })
  })

  it('ramo: mantém o sandbox e as developerInstructions; sem ephemeral', () => {
    const p = codexForkParams({ ...base, developerInstructions: 'regra' }, { forkFrom: { sourceId: 'T1', cut: 'turn-2' } })
    expect(p).toMatchObject({ threadId: 'T1', lastTurnId: 'turn-2', sandbox: 'danger-full-access', developerInstructions: 'regra' })
    expect(p).not.toHaveProperty('ephemeral')
  })

  it('lastTurnId só com cut', () => {
    expect(codexForkParams(base, { forkFrom: { sourceId: 'T1' } })).not.toHaveProperty('lastTurnId')
  })

  it('o threadId é o da origem, mesmo que os params de base tragam outro', () => {
    expect(codexForkParams({ ...base, threadId: 'OUTRO' }, { forkFrom: { sourceId: 'T1' } }).threadId).toBe('T1')
  })
})
