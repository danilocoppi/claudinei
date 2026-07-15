import { describe, it, expect } from 'vitest'
import { filterCommands, BUILTIN_FALLBACK, HIDDEN, SLASH_DESCRIPTIONS } from '../slash'
import en from '../i18n/en'
import ptBR from '../i18n/pt-BR'
import es from '../i18n/es'

describe('filterCommands', () => {
  it('filtra por substring, ignorando caixa', () => {
    expect(filterCommands(['compact', 'cost', 'clear', 'model'], 'co')).toEqual(['compact', 'cost'])
  })
  it('exclui os HIDDEN (exit/help)', () => {
    expect(filterCommands(['exit', 'help', 'compact'], '')).not.toContain('exit')
    expect(filterCommands(['exit', 'help', 'compact'], '')).not.toContain('help')
  })
  it('built-ins com descrição vêm antes dos de plugin', () => {
    const out = filterCommands(['figma:figma-use', 'compact'], '')
    expect(out.indexOf('compact')).toBeLessThan(out.indexOf('figma:figma-use'))
  })
  it('query vazia lista tudo (menos HIDDEN)', () => {
    expect(filterCommands(['compact', 'exit'], '')).toEqual(['compact'])
  })
})

describe('BUILTIN_FALLBACK', () => {
  it('não inclui comandos HIDDEN', () => {
    for (const c of BUILTIN_FALLBACK) expect(HIDDEN.has(c)).toBe(false)
  })
})

describe('SLASH_DESCRIPTIONS — comandos curados do OpenCode', () => {
  it('mapeia new/sessions/models/share/redo para as chaves i18n slash.*', () => {
    expect(SLASH_DESCRIPTIONS.new).toBe('slash.new')
    expect(SLASH_DESCRIPTIONS.sessions).toBe('slash.sessions')
    expect(SLASH_DESCRIPTIONS.models).toBe('slash.models')
    expect(SLASH_DESCRIPTIONS.share).toBe('slash.share')
    expect(SLASH_DESCRIPTIONS.redo).toBe('slash.redo')
  })

  it('as 5 chaves i18n existem nos 3 idiomas (en/pt-BR/es)', () => {
    for (const dict of [en, ptBR, es]) {
      expect(dict.slash.new).toBeTruthy()
      expect(dict.slash.sessions).toBeTruthy()
      expect(dict.slash.models).toBeTruthy()
      expect(dict.slash.share).toBeTruthy()
      expect(dict.slash.redo).toBeTruthy()
    }
  })

  it('os comandos curados do OpenCode ficam ordenados (não caem no fallback alfabético)', () => {
    const out = filterCommands(['redo', 'new', 'zzz-plugin'], '')
    expect(out.indexOf('new')).toBeLessThan(out.indexOf('zzz-plugin'))
    expect(out.indexOf('redo')).toBeLessThan(out.indexOf('zzz-plugin'))
  })
})
