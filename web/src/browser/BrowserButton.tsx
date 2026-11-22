import { useTranslation } from 'react-i18next'
import { useShortcutLabel } from '../shortcuts/active'
import { toggleBrowserView, useEffectiveView } from './columnStore'

type Props = { projectId: number; engine: string }

/**
 * O botão Navegador do cabeçalho do chat: a mesma ação do Alt+B
 * (`toggleBrowserView`). Aceso com a vista Navegador à mostra. Estático (sem GPU).
 */
export function BrowserButton({ projectId, engine }: Props) {
  const { t } = useTranslation()
  const on = useEffectiveView(projectId, engine) === 'browser'
  const combo = useShortcutLabel('view.browser')
  const title = combo === null ? t('browser.open') : t('browser.openTitle', { combo })
  return (
    <button type="button" className="ghost browser-btn" aria-label={t('browser.open')} aria-pressed={on}
            title={title} onClick={() => { void toggleBrowserView(projectId, engine) }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M7 6.5h.01" /><path d="M10 6.5h.01" />
      </svg>
      <span className="btn-label">{t('browser.open')}</span>
    </button>
  )
}
