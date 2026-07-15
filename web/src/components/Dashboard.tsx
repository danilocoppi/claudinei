import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { primarySessionOf } from '../engineSession'
import { ProjectCard } from './ProjectCard'

export function Dashboard() {
  const { t } = useTranslation()
  const { projects, sessions, unread } = useStore()

  // Mesma regra da sidebar: a sessão de maior prioridade de status representa o
  // projeto (1 Claude idle + 1 Codex working → o card mostra working).
  const sessionOf = (projectId: number) => primarySessionOf(projectId, sessions)

  return (
    <div style={{ padding: 24, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{t('dashboard.projects')}</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {projects.map((p) => {
          const session = sessionOf(p.id)
          return <ProjectCard key={p.id} project={p} session={session} unread={session ? (unread[session.localId] ?? 0) : 0} />
        })}
      </div>
      {projects.length === 0 && <p style={{ color: 'var(--text-dim)' }}>{t('dashboard.empty')}</p>}
    </div>
  )
}
