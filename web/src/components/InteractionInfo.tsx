import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/** Modal explicando o Board e as Tasks (colaboração entre agentes via hermes). */
export function InteractionInfo({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass interaction-info" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('interactionInfo.title')}</h3>
        <p className="interaction-info__intro">{t('interactionInfo.intro')}</p>

        <div className="interaction-info__section">
          <h4>📌 {t('interactionInfo.boardTitle')}</h4>
          <p>{t('interactionInfo.boardWhat')}</p>
          <ul>
            <li><code>post_to_board(title, content)</code> — {t('interactionInfo.boardPost')}</li>
            <li><code>read_board(limit?)</code> — {t('interactionInfo.boardRead')}</li>
          </ul>
          <p className="interaction-info__example">{t('interactionInfo.boardExample')}</p>
        </div>

        <div className="interaction-info__section">
          <h4>🗂️ {t('interactionInfo.tasksTitle')}</h4>
          <p>{t('interactionInfo.tasksWhat')}</p>
          <p className="interaction-info__flow">
            <code>queued</code> → <code>in_progress</code> → <code>completed</code> / <code>failed</code>
          </p>
          <ul>
            <li><code>dispatch_task(project, task)</code> — {t('interactionInfo.tasksDispatch')}</li>
            <li>{t('interactionInfo.tasksQueue')}</li>
            <li><code>list_tasks</code> — {t('interactionInfo.tasksList')}</li>
            <li>{t('interactionInfo.tasksTimeout')}</li>
          </ul>
          <p className="interaction-info__example">{t('interactionInfo.tasksExample')}</p>
        </div>

        <div className="interaction-info__section">
          <h4>💬 {t('interactionInfo.othersTitle')}</h4>
          <ul>
            <li><code>ask_agent(project, question)</code> — {t('interactionInfo.askAgent')}</li>
            <li><code>list_projects</code> — {t('interactionInfo.listProjects')}</li>
            <li>{t('interactionInfo.forwardTip')}</li>
          </ul>
        </div>

        <p className="interaction-info__hint">{t('interactionInfo.howToUse')}</p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose}>{t('common.ok')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
