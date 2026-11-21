import { useTranslation } from 'react-i18next'
import type { ChatItem } from '../types'
import { useFold } from '../chat/folds'

/**
 * O pacote de contexto da troca de motor (⇄), no destino: "Contexto trazido do
 * <Motor>: N mensagens (~T mil tokens)", dobrado por padrão (é bastidor, e pode
 * ter 64 mil caracteres). Aberto, o corpo vai cru num `<pre>`, sem animação. O
 * pedido do operador que foi junto aparece abaixo, como texto dele.
 */
export function HandoffCard({ item, currentLocalId }: {
  item: Extract<ChatItem, { kind: 'claudinei_message'; reason: 'handoff' }>
  currentLocalId?: string
}) {
  const { t } = useTranslation()
  // A dobra mora no store (a lista é virtual: o bloco desmonta fora da tela).
  const [open, setOpen] = useFold(currentLocalId, item.key, 'summary')
  const toggle = () => setOpen(!open)
  // "~16 mil tokens" para 15800; nunca "~0".
  const k = Math.max(1, Math.round(item.tokens / 1000))
  return (
    <div>
      <div className={`action-group handoff-card${open ? ' action-group--open' : ''}`} role="note">
        <div
          className="action-group__header"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span aria-hidden="true">⇄</span>
          <strong>{t('branch.handoff.card', { engine: item.engineLabel, count: item.messages, k })}</strong>
        </div>
        {open && <pre className="action-group__body handoff-card__body">{item.text}</pre>}
      </div>
      {item.request && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0' }}>
          <div style={{ maxWidth: '70%' }}>
            <div className="msg-bubble handoff-card__request">{item.request}</div>
          </div>
        </div>
      )}
    </div>
  )
}
