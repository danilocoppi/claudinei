import { describe, it, expect } from 'vitest'
import i18n from '../i18n'
import { EDITABLE, FIXED, editableById, isShortcutId, type ShortcutId } from '../shortcuts/registry'
import {
  checkCombo,
  findOwner,
  pruneOverrides,
  resolveBindings,
  sameOverrides,
} from '../shortcuts/resolve'

/**
 * Registro dos atalhos e resolução: o que cada combinação pode ser (recusas e
 * aviso do navegador) e o que vale ao juntar as escolhas guardadas com os padrões.
 */

const OFF = { mac: false, admin: true }
const MAC = { mac: true, admin: true }

const DEFAULTS_OFF: Record<ShortcutId, string | null> = {
  'chat.send': 'Mod+Enter',
  'chat.queue': 'Alt+Enter',
  'chat.voice': 'Ctrl+Space',
  'chat.stash': 'Mod+S',
  'chat.find': 'Mod+F',
  'view.zen': 'Alt+Z',
  'view.usage': 'Mod+U',
  'triage.undo': 'Mod+Z',
}

describe('registro', () => {
  it('os oito editáveis, na ordem e com os padrões das Global Constraints', () => {
    expect(EDITABLE.map((e) => [e.id, e.default, e.scope])).toEqual([
      ['chat.send', 'Mod+Enter', 'page'],
      ['chat.queue', 'Alt+Enter', 'field'],
      ['chat.voice', 'Ctrl+Space', 'page'],
      ['chat.stash', 'Mod+S', 'field'],
      ['chat.find', 'Mod+F', 'conversation'],
      ['view.zen', 'Alt+Z', 'allButTerminal'],
      ['view.usage', 'Mod+U', 'outsideFields'],
      ['triage.undo', 'Mod+Z', 'outsideFieldsAndModals'],
    ])
    expect(EDITABLE.filter((e) => e.adminOnly).map((e) => e.id)).toEqual(['view.usage'])
    expect(isShortcutId('view.zen')).toBe(true)
    expect(isShortcutId('chat.nada')).toBe(false)
    expect(editableById('chat.find').default).toBe('Mod+F')
  })

  it('os rótulos resolvem nas três línguas', async () => {
    const keys = [...EDITABLE, ...FIXED].map((s) => s.labelKey)
    const before = i18n.language
    try {
      for (const lng of ['en', 'es', 'pt-BR'] as const) {
        await i18n.changeLanguage(lng)
        for (const k of keys) expect(i18n.t(k as never), `${k} em ${lng}`).not.toBe(k)
      }
      expect(i18n.t('shortcuts.labels.stash')).toBe('Guardar rascunho')
      expect(i18n.t('shortcuts.labels.macEdit')).toBe('Edição de texto do macOS nos campos')
    } finally {
      await i18n.changeLanguage(before) // devolve a língua com que o teste começou
    }
  })
})

