import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { comboFromEvent, formatCombo, sameCombo } from '../shortcuts/combo'
import { EDITABLE, FIXED, editableById, type ShortcutId } from '../shortcuts/registry'
import {
  checkCombo, findOwner, pruneOverrides, resolveBindings, sameOverrides, type Overrides, type Refusal,
} from '../shortcuts/resolve'

/** O aviso de uma gravação, na linha dela: tecla fora da gramática, recusa ou conflito. */
type Flash =
  | { id: ShortcutId; kind: 'unsupported' }
  | { id: ShortcutId; kind: 'refused'; combo: string; reason: Refusal }
  | { id: ShortcutId; kind: 'conflict'; combo: string; owner: ShortcutId }

/** As escolhas sem a da ação (ela volta ao padrão). */
const without = (o: Overrides, id: ShortcutId): Overrides =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== id))

/** `err`: recusa ou tecla não aceita; `warn` (amarelo): conflito, aviso da resolução ou do navegador. */
interface RowMessage { tone: 'info' | 'err' | 'warn'; text: string; conflict?: boolean }

/**
 * A aba Atalhos do painel: os editáveis com a combinação que vale no RASCUNHO
 * (nada vale antes do Salvar do painel) e os fixos, só para consulta.
 *
 * Gravar: clicar na combinação e apertar a nova. Enquanto grava, o ouvinte na
 * `window`, em captura, barra toda tecla — nenhum atalho do app dispara (nem com
 * o foco no campo de mensagem) e o Tab não tira o foco do painel. Esc cancela;
 * modificador sozinho espera; tecla fora da gramática avisa e espera.
 */
