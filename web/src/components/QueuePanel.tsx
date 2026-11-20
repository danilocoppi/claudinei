import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  editQueueItem, pauseQueue, removeQueueItem, reorderQueue, resumeQueue, sendQueueItemNow,
} from '../api'
import { progressKey, useStore } from '../store'
import { useQueueSync } from '../useQueueSync'
import { queueHeld } from '../queueHold'
import type { OperatorQueue, QueueItem } from '../types'

/** A linha do item: a primeira linha com texto (o resto aparece no title e no editor). */
const firstLine = (text: string) => text.trim().split('\n')[0]
/** O title de um item enorme não precisa do texto inteiro (até 120 000 bytes). */
const TITLE_MAX = 600

/**
 * Fila do operador do terminal (projeto + motor), logo acima do campo do chat:
 * as mensagens que esperam o próximo turno, uma por linha, com editar, subir,
 * descer, remover e "enviar agora". O cabeçalho diz se a fila está pausada (e
 * por quê, com o Retomar) ou segurando por um aviso aberto acima.
 *
 * Fila vazia e sem pausa não desenha nada. Fica fora da moldura que o Zen
 * esconde, para continuar à vista no modo. Estático de propósito: a interface
 * precisa andar sem GPU (AGENTS.md).
 */
export function QueuePanel({ projectId, engine }: { projectId: number; engine: string }) {
  const { t } = useTranslation()
  useQueueSync(projectId, engine)
  const key = progressKey(projectId, engine)
  const queue = useStore((s) => s.queues[key])
  // Boolean: o seletor não re-renderiza o painel a cada mudança do estado do terminal.
  const held = useStore((s) => queueHeld(s.terminalStates[key]))
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!queue || (queue.items.length === 0 && !queue.paused)) return null

  /** Chama a API e aplica a fila devolvida na hora, sem esperar o WebSocket. */
  const call = async (fn: () => Promise<OperatorQueue>): Promise<boolean> => {
    setError(null)
    try {
      const q = await fn()
      useStore.getState().setQueue({ ...q, projectId, engine })
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    }
  }

  const ids = queue.items.map((i) => i.id)
  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    ;[next[index], next[to]] = [next[to], next[index]]
    void call(() => reorderQueue(projectId, engine, next))
  }
  const save = async () => {
    if (!editing) return
    const { id, text } = editing
    if (await call(() => editQueueItem(projectId, engine, id, text))) {
      setEditing((e) => (e?.id === id ? null : e))
    }
  }

  const reason = queue.pauseReason ?? 'manual'
  const row = (item: QueueItem, index: number) => {
    if (editing?.id === item.id) {
      return (
        <li key={item.id} className="queue-panel__item queue-panel__item--editing">
          <textarea
            className="queue-panel__editor"
            aria-label={t('queue.editLabel')}
            autoFocus
            rows={3}
            value={editing.text}
            onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Escape') { e.preventDefault(); setEditing(null); return }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save() }
            }}
          />
          <div className="queue-panel__actions">
            <button type="button" onClick={() => void save()}>{t('queue.save')}</button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>{t('queue.cancel')}</button>
          </div>
        </li>
      )
    }
    return (
      <li key={item.id} className="queue-panel__item">
        <span className="queue-panel__text" title={item.text.slice(0, TITLE_MAX)}>{firstLine(item.text)}</span>
        <div className="queue-panel__actions">
          <button type="button" className="ghost queue-panel__icon" aria-label={t('queue.edit')} title={t('queue.edit')}
                  onClick={() => setEditing({ id: item.id, text: item.text })}>✎</button>
          <button type="button" className="ghost queue-panel__icon" aria-label={t('queue.up')} title={t('queue.up')}
                  disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="ghost queue-panel__icon" aria-label={t('queue.down')} title={t('queue.down')}
                  disabled={index === ids.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="ghost queue-panel__icon" aria-label={t('queue.remove')} title={t('queue.remove')}
                  onClick={() => void call(() => removeQueueItem(projectId, engine, item.id))}>×</button>
          <button type="button" className="ghost queue-panel__send"
                  onClick={() => void call(() => sendQueueItemNow(projectId, engine, item.id))}>{t('queue.sendNow')}</button>
        </div>
      </li>
    )
  }

  return (
    <section className={`queue-panel${queue.paused ? ' queue-panel--paused' : ''}`} data-testid="queue-panel" aria-label={t('queue.region')}>
      <div className="queue-panel__head">
        <span className="queue-panel__title">{t('queue.count', { count: queue.items.length })}</span>
        {queue.paused && <span className="queue-panel__status">{t('queue.paused', { reason: t(`queue.reason.${reason}`) })}</span>}
        {held && <span className="queue-panel__status queue-panel__status--held" role="status">{t('queue.held')}</span>}
        <span className="queue-panel__spacer" />
        {queue.paused
          ? <button type="button" onClick={() => void call(() => resumeQueue(projectId, engine))}>{t('queue.resume')}</button>
          : <button type="button" className="ghost" onClick={() => void call(() => pauseQueue(projectId, engine))}>{t('queue.pause')}</button>}
      </div>
      {queue.items.length > 0 && <ol className="queue-panel__list">{queue.items.map(row)}</ol>}
      {error && <div className="queue-panel__error">⚠ {error}</div>}
    </section>
  )
}
