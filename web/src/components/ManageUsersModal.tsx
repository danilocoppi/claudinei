import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { createUser, deleteUser, fetchUsers, revokeAllSessions, updateUser, type AdminUser } from '../api'
import { ConfirmDialog } from './ConfirmDialog'

interface Draft { id?: number; username: string; password: string; isAdmin: boolean; projectIds: number[] }
const EMPTY: Draft = { username: '', password: '', isAdmin: false, projectIds: [] }

export function ManageUsersModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const projects = useStore((s) => s.projects)
  const setAuth = useStore((s) => s.setAuth)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null)
  const [error, setError] = useState('')

  const reload = () => fetchUsers().then(setUsers).catch((e) => setError((e as Error).message))
  useEffect(() => { void reload() }, [])

  const save = async () => {
    if (!draft) return
    setError('')
    try {
      if (draft.id) {
        await updateUser(draft.id, {
          ...(draft.password ? { password: draft.password } : {}),
          isAdmin: draft.isAdmin,
          projectIds: draft.projectIds,
        })
      } else {
        await createUser(draft)
      }
      setDraft(null)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const toggleProject = (pid: number) =>
    setDraft((d) => d && ({ ...d, projectIds: d.projectIds.includes(pid) ? d.projectIds.filter((x) => x !== pid) : [...d.projectIds, pid] }))
  const selectAllProjects = () => setDraft((d) => d && ({ ...d, projectIds: projects.map((p) => p.id) }))
  const selectNoProjects = () => setDraft((d) => d && ({ ...d, projectIds: [] }))

  // Portal: mesma razão do NewProjectModal/ConfirmDialog — a .sidebar tem
  // backdrop-filter, que vira containing block e prenderia o overlay nela.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass" style={{ width: 480, maxWidth: 'calc(100vw - 32px)', maxHeight: '82vh', overflowY: 'auto', borderRadius: 16, padding: 20, cursor: 'default' }}
           onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('auth.manageUsers')}</h3>

        <ul className="users-list">
          {users.map((u) => (
            <li key={u.id}>
              <span className="users-list__name">{u.username}</span>
              {u.isAdmin
                ? <span className="users-list__badge">{t('auth.adminBadge')}</span>
                : <span className="users-list__projects">
                    {u.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? `#${id}`).join(', ') || t('auth.noTerminals')}
                  </span>}
              <span className="users-list__actions">
                <button className="ghost" onClick={() => setDraft({ id: u.id, username: u.username, password: '', isAdmin: u.isAdmin, projectIds: u.projectIds })}>{t('common.edit')}</button>
                <button className="ghost" onClick={() => setConfirmDelete(u)}>{t('common.delete')}</button>
              </span>
            </li>
          ))}
        </ul>

        {draft ? (
          <div className="users-form">
            {!draft.id && (
              <label>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{t('auth.username')}</div>
                <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoFocus />
              </label>
            )}
            <label>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
                {draft.id ? t('auth.newPasswordOptional') : t('auth.password')}
              </div>
              <input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </label>
            <label className="users-form__check">
              <input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft({ ...draft, isAdmin: e.target.checked })} />
              {t('auth.adminBadge')}
            </label>
            {!draft.isAdmin && (
              <div className="perm">
                <div className="perm__head">
                  <span className="perm__label">{t('auth.allowedTerminals')}</span>
                  {projects.length > 0 && (
                    <span className="perm__meta">
                      <span className="perm__count">{t('auth.selectedOf', { n: draft.projectIds.length, total: projects.length })}</span>
                      <button type="button" className="perm__quick" onClick={selectAllProjects}>{t('auth.selectAll')}</button>
                      <button type="button" className="perm__quick" onClick={selectNoProjects}>{t('auth.selectNone')}</button>
                    </span>
                  )}
                </div>
                {projects.length === 0 ? (
                  <div className="perm__empty">{t('auth.noTerminalsToGrant')}</div>
                ) : (
                  <div className="perm__list">
                    {projects.map((p) => {
                      const on = draft.projectIds.includes(p.id)
                      return (
                        <button
                          type="button"
                          key={p.id}
                          className={`perm__row${on ? ' is-on' : ''}`}
                          style={{ ['--pc' as string]: p.color }}
                          aria-pressed={on}
                          onClick={() => toggleProject(p.id)}
                        >
                          <span className="perm__bar" aria-hidden />
                          <span className="perm__icon" aria-hidden>{p.icon}</span>
                          <span className="perm__name">{p.name}</span>
                          <span className="perm__check" aria-hidden>{on ? '✓' : ''}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
                {projects.length > 0 && draft.projectIds.length === 0 && (
                  <div className="perm__hint">{t('auth.noneSelectedHint')}</div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="ghost" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button onClick={() => void save()} disabled={!draft.id && (!draft.username || !draft.password)}>{t('common.save')}</button>
            </div>
          </div>
        ) : (
          <button className="ghost users-add" onClick={() => setDraft(EMPTY)}>{t('auth.addUser')}</button>
        )}

        {error && <div style={{ color: 'var(--err)', marginTop: 10 }}>{error}</div>}

        <div className="modal__actions--split">
          <button className="users-revoke ghost" onClick={() => setConfirmRevoke(true)}>{t('auth.revokeAll')}</button>
        </div>
      </div>

      {confirmRevoke && (
        <ConfirmDialog
          title={t('auth.revokeAll')}
          message={t('auth.revokeAllConfirm')}
          confirmLabel={t('common.ok')}
          onConfirm={() => { void revokeAllSessions().catch(() => {}).finally(() => setAuth('login', null)) }}
          onClose={() => setConfirmRevoke(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('auth.deleteUser', { name: confirmDelete.username })}
          message={t('auth.deleteUserConfirm')}
          confirmLabel={t('common.delete')}
          onConfirm={() => {
            const target = confirmDelete
            void deleteUser(target.id)
              .catch((e) => setError((e as Error).message))
              .finally(() => { setConfirmDelete(null); void reload() })
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>,
    document.body,
  )
}
