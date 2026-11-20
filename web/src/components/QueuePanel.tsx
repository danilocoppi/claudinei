import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  addToQueue, editQueueItem, pauseQueue, removeQueueItem, reorderQueue, resumeQueue, sendQueueItemNow,
} from '../api'
import { progressKey, queueSeqOf, useStore } from '../store'
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
 * Se o item em edição sai da fila no meio (foi entregue, ou removido noutra
 * aba), o texto editado não se perde: fica num editor órfão, com o aviso e as
 * opções de pôr na fila de novo ou descartar.
 *
 * Fila vazia, sem pausa e sem editor órfão não desenha nada. Fica fora da moldura que o Zen
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

  // O item em edição saiu da fila: o editor vira órfão, com o texto editado.
  const orphan = !!editing && !!queue && !queue.items.some((i) => i.id === editing.id)

  if (!queue || (queue.items.length === 0 && !queue.paused && !orphan)) return null

  /**
   * Chama a API e aplica a fila devolvida na hora, sem esperar o WebSocket —
   * a menos que um `operator_queue` deste terminal tenha chegado no meio: aí a
   * resposta é mais velha (o "enviar agora" responde antes da entrega) e fica de fora.
   */
  const call = async (fn: () => Promise<OperatorQueue>): Promise<boolean> => {
    setError(null)
    const seq = queueSeqOf(projectId, engine)
    try {
      const q = await fn()
      useStore.getState().applyQueueReply({ ...q, projectId, engine }, seq)
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

  /** Devolve à fila (no fim) o texto do editor órfão. */
  const requeue = async () => {
    if (!editing) return
    const { id, text } = editing
    if (await call(() => addToQueue(projectId, engine, text))) {
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
          {/* Com o editor órfão aberto, editar outro item jogaria fora o texto dele. */}
          <button type="button" className="ghost queue-panel__icon" aria-label={t('queue.edit')} title={t('queue.edit')}
                  disabled={orphan} onClick={() => setEditing({ id: item.id, text: item.text })}>✎</button>
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
      {orphan && editing && (
        <div className="queue-panel__orphan">
          <div className="queue-panel__status" role="status">{t('queue.orphan')}</div>
          <textarea
            className="queue-panel__editor"
            aria-label={t('queue.orphanLabel')}
            rows={3}
            value={editing.text}
            onChange={(e) => setEditing({ id: editing.id, text: e.target.value })}
          />
          <div className="queue-panel__actions">
            <button type="button" disabled={!editing.text.trim()} onClick={() => void requeue()}>{t('queue.requeue')}</button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>{t('queue.discard')}</button>
          </div>
        </div>
      )}
      {queue.items.length > 0 && <ol className="queue-panel__list">{queue.items.map(row)}</ol>}
      {error && <div className="queue-panel__error">⚠ {error}</div>}
    </section>
  )
}
