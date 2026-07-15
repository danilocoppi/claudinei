import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Project, SessionInfo } from '../types'
import { deleteProject, fetchProjects } from '../api'
import { useStore } from '../store'
import { startOrReviveEngine } from '../engineSession'
import { StartSessionModal } from './StartSessionModal'
import { ConfirmDialog } from './ConfirmDialog'
import { EnginePickerMenu } from './EnginePickerMenu'

export function ProjectCard({ project, session, unread }: {
  project: Project
  session?: SessionInfo
  unread: number
}) {
  const { t } = useTranslation()
  const openSession = useStore((s) => s.openSession)
  const setProjects = useStore((s) => s.setProjects)
  const engines = useStore((s) => s.engines)
  const [showStart, setShowStart] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [reviveMenu, setReviveMenu] = useState<{ x: number; y: number } | null>(null)

  const canOpen = session && session.status !== 'stopped'

  const onDelete = async () => {
    try {
      await deleteProject(project.id)
      setProjects(await fetchProjects())
      setShowDelete(false)
    } catch (err) {
      setDeleteError((err as Error).message)
    }
  }

  return (
    <div className="card" style={{ borderLeft: `4px solid ${project.color}` }}
         onClick={() => canOpen && openSession(session.localId)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22 }}>{project.icon}</span>
        <strong style={{ flex: 1 }}>{project.name}</strong>
        {unread > 0 && <span className="badge">{unread}</span>}
        <button
          className="ghost"
          title={t('projectCard.deleteTitle')}
          onClick={(e) => { e.stopPropagation(); setDeleteError(''); setShowDelete(true) }}
        >
          🗑
        </button>
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)' }}>
        {session ? (
          <>
            <span className={`status-dot status-${session.status}`} />
            <span>{t(`status.${session.status}` as const)}</span>
            {(session.status === 'dead' || session.status === 'stopped') && (
              <button className="ghost" onClick={(e) => {
                e.stopPropagation()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setReviveMenu({ x: r.left, y: r.bottom + 4 })
              }}>
                {t('projectCard.revive')}
              </button>
            )}
          </>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); setShowStart(true) }}>{t('projectCard.startSession')}</button>
        )}
      </div>
      {session?.status === 'dead' && session.detail && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--err)' }}>
          {session.detail.slice(0, 140)}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>{project.path}</div>
      {showStart && <StartSessionModal project={project} onClose={() => setShowStart(false)} />}
      {reviveMenu && session && (
        <EnginePickerMenu
          engines={engines}
          x={reviveMenu.x}
          y={reviveMenu.y}
          onClose={() => setReviveMenu(null)}
          onPick={(engineId) => {
            setReviveMenu(null)
            void startOrReviveEngine(project.id, engineId, useStore.getState().sessions)
              .then((localId) => openSession(localId))
              .catch(() => {})
          }}
        />
      )}
      {showDelete && (
        <ConfirmDialog
          title={t('confirm.deleteTitle', { name: project.name })}
          message={t('confirm.deleteMsg')}
          confirmLabel={t('common.delete')}
          error={deleteError}
          onConfirm={onDelete}
          onClose={() => setShowDelete(false)}
        />
      )}
    </div>
  )
}
