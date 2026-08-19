import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveAppearance } from '../api'
import { useStore } from '../store'
import {
  ACCENTS, CHAT_WIDTHS, CODE_FONTS, DEFAULT_APPEARANCE, DENSITIES, RADII, THEMES, UI_FONTS,
  type Appearance, type Option,
} from '../appearance'

/**
 * Amostra do tema: o fundo, uma superfície e o acento DAQUELE pacote. Um nome de
 * tema não diz nada — a amostra diz. As cores vêm de um elemento marcado com o
 * `data-theme` do pacote, então uma amostra nova nasce junto com o tema, sem
 * ninguém precisar repetir a paleta aqui.
 */
function ThemeSwatch({ theme, on, onPick }: { theme: Option; on: boolean; onPick: () => void }) {
  return (
    <button type="button" data-testid={`theme-${theme.id}`} data-theme={theme.id}
            className={`ap-swatch ${on ? 'on' : ''}`} onClick={onPick}>
      <span className="ap-swatch__preview">
        <span className="ap-swatch__dot ap-swatch__dot--surface" />
        <span className="ap-swatch__dot ap-swatch__dot--accent" />
        <span className="ap-swatch__dot ap-swatch__dot--text" />
      </span>
      <span className="ap-swatch__name">{theme.label}</span>
    </button>
  )
}

/** Escolha em pastilhas: para 2–4 opções, ver todas de uma vez bate um dropdown. */
function Pills({ options, value, onPick, testPrefix }: {
  options: Option[]; value: string; onPick: (id: string) => void; testPrefix: string
}) {
  const { t } = useTranslation()
  return (
    <div className="ap-pills">
      {options.map((o) => (
        <button key={o.id} type="button" data-testid={`${testPrefix}-${o.id}`}
                className={`ap-pill ${value === o.id ? 'on' : ''}`} onClick={() => onPick(o.id)}>
          {o.label.startsWith('appearance.') ? t(o.label as 'appearance.widthFull') : o.label}
        </button>
      ))}
    </div>
  )
}

export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const current = useStore((s) => s.appearance)
  const apply = useStore((s) => s.applyAppearance)
  // O que estava valendo quando o painel abriu: preview ao vivo sem volta atrás
  // vira armadilha, então cancelar precisa de um lugar para onde voltar.
  const before = useRef<Appearance>(current)
  const [draft, setDraft] = useState<Appearance>(current)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  /** Preview ao vivo: o app inteiro atrás do modal é a amostra. */
  const change = (patch: Partial<Appearance>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    apply(next)
  }

  const cancel = () => { apply(before.current); onClose() }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const { appearance } = await saveAppearance(draft)
      apply(appearance)   // o servidor devolve o objeto saneado; é ele que vale
      onClose()
    } catch (err) {
      // Manter o visual escolhido: reverter porque a rede caiu seria pior que o
      // problema — a escolha continua na tela e no cache, só não foi guardada.
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const accentOf = (a: Option) => a.css ?? 'var(--accent)'

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="glass ap-panel" data-testid="appearance-panel" onClick={(e) => e.stopPropagation()}>
        <header className="ap-panel__head">
          <span aria-hidden="true">🎨</span>
          <h3>{t('appearance.title')}</h3>
        </header>

        <div className="ap-panel__body">
          <div className="ap-field">
            <span>{t('appearance.theme')}</span>
            <div className="ap-swatches">
              {THEMES.map((th) => (
                <ThemeSwatch key={th.id} theme={th} on={draft.theme === th.id} onPick={() => change({ theme: th.id })} />
              ))}
            </div>
          </div>

          <div className="ap-field">
            <span>{t('appearance.accent')}</span>
            <div className="ap-accents">
              {ACCENTS.map((a) => (
                <button key={a.id} type="button" title={t(a.label as 'appearance.accentTheme')}
                        className={`ap-accent ${draft.accent === a.id ? 'on' : ''} ${a.css ? '' : 'ap-accent--theme'}`}
                        style={{ ['--chip' as string]: accentOf(a) }}
                        onClick={() => change({ accent: a.id })} />
              ))}
            </div>
          </div>

          <div className="ap-field">
            <span>{t('appearance.chatWidth')}</span>
            <Pills options={CHAT_WIDTHS} value={draft.chatWidth} testPrefix="width" onPick={(chatWidth) => change({ chatWidth })} />
            <p className="ap-hint">{t('appearance.chatWidthHint')}</p>
          </div>

          <div className="ap-row">
            <label className="ap-field">
              <span>{t('appearance.fontUi')}</span>
              <select data-testid="ap-font-ui" value={draft.fontUi} onChange={(e) => change({ fontUi: e.target.value })}>
                {UI_FONTS.map((f) => <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>{f.label}</option>)}
              </select>
            </label>
            <label className="ap-field">
              <span>{t('appearance.fontCode')}</span>
              <select data-testid="ap-font-code" value={draft.fontCode} onChange={(e) => change({ fontCode: e.target.value })}>
                {CODE_FONTS.map((f) => <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>{f.label}</option>)}
              </select>
            </label>
          </div>

          <div className="ap-row">
            <div className="ap-field">
              <span>{t('appearance.density')}</span>
              <Pills options={DENSITIES} value={draft.density} testPrefix="density" onPick={(density) => change({ density })} />
            </div>
            <div className="ap-field">
              <span>{t('appearance.radius')}</span>
              <Pills options={RADII} value={draft.radius} testPrefix="radius" onPick={(radius) => change({ radius })} />
            </div>
          </div>

          <label className="ap-toggle">
            <input data-testid="ap-glass" type="checkbox" checked={draft.glass} onChange={(e) => change({ glass: e.target.checked })} />
            <span>
              <strong>{t('appearance.glass')}</strong>
              <em>{t('appearance.glassHint')}</em>
            </span>
          </label>

          <label className="ap-toggle">
            <input data-testid="ap-motion" type="checkbox" checked={draft.reducedMotion}
                   onChange={(e) => change({ reducedMotion: e.target.checked })} />
            <span>
              <strong>{t('appearance.reducedMotion')}</strong>
              <em>{t('appearance.reducedMotionHint')}</em>
            </span>
          </label>

          {error && <div className="ap-error" role="alert">{t('appearance.saveFailed', { error })}</div>}
        </div>

        <footer className="ap-panel__foot">
          <button className="ghost" onClick={() => { setDraft(DEFAULT_APPEARANCE); apply(DEFAULT_APPEARANCE) }}>
            {t('appearance.restore')}
          </button>
          <div className="ap-panel__foot-right">
            <button className="ghost" onClick={cancel}>{t('common.cancel')}</button>
            <button disabled={saving} onClick={() => void save()}>{t('common.save')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
