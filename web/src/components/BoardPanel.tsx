import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { fetchBoard } from '../api'

export function BoardPanel() {
  const { t } = useTranslation()
  const { board, projects, setBoard } = useStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    fetchBoard()
      .then(setBoard)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: 24, overflowY: 'auto' }}>
      <h2 style={{ marginTop: 0 }}>📌 {t('board.title')}</h2>
      {error && <p style={{ color: 'var(--err)' }}>{error}</p>}
      {!loading && board.length === 0 && !error && (
        <p style={{ color: 'var(--text-dim)' }}>{t('board.empty')}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {board.map((post) => {
          const project = projects.find((p) => p.id === post.projectId)
          const color = project?.color ?? 'var(--glass-bg-strong)'
          return (
            <div key={post.id} className="glass" style={{ borderRadius: 'var(--radius)', padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span
                  style={{
                    background: color, color: '#fff', borderRadius: 999, padding: '2px 10px',
                    fontSize: 12, fontWeight: 600,
                  }}
                >
                  {post.projectName}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{post.createdAt}</span>
              </div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{post.title}</div>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{post.content}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
