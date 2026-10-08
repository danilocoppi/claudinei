import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deleteProject, fetchProjects, type OpenSession } from '../api'
import { displayStatusKey } from '../engineSession'
import { useStore } from '../store'
import type { Project, SessionInfo } from '../types'
import { ConfirmDialog } from './ConfirmDialog'

/** Estados com processo de pé — os mesmos que o servidor recusa ao excluir. */
const OPEN = new Set<SessionInfo['status']>(['starting', 'idle', 'working', 'needs_attention', 'in_terminal'])

/**
 * Excluir um terminal. Com sessões abertas, lista cada uma e só libera o botão
 * depois do "estou ciente"; o servidor então finaliza todas antes de remover.
 *
 * A lista nasce do navegador. Se o servidor souber de uma sessão que abriu
 * depois, a lista dele passa a valer e a ciência é pedida de novo — nada é
 * finalizado sem o operador ter visto o que será finalizado.
 */
export function DeleteProjectDialog({ project, onDeleted, onClose }: {
  project: Project
  onDeleted: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const sessions = useStore((s) => s.sessions)
  const engines = useStore((s) => s.engines)
  const setProjects = useStore((s) => s.setProjects)
  const [fromServer, setFromServer] = useState<OpenSession[] | null>(null)
  const [aware, setAware] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const open: OpenSession[] = fromServer
    ?? Object.values(sessions).filter((s) => s.projectId === project.id && OPEN.has(s.status))
  // A sessão do navegador sabe mais (pergunta pendente, atividade no terminal).
  const describe = (s: OpenSession) => {
    const engine = engines.find((e) => e.id === s.engine)?.label ?? s.engine
    return `${engine} — ${t(`status.${displayStatusKey(sessions[s.localId] ?? (s as SessionInfo))}` as 'status.in_terminal')}`
  }

  const confirm = async () => {
    if (busy) return
    const stopSessions = open.length > 0
    setBusy(true)
    setError('')
    try {
      await deleteProject(project.id, { stopSessions })
      setProjects(await fetchProjects())
      onDeleted()
    } catch (err) {
      const e = err as Error & { status?: number; sessions?: OpenSession[] }
      if (e.status === 409 && e.sessions?.length) {
        setFromServer(e.sessions)
        if (!stopSessions) {
          // O navegador não sabia dessa sessão: o operador ainda não a viu.
          setAware(false)
          setError(t('confirm.deleteSessionsChanged'))
        } else setError(e.message)
      } else setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title={t('confirm.deleteTitle', { name: project.name })}
      message={t('confirm.deleteMsg')}
      confirmLabel={busy && open.length > 0 ? t('confirm.deleteStopping') : t('common.delete')}
      confirmDisabled={busy || (open.length > 0 && !aware)}
      error={error}
      onConfirm={() => void confirm()}
      onClose={() => { if (!busy) onClose() }}
    >
      {open.length > 0 && (
        <div className="delete-sessions">
          <p className="delete-sessions__intro">{t('confirm.deleteOpenSessions', { count: open.length })}</p>
          <ul className="delete-sessions__list">
            {open.map((s) => <li key={s.localId}>{describe(s)}</li>)}
          </ul>
          <label className="delete-sessions__ack">
            <input type="checkbox" checked={aware} disabled={busy} onChange={(e) => setAware(e.target.checked)} />
            <span>{t('confirm.deleteAck', { count: open.length })}</span>
          </label>
        </div>
      )}
    </ConfirmDialog>
  )
}
