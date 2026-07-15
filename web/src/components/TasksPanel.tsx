import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '../store'
import { fetchTasks } from '../api'
import { EngineIcon } from './EngineIcon'

function statusLabel(t: TFunction, status: string): string {
  if (status === 'queued') return t('tasks.queued')
  if (status === 'in_progress') return t('tasks.inProgress')
  if (status === 'completed') return t('tasks.completed')
  if (status === 'failed') return t('tasks.failed')
  return status
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation()
  const label = statusLabel(t, status)
  const color =
    status === 'completed' ? 'var(--ok)'
    : status === 'failed' ? 'var(--err)'
    : status === 'queued' ? 'var(--text-dim)'
    : 'var(--accent)'
  return (
    <span
      style={{
        background: color, color: '#fff', borderRadius: 999, padding: '2px 10px',
        fontSize: 12, fontWeight: 600,
        animation: status === 'in_progress' ? 'pulse 1.2s infinite' : undefined,
      }}
    >
      {label}
    </span>
  )
}

export function TasksPanel() {
  const { t } = useTranslation()
  const { tasks, setTasks } = useStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    fetchTasks()
      .then(setTasks)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: 24, overflowY: 'auto' }}>
      <h2 style={{ marginTop: 0 }}>🗂️ {t('tasks.title')}</h2>
      {error && <p style={{ color: 'var(--err)' }}>{error}</p>}
      {!loading && tasks.length === 0 && !error && (
        <p style={{ color: 'var(--text-dim)' }}>
          {t('tasks.empty')}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {tasks.map((task) => (
          <div key={task.id} className="glass" style={{ borderRadius: 'var(--radius)', padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <StatusChip status={task.status} />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{task.createdAt}</span>
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span>{task.fromProjectName ?? t('tasks.operator')}</span>
              <EngineTag id={task.fromEngine} />
              <span>→</span>
              <span>{task.toProjectName}</span>
              <EngineTag id={task.toEngine} />
            </div>
            <div style={{ color: 'var(--text)' }}>{task.description}</div>
            {task.result && (
              <div
                style={{
                  marginTop: 8, padding: '8px 10px', borderRadius: 10,
                  background: 'rgba(0,0,0,.18)', border: '1px solid var(--glass-border)',
                  color: 'var(--text-dim)', fontSize: 13, whiteSpace: 'pre-wrap',
                }}
              >
                {task.result}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Chip da engine (ícone + rótulo) ao lado do nome do projeto na task — entre
 * engines do MESMO projeto ("Vaexa → Vaexa") é o que diz quem mandou pra quem. */
function EngineTag({ id }: { id?: string | null }) {
  const engines = useStore((s) => s.engines)
  if (!id) return null
  const meta = engines.find((e) => e.id === id)
  return (
    <span className="task-engine" title={meta?.label ?? id}>
      {meta?.icon && <EngineIcon icon={meta.icon} />}
      {meta?.label ?? id}
    </span>
  )
}
