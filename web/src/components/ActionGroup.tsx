import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '../types'
import { groupSummary } from '../chat/grouping'
import { useGroupFold } from '../chat/folds'
import { useStore } from '../store'
import { MessageBlock } from './MessageBlock'

/**
 * Grupo colapsável de ações consecutivas (tool_call/thinking) — ver
 * chat/grouping.ts para as regras de formação. Recolhido mostra contagem +
 * resumo por ferramenta; expandido renderiza os cards individuais normais
 * (cada um continua expansível por conta própria).
 *
 * A dobra do grupo é aberta na chave do 1º item, mas vale a de qualquer
 * membro (`useGroupFold`): o 1º item muda quando a página antiga junta ações
 * no topo do grupo.
 */
export const ActionGroup = memo(function ActionGroup({ items, currentLocalId }: {
  items: { item: ChatItem; index: number }[]
  currentLocalId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useGroupFold(currentLocalId, items.map((x) => x.item.key))
  // A ocorrência atual da busca está neste grupo: a marca fica no cabeçalho
  // também, para quem o recolher depois de chegar ainda ver onde ela está. O
  // item em si leva o `chat-hit` (MessageBlock).
  const currentKey = useStore((s) => s.find?.currentKey ?? null)
  const hasHit = currentKey !== null && items.some((x) => x.item.key === currentKey)
  return (
    <div className={`action-group${open ? ' action-group--open' : ''}${hasHit ? ' action-group--hit' : ''}`}>
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
})
