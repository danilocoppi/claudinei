import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore, progressKey } from '../store'
import { fetchProgress, clearProgress } from '../api'
import type { Progress, ProgressStatus, SessionStatus } from '../types'
import { CopyButton } from './CopyButton'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Acompanhamento de tarefas longas: o que o agente do terminal (projeto + motor)
 * informou pela ferramenta `update_progress` do Hermes. A coluna fica à direita
 * do chat; o botão do cabeçalho a abre e fecha. Ver
 * docs/superpowers/specs/2026-11-18-acompanhamento-de-tarefas-design.md.
 */

/** Rodapé âmbar: sem atualização há tanto tempo, com tarefa ainda aberta. */
const OLD_MS = 45 * 60_000

const ICON: Record<ProgressStatus, string> = { done: '✓', in_progress: '◐', review: '◎', blocked: '!', pending: '○' }

/** Sem sessão rodando no chat, ninguém atualiza: o que está na tela pode ter ficado para trás. */
const isHalted = (status?: SessionStatus) => !status || status === 'stopped' || status === 'dead' || status === 'in_terminal'
const hasOpenTask = (p: Progress | null | undefined) => !!p?.tasks.some((t) => t.status === 'in_progress')

type Props = { projectId: number; engine: string; sessionStatus?: SessionStatus }

function useProgress(projectId: number, engine: string) {
  return useStore((s) => s.progress[progressKey(projectId, engine)])
}

export function ProgressButton({ projectId, engine, sessionStatus }: Props) {
  const { t } = useTranslation()
  const progress = useProgress(projectId, engine)
  const open = useStore((s) => s.progressOpen)
  const toggle = useStore((s) => s.toggleProgress)
  const running = hasOpenTask(progress) && !isHalted(sessionStatus)
  return (
    <button className="ghost progress-btn" aria-label={t('progress.open')} aria-pressed={open}
            title={t('progress.open')} onClick={toggle}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m3 6 2 2 4-4" /><path d="M13 6h8" /><path d="m3 14 2 2 4-4" /><path d="M13 14h8" /><path d="M13 20h8" />
      </svg>
      <span className="btn-label">{t('progress.open')}</span>
      {running && <span className="progress-btn__dot" aria-hidden="true" />}
    </button>
  )
}

function ago(t: TFunction, iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (min < 1) return t('progress.agoNow')
  if (min < 60) return t('progress.agoMin', { n: min })
  return t('progress.agoHour', { h: Math.floor(min / 60), m: min % 60 })
}

export function ProgressColumn({ projectId, engine, sessionStatus }: Props) {
  const { t } = useTranslation()
  const progress = useProgress(projectId, engine)
  const setProgress = useStore((s) => s.setProgress)
  const toggle = useStore((s) => s.toggleProgress)
  const [path, setPath] = useState('')
  const [confirm, setConfirm] = useState(false)
  // O relógio do rodapé ("há X min") anda sozinho, uma vez por minuto.
  const [, tick] = useState(0)

  useEffect(() => {
    let alive = true
    fetchProgress(projectId, engine)
      .then((r) => { if (alive) { setProgress(projectId, engine, r.progress); setPath(r.path) } })
      .catch(() => { /* sem acompanhamento legível: a coluna mostra o vazio */ })
    return () => { alive = false }
  }, [projectId, engine, setProgress])

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const discard = () => {
    setConfirm(false)
    clearProgress(projectId, engine).then(() => setProgress(projectId, engine, null)).catch(() => {})
  }

  const halted = isHalted(sessionStatus) && hasOpenTask(progress)
  const done = progress?.tasks.filter((x) => x.status === 'done').length ?? 0
  const total = progress?.tasks.length ?? 0
  const unfinished = !!progress && done < total
  const old = !!progress && unfinished && Date.now() - new Date(progress.updatedAt).getTime() > OLD_MS

  return (
    <aside className="progress" aria-label={t('progress.title')}>
      <header className="progress__head">
        <button className="ghost progress__back" aria-label={t('progress.close')} title={t('progress.close')} onClick={toggle}>×</button>
        <strong>{t('progress.title')}</strong>
      </header>
      {!progress ? (
        <p className="progress__empty">{t('progress.empty')}</p>
      ) : (
        <div className="progress__body">
          <section className="progress__card">
            <div className="progress__task-title">{progress.title}</div>
            {total > 0 && (
              <div className="progress__count">
                <span>{t('progress.count', { done, total })}</span>
                <span className="progress__bar" aria-hidden="true"><span style={{ width: `${(done / total) * 100}%` }} /></span>
              </div>
            )}
          </section>
          {halted && <p className="progress__stale" role="status">{t('progress.stale')}</p>}
          <section className="progress__card progress__now">
            <h3>{t('progress.now')}</h3>
            <div className="progress__now-row">
              <span className={`progress__pulse${halted || !unfinished ? ' progress__pulse--off' : ''}`} aria-hidden="true" />
              <div>
                <div className="progress__now-title">{progress.now.title}</div>
                {progress.now.detail && <div className="progress__dim">{progress.now.detail}</div>}
              </div>
            </div>
          </section>
          {total > 0 && (
            <section className="progress__card">
              <h3>{t('progress.tasks')}</h3>
              <ul className="progress__tasks">
                {progress.tasks.map((task, i) => (
                  <li key={i} className={`progress__task progress__task--${task.status}`}>
                    <span className="progress__icon" aria-hidden="true">{ICON[task.status]}</span>
                    <span className="progress__name">{task.name}</span>
                    <span className={`progress__chip progress__chip--${task.status}`}>{t(`progress.status.${task.status}`)}</span>
                    {task.note && <span className="progress__note">{task.note}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {progress.waiting.length > 0 && (
            <section className="progress__card progress__waiting">
              <h3>{t('progress.waiting')}</h3>
              <ul>{progress.waiting.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </section>
          )}
          <footer className="progress__foot">
            <span className={`progress__updated${old ? ' progress__updated--old' : ''}`}>
              {t('progress.updated', { when: ago(t, progress.updatedAt) })}
            </span>
            {path && (
              <span className="progress__path">
                <code>{path}</code>
                <CopyButton text={path} />
              </span>
            )}
            <button className="ghost progress__discard" onClick={() => setConfirm(true)}>{t('progress.discard')}</button>
          </footer>
        </div>
      )}
      {confirm && (
        <ConfirmDialog title={t('progress.discardTitle')} message={t('progress.discardMsg')}
                       confirmLabel={t('progress.discardConfirm')} onConfirm={discard} onClose={() => setConfirm(false)} />
      )}
    </aside>
  )
}
