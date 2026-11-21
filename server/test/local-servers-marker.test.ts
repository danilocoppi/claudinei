import { describe, expect, it } from 'vitest'
import { ENGINES_FILTERING_ENV, TERMINAL_MARKER_VAR, terminalMarker, withMarker } from '../src/local-servers/marker.js'

describe('marcador do terminal', () => {
  it('a variável tem o nome combinado', () => {
    expect(TERMINAL_MARKER_VAR).toBe('CLAUDINEI_TERMINAL')
  })

  it('terminalMarker junta projeto e motor', () => {
    expect(terminalMarker(4, 'claude')).toBe('4:claude')
  })

  it('withMarker troca o marcador herdado e preserva o resto, sem mexer na entrada', () => {
    const env = { A: '1', CLAUDINEI_TERMINAL: '9:x' }
    const out = withMarker(env, '4:claude')
    expect(out.CLAUDINEI_TERMINAL).toBe('4:claude')
    expect(out.A).toBe('1')
    expect(env).toEqual({ A: '1', CLAUDINEI_TERMINAL: '9:x' })
    expect(out).not.toBe(env)
  })

  it('withMarker sem marcador apaga o herdado do serviço', () => {
    const env = { CLAUDINEI_TERMINAL: '9:x' }
    const out = withMarker(env, undefined)
    expect('CLAUDINEI_TERMINAL' in out).toBe(false)
    expect(env).toEqual({ CLAUDINEI_TERMINAL: '9:x' })
  })

  it('só Kimi e OpenCode podem estar entre os motores que filtram o ambiente', () => {
    for (const engine of ENGINES_FILTERING_ENV) expect(['kimi', 'opencode']).toContain(engine)
  })
})
