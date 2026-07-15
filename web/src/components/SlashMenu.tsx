import { useTranslation } from 'react-i18next'
import { SLASH_DESCRIPTIONS } from '../slash'

export function SlashMenu({ items, activeIndex, onPick }: {
  items: string[]
  activeIndex: number
  onPick: (cmd: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="slash-menu glass" data-testid="slash-menu">
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
