import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDialogKeys } from '../components/undo/useDialogKeys'
import type { LocalServer } from './api'
import { serversSummary } from './serversOnStop'

/**
 * "Este terminal deixou N servidores no ar (…). Parar também?" — a pergunta
 * antes de encerrar a sessão de um terminal (`end`) ou de excluir o terminal
 * (`delete`). Três saídas: parar e seguir, só seguir, ou Cancelar (nada
 * acontece). O foco entra no diálogo, o Tab fica preso nele e o Esc é o
 * Cancelar, como nos diálogos do desfazer. Com `busy` (os Parar a caminho, até
 * ~5 s), os botões travam e o Esc e o clique fora não fecham.
 */
export function StopServersDialog({ servers, mode, busy = false, onChoose, onCancel }: {
  servers: LocalServer[]
  mode: 'end' | 'delete'
  busy?: boolean
  /** `true`: parar os servidores e então seguir; `false`: só seguir. */
  onChoose(stop: boolean): void
  onCancel(): void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const textId = useId()
  const cancel = () => { if (!busy) onCancel() }
  const onKeyDown = useDialogKeys(ref, cancel)
  const stopLabel = mode === 'end' ? t('localServers.stopAndEnd') : t('localServers.stopAndDelete')
  const onlyLabel = mode === 'end' ? t('localServers.onlyEnd') : t('localServers.onlyDelete')

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); cancel() } }}>
      <div ref={ref} className="glass" role="dialog" aria-modal="true" aria-labelledby={textId} tabIndex={-1}
           onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}
           style={{ width: 420, maxWidth: 'calc(100vw - 32px)', borderRadius: 16, padding: 20, cursor: 'default' }}>
        <p id={textId} style={{ marginTop: 0, overflowWrap: 'anywhere' }}>
          {t('localServers.ask', { count: servers.length, list: serversSummary(servers) })}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
          <button type="button" className="ghost" disabled={busy} onClick={cancel}>{t('common.cancel')}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => onChoose(false)}>{onlyLabel}</button>
          <button type="button" style={{ background: 'linear-gradient(135deg,#ff6b8b,#c0563b)' }} disabled={busy}
                  onClick={() => onChoose(true)}>{busy ? t('localServers.stopping') : stopLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
