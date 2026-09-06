import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { isBackgroundAgent, type BackgroundTask } from '../../../shared/background-tasks'

/** Processos que continuam ligados quando o agente termina sua resposta. */
export function BackgroundProcesses({ tasks = [], onStopTask }: {
  tasks?: BackgroundTask[]
  onStopTask: (taskId: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const stop = async (taskId: string) => {
    setPending(taskId)
    setError('')
    try { await onStopTask(taskId) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setPending(null) }
  }
  const processes = tasks.filter((task) => !task.ambient && !isBackgroundAgent(task))
  if (!processes.length) return null
  return (
    <details className="background-processes" data-testid="background-processes">
      <summary>{t('chat.backgroundProcesses', { count: processes.length })}</summary>
      <ul>
        {processes.map((task) => (
          <li key={task.id}>
            <span>{task.description || task.id}</span>
            {task.taskType === 'local_bash' && <code>Shell</code>}
            <button type="button" className="ghost" disabled={pending !== null} onClick={() => { void stop(task.id) }}
              aria-label={t('chat.stopSubagent', { name: task.description || task.id })}>
              {t('chat.stopBackgroundProcess')}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </details>
  )
}
