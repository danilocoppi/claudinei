import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  ENGINES_FILTERING_ENV, TERMINAL_MARKER_VAR, markerInstance, markerInstanceId, setMarkerInstance, terminalMarker, withMarker,
} from '../src/local-servers/marker.js'

describe('marcador do terminal', () => {
  it('a variável tem o nome combinado', () => {
    expect(TERMINAL_MARKER_VAR).toBe('CLAUDINEI_TERMINAL')
  })

  it('terminalMarker junta a instância, o projeto e o motor', () => {
    expect(terminalMarker(4, 'claude', 'a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6:4:claude')
    // Sem a instância explícita, vale a desta instância.
    expect(terminalMarker(4, 'claude')).toBe(`${markerInstance()}:4:claude`)
  })

  it('o id da instância vem do caminho do banco: curto, estável e sem o caminho', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marcador-inst-'))
    try {
      const db = join(dir, 'claudinei.db')
      writeFileSync(db, '')
      const id = markerInstanceId(db)
      expect(id).toMatch(/^[0-9a-f]{12}$/)
      // Mesmo banco, mesmo id: no reinício, pelo caminho relativo e por um link.
      expect(markerInstanceId(db)).toBe(id)
      expect(markerInstanceId(relative(process.cwd(), db))).toBe(id)
      symlinkSync(db, join(dir, 'link.db'))
      expect(markerInstanceId(join(dir, 'link.db'))).toBe(id)
      // Outro banco (a instância de ensaio), outro id.
      expect(markerInstanceId(join(dir, 'outro.db'))).not.toBe(id)
      // O banco ainda por criar também tem id (o caminho absoluto).
      expect(markerInstanceId(join(dir, 'novo', 'claudinei.db'))).toMatch(/^[0-9a-f]{12}$/)
      expect(id).not.toContain('claudinei')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('setMarkerInstance troca a instância dos marcadores e recusa id fora do formato', () => {
    const antes = markerInstance()
    try {
      setMarkerInstance('0123456789ab')
      expect(markerInstance()).toBe('0123456789ab')
      expect(terminalMarker(7, 'codex')).toBe('0123456789ab:7:codex')
      expect(() => setMarkerInstance('')).toThrow()
      expect(() => setMarkerInstance('7:codex')).toThrow()
    } finally { setMarkerInstance(antes) }
  })

  it('sem setMarkerInstance (fora do serviço), a instância é aleatória do processo: nunca a de um banco', () => {
    expect(markerInstance()).toMatch(/^[0-9a-f]{12}$/)
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
