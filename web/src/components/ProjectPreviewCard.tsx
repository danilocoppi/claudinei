import { useTranslation } from 'react-i18next'

export function ProjectPreviewCard({ name, icon, color }: { name: string; icon: string; color: string }) {
  const { t } = useTranslation()
  return (
    <div className="card" style={{ borderLeft: `4px solid ${color}`, cursor: 'default' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <strong style={{ flex: 1 }}>{name || t('modal.namePlaceholder')}</strong>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>{t('modal.previewTag')}</div>
    </div>
  )
}
