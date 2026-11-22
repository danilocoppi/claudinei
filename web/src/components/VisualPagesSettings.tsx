import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { fetchPagesSettings, savePagesSettings } from '../pages/api'
import { useDialogKeys } from './undo/useDialogKeys'
import type { PageNetwork } from '../../../shared/visual-pages'
import '../pages/pages.css'

const messageOf = (e: unknown) => (e instanceof Error && e.message) || String(e)

/**
 * "Páginas visuais", do menu do usuário (só admin): a rede que o código das
 * páginas alcança, global, para todos os terminais e usuários. Só as CDNs
 * conhecidas (padrão) ou a rede liberada, com o aviso do que isso abre. Vale na
 * próxima abertura de cada página. Salvou, fecha; erro fica no diálogo.
 */
export function VisualPagesSettings({ onClose }: { onClose(): void }) {
  const { t } = useTranslation()
  // null enquanto a configuração não chega.
  const [network, setNetwork] = useState<PageNetwork | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLFormElement>(null)
  const onKeyDown = useDialogKeys(dialog, onClose)

  useEffect(() => {
    let alive = true
    fetchPagesSettings().then(
      (r) => { if (alive) setNetwork(r.network === 'open' ? 'open' : 'cdn') },
      (e) => { if (alive) setLoadError(messageOf(e)) },
    )
    return () => { alive = false }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!network || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await savePagesSettings(network)
      onClose()
    } catch (err) {
      setSaveError(messageOf(err))
      setSaving(false)
    }
  }

  const title = t('pages.settingsTitle')
  const radio = (value: PageNetwork, label: string) => (
    <label className="pages-settings__option">
      <input type="radio" name="visual-pages-network" value={value} checked={network === value}
             disabled={network === null} onChange={() => setNetwork(value)} />
      <span>{label}</span>
    </label>
  )

  return createPortal(
    <div className="pages-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form ref={dialog} className="pages-dialog pages-settings" role="dialog" aria-modal="true" aria-label={title}
            tabIndex={-1} onKeyDown={onKeyDown} onSubmit={submit}>
        <div className="pages-dialog__head">
          <h3 className="pages-dialog__title">{title}</h3>
        </div>
        <div className="pages-settings__body">
          <fieldset className="pages-settings__group">
            <legend>{t('pages.networkLegend')}</legend>
            {radio('cdn', t('pages.networkCdn'))}
            {radio('open', t('pages.networkOpen'))}
          </fieldset>
          {network === 'open' && <p className="pages-settings__warn">{t('pages.openWarning')}</p>}
          {network === null && !loadError && <div className="pages-settings__note">{t('common.loading')}</div>}
          {loadError && <div className="pages-settings__error" role="alert">{t('pages.settingsLoadFailed', { message: loadError })}</div>}
          {saveError && <div className="pages-settings__error" role="alert">{t('pages.saveFailed', { message: saveError })}</div>}
          <div className="pages-settings__actions">
            <button type="button" className="ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" disabled={network === null || saving}>{t('common.save')}</button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  )
}