describe('checkCombo', () => {
  it('os padrões passam no checkCombo nos dois sistemas', () => {
    for (const mac of [true, false]) {
      for (const e of EDITABLE) expect(checkCombo(e.id, e.default, mac), `${e.id} mac=${mac}`).toEqual({ ok: true })
    }
  })

  it('fixo no mesmo lugar é recusado', () => {
    for (const mac of [true, false]) {
      expect(checkCombo('chat.send', 'Mod+C', mac)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.clipboard' })
      expect(checkCombo('chat.send', 'Mod+Z', mac)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.undoText' })
      expect(checkCombo('chat.stash', 'Mod+Shift+V', mac)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.pastePlain' })
      expect(checkCombo('view.zen', 'Mod+S', mac)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.editorSave' })
    }
    // Fora do Mac Ctrl é o próprio Mod.
    expect(checkCombo('chat.send', 'Ctrl+C', false)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.clipboard' })
  })

  it('fixo em outro lugar convive', () => {
    expect(checkCombo('triage.undo', 'Mod+Z', false)).toEqual({ ok: true })
    expect(checkCombo('chat.stash', 'Mod+S', false)).toEqual({ ok: true })
    expect(checkCombo('view.usage', 'Mod+Y', false)).toEqual({ ok: true })
  })

  it('edição do macOS só no Mac', () => {
    expect(checkCombo('chat.find', 'Ctrl+F', true)).toEqual({ ok: false, reason: 'fixed', fixedId: 'fixed.macEdit' })
    expect(checkCombo('chat.find', 'Ctrl+F', false)).toEqual({ ok: true })
  })

  it('reservadas', () => {
    expect(checkCombo('view.zen', 'Mod+W', false)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkCombo('view.zen', 'Mod+W', true)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkCombo('view.zen', 'Mod+H', true)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkCombo('view.zen', 'Mod+H', false)).toEqual({ ok: true })
    for (const mac of [true, false]) {
      for (const c of ['Mod+1', 'Mod+9', 'F5', 'F12']) {
        expect(checkCombo('view.zen', c, mac), `${c} mac=${mac}`).toEqual({ ok: false, reason: 'reserved' })
      }
    }
    expect(checkCombo('view.zen', 'Alt+F4', false)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkCombo('view.zen', 'Ctrl+W', false)).toEqual({ ok: false, reason: 'reserved' })
    expect(checkCombo('view.zen', 'Mod+Space', true)).toEqual({ ok: false, reason: 'reserved' })
  })

  it('modificador obrigatório', () => {
    expect(checkCombo('view.zen', 'M', false)).toEqual({ ok: false, reason: 'needsModifier' })
    expect(checkCombo('view.zen', 'Shift+M', true)).toEqual({ ok: false, reason: 'needsModifier' })
    expect(checkCombo('view.zen', 'Space', false)).toEqual({ ok: false, reason: 'needsModifier' })
    expect(checkCombo('view.zen', 'F2', false)).toEqual({ ok: true })
    expect(checkCombo('view.zen', 'Shift+F2', true)).toEqual({ ok: true })
  })

  it('AltGr', () => {
    expect(checkCombo('view.zen', 'Mod+Alt+M', false)).toEqual({ ok: false, reason: 'altGr' })
    expect(checkCombo('view.zen', 'Ctrl+Alt+M', false)).toEqual({ ok: false, reason: 'altGr' })
    expect(checkCombo('view.zen', 'Mod+Alt+M', true)).toEqual({ ok: true })
  })

  it('aviso do navegador', () => {
    expect(checkCombo('view.zen', 'Mod+R', false)).toEqual({ ok: true, warn: 'browser' })
    expect(checkCombo('view.zen', 'Mod+R', true)).toEqual({ ok: true, warn: 'browser' })
    expect(checkCombo('view.zen', 'Alt+D', false)).toEqual({ ok: true, warn: 'browser' })
    expect(checkCombo('view.zen', 'Alt+D', true)).toEqual({ ok: true })
  })

  it('gramática', () => {
    expect(checkCombo('view.zen', 'Mod+Tab', false)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkCombo('view.zen', 'Mod+,', true)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('resolveBindings', () => {
  it('resolveBindings sem escolhas: os oito padrões, sem avisos', () => {
    expect(resolveBindings({}, OFF)).toEqual({ resolved: DEFAULTS_OFF, notices: {} })
    expect(resolveBindings({}, MAC)).toEqual({ resolved: DEFAULTS_OFF, notices: {} })
  })

  it('id desconhecido é ignorado', () => {
    expect(resolveBindings({ 'chat.nada': 'Alt+Q' }, OFF)).toEqual(resolveBindings({}, OFF))
  })

  it('escolha reservada volta ao padrão', () => {
    const r = resolveBindings({ 'view.zen': 'Mod+W' }, OFF)
    expect(r.resolved['view.zen']).toBe('Alt+Z')
    expect(r.notices).toEqual({ 'view.zen': { reverted: 'reserved' } })
  })

  it('escolha que virou fixa volta ao padrão', () => {
    const r = resolveBindings({ 'chat.send': 'Mod+C' }, OFF)
    expect(r.resolved['chat.send']).toBe('Mod+Enter')
    expect(r.notices).toEqual({ 'chat.send': { reverted: 'fixed' } })
  })

  it('escolha fora da gramática volta ao padrão', () => {
    const r = resolveBindings({ 'view.zen': 'Mod+Tab' }, OFF)
    expect(r.resolved['view.zen']).toBe('Alt+Z')
    expect(r.notices).toEqual({ 'view.zen': { reverted: 'invalid' } })
  })

  it('null deixa sem atalho, sem aviso', () => {
    const r = resolveBindings({ 'triage.undo': null }, OFF)
    expect(r.resolved).toEqual({ ...DEFAULTS_OFF, 'triage.undo': null })
    expect(r.notices).toEqual({})
  })

  it('padrão ocupado por escolha do usuário', () => {
    const r = resolveBindings({ 'view.zen': 'Mod+Enter' }, OFF)
    expect(r.resolved['view.zen']).toBe('Mod+Enter')
    expect(r.resolved['chat.send']).toBeNull()
    expect(r.notices).toEqual({ 'chat.send': { unbound: 'view.zen' } })
  })

  it('voltou ao padrão e o padrão estava ocupado', () => {
    const r = resolveBindings({ 'view.zen': 'Mod+W', 'chat.send': 'Alt+Z' }, OFF)
    expect(r.resolved['chat.send']).toBe('Alt+Z')
    expect(r.resolved['view.zen']).toBeNull()
    expect(r.notices).toEqual({ 'view.zen': { reverted: 'reserved', unbound: 'chat.send' } })
  })

  it('⌘H só no Mac', () => {
    const mac = resolveBindings({ 'view.zen': 'Mod+H' }, MAC)
    expect(mac.resolved['view.zen']).toBe('Alt+Z')
    expect(mac.notices).toEqual({ 'view.zen': { reverted: 'reserved' } })
    const off = resolveBindings({ 'view.zen': 'Mod+H' }, OFF)
    expect(off.resolved['view.zen']).toBe('Mod+H')
    expect(off.notices).toEqual({})
  })

  it('Ctrl e Mod iguais fora do Mac', () => {
    const r = resolveBindings({ 'chat.find': 'Ctrl+K', 'view.zen': 'Mod+K' }, OFF)
    expect(r.resolved['chat.find']).toBe('Ctrl+K')
    expect(r.resolved['view.zen']).toBe('Alt+Z')
    expect(r.notices).toEqual({ 'view.zen': { reverted: 'taken' } })
    // No Mac são teclas diferentes: as duas valem (Ctrl+K lá é edição do macOS, por isso o I).
    const mac = resolveBindings({ 'chat.find': 'Ctrl+I', 'view.zen': 'Mod+I' }, MAC)
    expect(mac.resolved['chat.find']).toBe('Ctrl+I')
    expect(mac.resolved['view.zen']).toBe('Mod+I')
    expect(mac.notices).toEqual({})
  })

  it('não administrador: uso sem atalho, sem aviso, e Mod+U livre', () => {
    const user = resolveBindings({ 'view.zen': 'Mod+U' }, { mac: false, admin: false })
    expect(user.resolved['view.zen']).toBe('Mod+U')
    expect(user.resolved['view.usage']).toBeNull()
    expect(user.notices).toEqual({})
    const admin = resolveBindings({ 'view.zen': 'Mod+U' }, OFF)
    expect(admin.resolved['view.zen']).toBe('Mod+U')
    expect(admin.resolved['view.usage']).toBeNull()
    expect(admin.notices).toEqual({ 'view.usage': { unbound: 'view.zen' } })
  })

  it('não administrador: a escolha guardada do uso também não vale', () => {
    const r = resolveBindings({ 'view.usage': 'Alt+U' }, { mac: false, admin: false })
    expect(r.resolved['view.usage']).toBeNull()
    expect(r.notices).toEqual({})
  })
})

describe('findOwner', () => {
  it('acha quem usa a combinação, menos o próprio', () => {
    const { resolved } = resolveBindings({}, OFF)
    expect(findOwner('Ctrl+Enter', resolved, 'view.zen', false)).toBe('chat.send')
    expect(findOwner('Ctrl+Enter', resolved, 'chat.send', false)).toBeNull()
    // No Mac Ctrl+Enter não é ⌘↩.
    expect(findOwner('Ctrl+Enter', resolved, 'view.zen', true)).toBeNull()
    expect(findOwner('Alt+Q', resolved, 'view.zen', false)).toBeNull()
  })
})

describe('pruneOverrides e sameOverrides', () => {
  it('pruneOverrides', () => {
    expect(pruneOverrides({
      'chat.nada': 'Alt+Q',
      'view.zen': 'Alt+Z',
      'chat.send': 'Ctrl+Enter',
      'triage.undo': null,
      'chat.find': 'Alt+F',
    })).toEqual({ 'chat.send': 'Ctrl+Enter', 'triage.undo': null, 'chat.find': 'Alt+F' })
    // A conta vale nos dois sistemas: Ctrl+Enter é ⌃↩ no Mac e fica, mesmo salvo fora do Mac.
    expect(pruneOverrides({ 'chat.send': 'Mod+Enter' })).toEqual({})
  })

  it('sameOverrides ignora a ordem das chaves', () => {
    expect(sameOverrides({ 'view.zen': 'Alt+M', 'triage.undo': null }, { 'triage.undo': null, 'view.zen': 'Alt+M' })).toBe(true)
    expect(sameOverrides({}, {})).toBe(true)
    expect(sameOverrides({ 'view.zen': 'Alt+M' }, { 'view.zen': 'Alt+N' })).toBe(false)
    expect(sameOverrides({ 'view.zen': 'Alt+M' }, { 'view.zen': 'Alt+M', 'triage.undo': null })).toBe(false)
    expect(sameOverrides({ 'triage.undo': null }, {})).toBe(false)
  })
})
