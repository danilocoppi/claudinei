import { describe, it, expect } from 'vitest'
import { buildTurnArgs, buildTerminalArgs } from '../src/engine/kimi/kimi-args.js'

describe('kimi args', () => {
  it('turno novo: prompt como valor de -p e stream-json', () => {
    expect(buildTurnArgs({ prompt: 'oi' })).toEqual(['--output-format', 'stream-json', '-p', 'oi'])
  })

  it('resume vem antes do prompt (-r <id>)', () => {
    expect(buildTurnArgs({ prompt: 'oi', resumeSessionId: 'session_1' }))
      .toEqual(['-r', 'session_1', '--output-format', 'stream-json', '-p', 'oi'])
  })

  it('model entra como -m; vazio não vira flag', () => {
    expect(buildTurnArgs({ prompt: 'x', model: 'kimi-code/k3' })).toContain('-m')
    expect(buildTurnArgs({ prompt: 'x', model: '' })).not.toContain('-m')
  })

  it('prompt começando com hífen não é lido como flag (é valor de -p)', () => {
    const args = buildTurnArgs({ prompt: '--version' })
    expect(args[args.indexOf('-p') + 1]).toBe('--version')
    expect(args[args.length - 1]).toBe('--version')
  })

  it('terminal: --auto sempre; -r só quando há conversa a retomar', () => {
    expect(buildTerminalArgs('session_9')).toEqual(['-r', 'session_9', '--auto'])
    expect(buildTerminalArgs(null)).toEqual(['--auto'])
  })
})
