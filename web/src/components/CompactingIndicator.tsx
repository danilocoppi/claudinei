import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Compactação em curso, no lugar dos três pontinhos. Veste a mesma linha do
 * resumo que vai aparecer quando terminar ("Contexto compactado"), para o
 * operador ligar uma coisa à outra — mas viva: anel girando e o relógio
 * correndo, como o "Compacting conversation…" do terminal. Não há porcentagem
 * em lugar nenhum (é uma chamada só ao modelo), então só estado e tempo.
 */
export function CompactingIndicator({ since }: { since: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="action-group compact-summary compacting" role="status" aria-live="polite" data-testid="compacting-indicator">
      <div className="action-group__header">
        <span className="compacting__spinner" aria-hidden="true" />
        <span aria-hidden="true">🗜️</span>
        <strong>{t('chat.compacting')}</strong>
        <span className="action-group__summary">{t('chat.compactingElapsed', { s })}</span>
      </div>
    </div>
  )
}
