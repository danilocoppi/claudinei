import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../clipboard'

/** Botão de copiar conteúdo (áreas de comando/resultado das tools): um clique
 * copia o texto cru pro clipboard e mostra o ✓ por um instante. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' copied' : ''}${className ? ' ' + className : ''}`}
      title={copied ? t('common.copied') : t('common.copy')}
      aria-label={t('common.copy')}
      onClick={(e) => {
        e.stopPropagation()
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  )
}
