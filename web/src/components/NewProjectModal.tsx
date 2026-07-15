import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { createProject, updateProject, fetchProjects } from '../api'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { EmojiPicker } from './EmojiPicker'
import { ColorField } from './ColorField'
import { ProjectPreviewCard } from './ProjectPreviewCard'

export function NewProjectModal({ onClose, editProject }: { onClose: () => void; editProject?: Project }) {
  const { t } = useTranslation()
  const setProjects = useStore((s) => s.setProjects)
  const [name, setName] = useState(editProject?.name ?? '')
  const [path, setPath] = useState(editProject?.path ?? '')
  const [icon, setIcon] = useState(editProject?.icon ?? '📁')
  const [color, setColor] = useState(editProject?.color ?? '#7c5cff')
  const [error, setError] = useState('')
  const [showFolder, setShowFolder] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)

  const submit = async () => {
    try {
      if (editProject) await updateProject(editProject.id, { name, icon, color })
      else await createProject({ name, path, icon, color })
      setProjects(await fetchProjects())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Portal: a .sidebar tem backdrop-filter (vira containing block de
  // position:fixed) — sem portal o overlay fica preso dentro dela.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass" style={{ width: 460, borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{editProject ? t('modal.editTerminal') : t('modal.newProject')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input placeholder={t('modal.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />

          {editProject ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '8px 2px' }}>📁 <span>{path}</span></div>
          ) : (
            <button className="ghost" style={{ textAlign: 'left' }} onClick={() => setShowFolder(true)}>
              {path ? <>📁 <span>{path}</span></> : t('modal.choosePath')}
            </button>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="ghost" onClick={() => setShowEmoji(true)} style={{ fontSize: 20, width: 48 }}>{icon}</button>
            <ColorField value={color} onChange={setColor} />
          </div>

          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{t('common.preview')}</div>
            <ProjectPreviewCard name={name} icon={icon} color={color} />
          </div>

          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button disabled={!name || !path} onClick={submit}>{editProject ? t('common.save') : t('common.create')}</button>
          </div>
        </div>
      </div>

      {showFolder && (
        <FolderPicker
          onSelect={(p) => { setPath(p); setShowFolder(false) }}
          onClose={() => setShowFolder(false)}
        />
      )}
      {showEmoji && (
        <EmojiPicker onSelect={(e) => setIcon(e)} onClose={() => setShowEmoji(false)} />
      )}
    </div>,
    document.body,
  )
}
