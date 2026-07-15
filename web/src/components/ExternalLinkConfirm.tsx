import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { ConfirmDialog } from './ConfirmDialog'

/** Confirmação de segurança antes de abrir um link EXTERNO (clicado no chat ou no
 * visualizador de arquivos). Montado uma vez no App; inerte sem link pendente. */
export function ExternalLinkConfirm() {
  const { t } = useTranslation()
  const url = useStore((s) => s.externalLink)
  const close = useStore((s) => s.closeExternalLink)
  if (!url) return null
  return (
    <ConfirmDialog
      title={t('externalLink.title')}
      message={t('externalLink.message', { url })}
      confirmLabel={t('externalLink.open')}
      onConfirm={() => {
        window.open(url, '_blank', 'noopener,noreferrer')
        close()
      }}
      onClose={close}
    />
  )
}
