import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchDefaultFolder, saveDefaultFolder, type DefaultFolder } from '../api'
import { FolderPicker } from './FolderPicker'

/**
 * A pasta padrão dos terminais novos, no painel de configurações. Ela é do
 * Claudinei, não de quem entrou: grava na hora — como o terminal da máquina —,
 * fora do rascunho de aparência que o Salvar confirma.
 */
export function DefaultFolderField() {
  const { t } = useTranslation()
  const [value, setValue] = useState<DefaultFolder | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void fetchDefaultFolder().then(setValue).catch(() => setValue(null)) }, [])

  const save = (path: string) => {
    setError('')
    void saveDefaultFolder(path).then(setValue).catch((e: Error) => setError(e.message))
  }

  if (!value) return null
  return (
    <>
      <div className="ap-sep" />
      <div className="ap-field">
        <span>{t('appearance.terminalsSection')}</span>
        <div className="ap-field ap-field--sub">
          <span>{t('appearance.defaultFolder')}</span>
          <div className="ap-folder">
            <code className="ap-folder__path" title={value.effective}>{value.effective}</code>
            <button type="button" className="ghost" aria-label={t('appearance.defaultFolderChoose')}
                    onClick={() => setPicking(true)}>{t('appearance.defaultFolderPick')}</button>
            {value.path && (
              <button type="button" className="ghost" onClick={() => save('')}>{t('appearance.defaultFolderReset')}</button>
            )}
          </div>
        </div>
        {value.missing && <p className="ap-error" role="alert">{t('appearance.defaultFolderMissing', { path: value.path })}</p>}
        {error && <p className="ap-error" role="alert">{t('appearance.defaultFolderSaveFailed', { error })}</p>}
        <p className="ap-hint">{t('appearance.defaultFolderHint')}</p>
      </div>
      {picking && (
        <FolderPicker initialPath={value.effective}
                      onSelect={(p) => { setPicking(false); save(p) }}
                      onClose={() => setPicking(false)} />
      )}
    </>
  )
}