export function ShortcutsTab({ draft, onChange, admin, mac }: {
  draft: Overrides
  onChange(next: Overrides): void
  admin: boolean
  mac: boolean
}) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const { resolved, notices } = useMemo(() => resolveBindings(draft, { mac, admin }), [draft, mac, admin])

  // O rascunho mudou (gravou, trocou, voltou ao padrão, "Voltar todos"): o aviso
  // de antes já não fala do que está na tela.
  useEffect(() => { setFlash(null) }, [draft])

  const show = (combo: string) => formatCombo(combo, { mac, space: t('shortcuts.keySpace') })
  const labelOf = (id: ShortcutId) => t(editableById(id).labelKey as 'shortcuts.labels.send')

  /** Por que a combinação não serve para a ação, na frase da tela. */
  const why = (id: ShortcutId, reason: Refusal | 'taken', combo: string | null | undefined): string => {
    if (reason === 'fixed') {
      const v = combo ? checkCombo(id, combo, mac) : null
      const fixed = v && !v.ok ? FIXED.find((f) => f.id === v.fixedId) : undefined
      return t('shortcuts.why.fixed', { label: fixed ? t(fixed.labelKey as 'shortcuts.labels.clipboard') : '' })
    }
    if (reason === 'taken') {
      const owner = combo ? findOwner(combo, resolved, id, mac) : null
      return t('shortcuts.why.taken', { label: owner ? labelOf(owner) : '' })
    }
    return t(`shortcuts.why.${reason}` as 'shortcuts.why.invalid')
  }

  /** Grava no rascunho, sempre podado: o padrão nunca vira diferença. */
  const commit = (next: Overrides) => {
    const pruned = pruneOverrides(next)
    if (!sameOverrides(pruned, draft)) onChange(pruned)
  }

  /**
   * A escolha da ação no rascunho. O padrão desta plataforma tira a escolha (fora
   * do Mac, Ctrl+Espaço grava `Mod+Space`, que a poda — igual nos dois sistemas —
   * guardaria como diferença); a combinação que já vale não muda nada.
   */
  const assign = (base: Overrides, id: ShortcutId, combo: string): Overrides => {
    if (sameCombo(combo, editableById(id).default, mac)) return without(base, id)
    const current = resolved[id]
    if (current !== null && sameCombo(combo, current, mac)) return base
    return { ...base, [id]: combo }
  }

  const record = (id: ShortcutId, combo: string) => {
    setRecording(null)
    const verdict = checkCombo(id, combo, mac)
    if (!verdict.ok) { setFlash({ id, kind: 'refused', combo, reason: verdict.reason }); return }
    const owner = findOwner(combo, resolved, id, mac)
    if (owner) { setFlash({ id, kind: 'conflict', combo, owner }); return }
    setFlash(null)
    commit(assign(draft, id, combo))
  }
  // O ouvinte lê sempre a versão do render atual, sem renascer a cada render.
  const recordRef = useRef(record)
  recordRef.current = record

  /**
   * A tecla que acabou de gravar, até ela subir. O ouvinte da gravação sai junto
   * com a gravação, mas o keyup ainda vem depois — e no Firefox o keyup do Espaço
   * "clica" o botão da combinação, que continua focado, e a gravação recomeçaria.
   * Enquanto isto não é null, todo keyup é barrado; o da própria tecla encerra.
   */
  const swallowUp = useRef<{ key: string; code: string } | null>(null)

  // O ouvinte da gravação nasce e morre com ela.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.repeat) return
      if (e.key === 'Escape') { setRecording(null); setFlash(null); return }
      const combo = comboFromEvent(e, mac)
      if (combo === 'modifier') return
      if (combo === null) { setFlash({ id: recording, kind: 'unsupported' }); return }
      swallowUp.current = { key: e.key, code: e.code }
      recordRef.current(recording, combo)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, mac])

  // O keyup das teclas da gravação não chega a ninguém (nem ao botão focado).
  // Outra tecla descendo, ou a janela perdendo o foco, encerra: a soltura se
  // perdeu e o próximo keyup já é de outra coisa.
  useEffect(() => {
    const onUp = (e: KeyboardEvent) => {
      const down = swallowUp.current
      if (!down) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (down.code ? e.code === down.code : e.key === down.key) swallowUp.current = null
    }
    const forget = (e?: Event) => {
      if (e instanceof KeyboardEvent && e.repeat) return
      swallowUp.current = null
    }
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('keydown', forget, true)
    window.addEventListener('blur', forget)
    return () => {
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('keydown', forget, true)
      window.removeEventListener('blur', forget)
    }
  }, [])

  const startRecording = (id: ShortcutId) => {
    setFlash(null)
    setRecording((cur) => (cur === id ? null : id))
  }

  const swap = () => {
    if (flash?.kind !== 'conflict') return
    commit({ ...assign(draft, flash.id, flash.combo), [flash.owner]: null })
    setFlash(null)
  }

  const messageOf = (id: ShortcutId): RowMessage | null => {
    if (flash?.id === id) {
      if (flash.kind === 'unsupported') return { tone: 'err', text: t('shortcuts.unsupported') }
      if (flash.kind === 'refused') {
        return { tone: 'err', text: t('shortcuts.refused', { combo: show(flash.combo), why: why(id, flash.reason, flash.combo) }) }
      }
      return { tone: 'warn', text: t('shortcuts.conflict', { label: labelOf(flash.owner) }), conflict: true }
    }
    // Gravando: o botão diz só "Gravando…"; a instrução fica nesta linha, para o
    // texto longo não empurrar os botões para a linha de baixo.
    if (recording === id) return { tone: 'info', text: t('shortcuts.recordingHint') }
    const n = notices[id]
    if (n?.reverted && n.unbound) {
      return { tone: 'warn', text: t('shortcuts.noticeBoth', { why: why(id, n.reverted, draft[id]), label: labelOf(n.unbound) }) }
    }
    if (n?.reverted) return { tone: 'warn', text: t('shortcuts.noticeReverted', { why: why(id, n.reverted, draft[id]) }) }
    if (n?.unbound) return { tone: 'warn', text: t('shortcuts.noticeUnbound', { label: labelOf(n.unbound) }) }
    const current = resolved[id]
    if (current !== null) {
      const v = checkCombo(id, current, mac)
      if (v.ok && v.warn === 'browser') return { tone: 'warn', text: t('shortcuts.browserWarn') }
    }
    return null
  }

  return (
    <div className="sc-list">
      {EDITABLE.filter((e) => admin || !e.adminOnly).map((e) => {
        const current = resolved[e.id]
        const isRecording = recording === e.id
        const message = messageOf(e.id)
        const comboText = isRecording ? t('shortcuts.recording') : current === null ? t('shortcuts.none') : show(current)
        return (
          <div key={e.id} className="sc-row" data-testid={`sc-row-${e.id}`}>
            <div className="sc-row__main">
              <span className="sc-label">{labelOf(e.id)}</span>
              <div className="sc-row__actions">
                {Object.hasOwn(draft, e.id) && (
                  <button type="button" className="ghost sc-mini" data-testid={`sc-reset-${e.id}`}
                          onClick={() => commit(without(draft, e.id))}>
                    {t('shortcuts.resetOne')}
                  </button>
                )}
                {current !== null && (
                  <button type="button" className="ghost sc-mini" data-testid={`sc-clear-${e.id}`}
                          title={t('shortcuts.clearHint')}
                          onClick={() => commit({ ...draft, [e.id]: null })}>
                    {t('shortcuts.clear')}
                  </button>
                )}
                {/* O nome acessível leva a ação: sem ele o leitor de tela diria só "Alt+Z". */}
                <button type="button" data-testid={`sc-combo-${e.id}`} aria-pressed={isRecording}
                        aria-label={`${labelOf(e.id)}: ${comboText}`}
                        className={`sc-combo${isRecording ? ' sc-combo--recording' : ''}${current === null && !isRecording ? ' sc-combo--none' : ''}`}
                        onClick={() => startRecording(e.id)}>
                  {comboText}
                </button>
              </div>
            </div>
            {message && (
              <div data-testid={`sc-msg-${e.id}`} role="status" className={`sc-msg sc-msg--${message.tone}`}>
                <span>{message.text}</span>
                {message.conflict && (
                  <span className="sc-msg__actions">
                    <button type="button" className="sc-mini" data-testid="sc-swap" onClick={swap}>{t('shortcuts.swap')}</button>
                    <button type="button" className="ghost sc-mini" data-testid="sc-cancel" onClick={() => setFlash(null)}>
                      {t('common.cancel')}
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="sc-sep" />

      {FIXED.filter((f) => f.platform !== 'mac' || mac).map((f) => (
        <div key={f.id} className="sc-row sc-row--fixed" data-testid={`sc-fixed-${f.id}`}>
          <div className="sc-row__main">
            <span className="sc-label">{t(f.labelKey as 'shortcuts.labels.clipboard')}</span>
            <div className="sc-row__actions">
              <span className="sc-badge">{t('shortcuts.fixed')}</span>
              <span className="sc-keys">{f.keysLabel ?? f.combos.map(show).join(' · ')}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
