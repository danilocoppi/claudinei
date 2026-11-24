import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { revealInList } from '../revealInList'
import { SLASH_DESCRIPTIONS } from '../slash'

export function SlashMenu({ items, activeIndex, onPick }: {
  items: string[]
  activeIndex: number
  onPick: (cmd: string) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  // A lista tem altura máxima: a seta move o destaque e a lista acompanha. Pelo
  // conteúdo, não pelo array (que o ChatInput recria a cada render): senão
  // qualquer render puxaria de volta a lista que o usuário rolou com o mouse.
  const itemsKey = items.join('\n')
  useLayoutEffect(() => {
    const item = ref.current?.children[activeIndex]
    if (ref.current && item instanceof HTMLElement) revealInList(ref.current, item)
  }, [activeIndex, itemsKey])
  return (
    <div className="slash-menu glass" data-testid="slash-menu" ref={ref}>
      {items.map((cmd, i) => {
        const desc = SLASH_DESCRIPTIONS[cmd]
        return (
          <div
            key={cmd}
            data-testid="slash-item"
            className={`slash-item ${i === activeIndex ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(cmd) }}
          >
            <span className="slash-item__name">/{cmd}</span>
            {desc && <span className="slash-item__desc">{t(desc as any)}</span>}
          </div>
        )
      })}
    </div>
  )
}
