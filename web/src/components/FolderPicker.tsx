import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchDir, type DirListing } from '../api'

export function FolderPicker({ initialPath, onSelect, onClose }: {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState('')

  const load = (path?: string) => {
    fetchDir(path)
      .then((l) => { setListing(l); setError('') })
      .catch((e) => setError((e as Error).message))
  }

  useEffect(() => { load(initialPath) }, [])

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass" style={{ width: 520, maxHeight: '70vh', borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', cursor: 'default' }}
           onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('folder.title')}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <button className="ghost" disabled={!listing?.parent} onClick={() => listing?.parent && load(listing.parent)}>⬆ {t('folder.up')}</button>
          <span style={{ fontFamily: 'ui-monospace, monospace, "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"', fontSize: 13, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {listing?.path ?? '…'}
          </span>
        </div>
        {error && <div style={{ color: 'var(--err)', marginBottom: 8 }}>{error}</div>}
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--glass-border)', borderRadius: 10 }}>
          {listing?.entries.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)' }}>{t('folder.empty')}</div>}
          {listing?.entries.map((e) => (
            <div key={e.path} onClick={() => load(e.path)}
                 style={{ padding: '9px 12px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
                 onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--glass-bg-strong)')}
                 onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}>
              <span>📁</span><span>{e.name}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!listing} onClick={() => listing && onSelect(listing.path)}>{t('folder.select')}</button>
        </div>
      </div>
    </div>
  )
}
