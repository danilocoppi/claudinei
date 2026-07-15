import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { EngineMeta } from '../types'
import { EngineIcon } from './EngineIcon'

/**
 * Popover "qual engine?" usado onde Reviver antes reanimava direto a última
 * engine (Sidebar term-card, ProjectCard) — 1 Claude + 1 Codex podem coexistir
 * por projeto, então reviver precisa perguntar qual das duas. Visual: mesmo
 * padrão do menu de opções da Sidebar (`.sess-pop`).
 */
export function EnginePickerMenu({ engines, x, y, onPick, onClose }: {
  engines: EngineMeta[]
  x: number
  y: number
  onPick: (engineId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return createPortal(
    <div className="sess-pop__overlay" onClick={onClose}>
      <div className="sess-pop glass" style={{ left: x, top: y, minWidth: 170 }} onClick={(e) => e.stopPropagation()}>
        <div className="sess-pop__eyebrow">{t('session.engine')}</div>
        {engines.map((e) => {
          const missing = e.available === false
          return (
            <div
              key={e.id}
              className={`sess-pop__item${missing ? ' sess-pop__item--disabled' : ''}`}
              title={missing ? `${t('chat.engineNotInstalledHint')}${e.installHint ? ` — ${e.installHint}` : ''}` : undefined}
              onClick={missing ? undefined : () => onPick(e.id)}
            >
              <EngineIcon icon={e.icon} /><span>{e.label}</span>
              {missing && <span className="engine-picker__missing">{t('chat.engineNotInstalled')}</span>}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
