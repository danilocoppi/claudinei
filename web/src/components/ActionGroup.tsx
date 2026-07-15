import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '../types'
import { groupSummary } from '../chat/grouping'
import { MessageBlock } from './MessageBlock'

/**
 * Grupo colapsável de ações consecutivas (tool_call/thinking) — ver
 * chat/grouping.ts para as regras de formação. Recolhido mostra contagem +
 * resumo por ferramenta; expandido renderiza os cards individuais normais
 * (cada um continua expansível por conta própria).
 */
export function ActionGroup({ items, currentLocalId }: {
  items: { item: ChatItem; index: number }[]
  currentLocalId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className={`action-group${open ? ' action-group--open' : ''}`}>
      <div className="action-group__header" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span>
        <span aria-hidden="true">🧰</span>
        <strong>{t('chat.actionsGroup', { count: items.length })}</strong>
        <span className="action-group__summary">{groupSummary(items.map((x) => x.item))}</span>
      </div>
      {open && (
        <div className="action-group__body">
          {items.map(({ item, index }) => (
            <MessageBlock key={index} item={item} currentLocalId={currentLocalId} />
          ))}
        </div>
      )}
    </div>
  )
}
