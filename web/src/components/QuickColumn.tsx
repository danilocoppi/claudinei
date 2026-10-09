import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { useStore } from '../store'
import { displayStatusKey, unreadOf } from '../engineSession'
import { quickColumnItems } from '../quickColumn'
import { AgentFace, faceStateOf } from './AgentFace'
import { Icon } from './Icon'
import { Sonar } from './Sonar'

/**
 * A coluna de rostinhos ao lado da lista: atalho para os terminais ligados, com
 * quem pede ação no topo e depois o que você mexeu por último (ver quickColumnItems).
 *
 * Fica parada enquanto a lista rola e tem rolagem própria (CSS `.quick-col`). A
 * busca e os filtros não chegam aqui: `projects` é a lista inteira, na ordem dela.
 * Cada linha reaproveita o desenho da régua — rosto com o ícone no canto, contador
 * e sonar —, e o clique abre como o cartão.
 */
export function QuickColumn({ projects }: { projects: Project[] }) {
  const { t } = useTranslation()
  const { sessions, unread, activeLocalId, view, openSession, openTerminal } = useStore(useShallow((s) => ({
    sessions: s.sessions, unread: s.unread, activeLocalId: s.activeLocalId, view: s.view,
    openSession: s.openSession, openTerminal: s.openTerminal,
  })))
  const items = quickColumnItems(projects, sessions)
  if (items.length === 0) return null
  const openProjectId = (view === 'chat' || view === 'terminal') && activeLocalId ? sessions[activeLocalId]?.projectId : undefined

  return (
    <nav className="quick-col" aria-label={t('sidebar.quickColumn')}>
      {items.map(({ project, session, waiting }) => {
        const label = `${project.name} — ${t(`status.${displayStatusKey(session)}` as 'status.in_terminal')}`
        const badge = unreadOf(project.id, sessions, unread)
        const active = openProjectId === project.id
        return (
          <button key={project.id} type="button" title={label} aria-label={label}
                  aria-current={active ? 'true' : undefined}
                  className={`quick-col__item ${active ? 'active' : ''}`}
                  onClick={() => (session.status === 'in_terminal' ? openTerminal(session.localId) : openSession(session.localId))}>
            {waiting && <Sonar />}
            <span className="rail-mark">
              <AgentFace state={faceStateOf(session)} size={20} />
              <Icon className="rail-ico" value={project.icon} size={10} />
            </span>
            {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        )
      })}
    </nav>
  )
}
