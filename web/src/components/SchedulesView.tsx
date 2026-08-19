import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  createSchedule, deleteSchedule, fetchProjectSchedules, fetchRunContent, fetchScheduleRuns,
  runScheduleNow, updateSchedule, type Schedule, type ScheduleRun,
} from '../api'
import { useStore } from '../store'
import { describeCadence, formatShort } from '../cadenceText'
import { MarkdownPre } from './MarkdownPre'
import { ScheduleEditor } from './ScheduleEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'

/** O mesmo caminho de renderização do visualizador de arquivos: markdown com realce
 *  de sintaxe nos blocos de código. Um resultado que é código é lido como código. */
function ResultBody({ text }: { text: string }) {
  return (
    <div className="markdown sched-result__body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: MarkdownPre }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const fmtTime = formatShort
const durationOf = (r: ScheduleRun) =>
  r.finishedAt ? Math.max(1, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)) : null

const STATUS_ICON: Record<ScheduleRun['status'], string> = {
  ok: '✓', error: '⚠', timeout: '⌛', skipped: '⏭', running: '…',
}

/** Uma execução antiga: título numa linha; o corpo só chega quando se clica nela. */
function RunRow({ scheduleId, run }: { scheduleId: number; run: ScheduleRun }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null | undefined>(undefined)

  const toggle = () => {
    setOpen((was) => !was)
    if (content !== undefined || !run.contentSize) return
    void fetchRunContent(scheduleId, run.seq)
      .then((r) => setContent(r.content))
      .catch(() => setContent(null))
  }

  return (
    <div className="sched-run">
      <button type="button" className="sched-run__line" onClick={toggle}>
        <span className="sched-run__when">{fmtTime(run.startedAt)}</span>
        <span className={`sched-run__status sched-run__status--${run.status}`}>{STATUS_ICON[run.status]}</span>
        <span className="sched-run__title">{run.title ?? run.error ?? t('schedules.noTitle')}</span>
        {run.late && <span className="sched-run__late">{t('schedules.late')}</span>}
        <span className="sched-run__caret">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        run.contentSize
          ? content === undefined
            ? <div className="sched-run__loading">{t('common.loading')}</div>
            : content === null
              ? <div className="sched-run__missing">{t('schedules.contentMissing')}</div>
              : <ResultBody text={content} />
          : <div className="sched-run__missing">{run.error ?? t('schedules.noContent')}</div>
      )}
    </div>
  )
}

function ScheduleCard({ schedule, onChanged }: { schedule: Schedule; onChanged: () => void }) {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [fullResult, setFullResult] = useState<string | null>(null)

  useEffect(() => {
    void fetchScheduleRuns(schedule.id, 20).then(setRuns).catch(() => setRuns([]))
  }, [schedule.id, schedule.runCount])

  const last = schedule.lastRun
  const older = runs.filter((r) => r.seq !== last?.seq)
  // O último resultado abre com o preview que a listagem já trouxe; se o arquivo é
  // maior que isso, "ver tudo" busca o resto. Abrir a tela não pode custar 128 KB
  // por agendamento.
  const truncated = !!last?.contentSize && !!last.preview && last.contentSize > last.preview.length

  const act = (fn: () => Promise<unknown>) => () => void fn().then(onChanged).catch(() => {})

  return (
    <div data-testid="sched-card"
         className={`sched-card glass ${schedule.enabled ? '' : 'paused'} ${schedule.consecutiveFailures >= 2 ? 'failing' : ''}`}>
      <div className="sched-card__head">
        <span className="sched-card__icon">{schedule.enabled ? '⏱' : '⏸'}</span>
        <span className="sched-card__name">{schedule.name}</span>
        {schedule.consecutiveFailures >= 2 && (
          <span className="sched-card__failing">⚠ {t('schedules.failures', { count: schedule.consecutiveFailures })}</span>
        )}
        <div className="sched-card__actions">
          <button className="ghost" title={t('schedules.runNow')} onClick={act(() => runScheduleNow(schedule.id))}>▶</button>
          <button className="ghost"
                  title={schedule.enabled ? t('schedules.pause') : t('schedules.resume')}
                  onClick={act(() => updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>
            {schedule.enabled ? '⏸' : '⏵'}
          </button>
          <button className="ghost" title={t('schedules.edit')} onClick={() => setEditing(true)}>✎</button>
          <button className="ghost" title={t('schedules.delete')} onClick={() => setConfirming(true)}>🗑</button>
        </div>
      </div>

      <div className="sched-card__meta">
        <span data-testid="sched-cadence">{describeCadence(schedule.cadence, t as never)}</span>
        {schedule.enabled && schedule.nextRunAt && <span>· {t('schedules.next', { when: fmtTime(schedule.nextRunAt) })}</span>}
        {!schedule.enabled && <span>· {t('schedules.paused')}</span>}
        {!schedule.expectsResult && <span>· {t('schedules.fireOnly')}</span>}
        {schedule.engine && <span className="sched-chip">{schedule.engine}</span>}
        {schedule.model && <span className="sched-chip">{schedule.model}</span>}
        {schedule.effort && <span className="sched-chip">{schedule.effort}</span>}
      </div>

      {/* Sem retorno, um feed vazio faria esperar um resultado que nunca vem: a tira
          de carimbos diz de longe que este agendamento é de outra natureza. */}
      {!schedule.expectsResult ? (
        <div className="sched-stamps" data-testid="sched-stamps">
          {runs.length === 0
            ? t('schedules.neverRan')
            : runs.map((r) => (
              <span key={r.seq} className="sched-stamp">{STATUS_ICON[r.status]} {fmtTime(r.startedAt)}</span>
            ))}
        </div>
      ) : (
        <div className="sched-feed" data-testid="sched-feed">
          {last?.contentSize && last.preview ? (
            <div className="sched-result">
              <div className="sched-result__head">
                <span>{fmtTime(last.startedAt)}</span>
                <span className={`sched-run__status sched-run__status--${last.status}`}>{STATUS_ICON[last.status]}</span>
                {durationOf(last) && <span>{durationOf(last)}s</span>}
                {last.localId && (
                  <button className="sched-result__link" onClick={() => useStore.getState().openSession(last.localId!)}>
                    → {t('schedules.seeInChat')}
                  </button>
                )}
              </div>
              <ResultBody text={fullResult ?? last.preview} />
              {truncated && !fullResult && (
                <button className="sched-result__more"
                        onClick={() => void fetchRunContent(schedule.id, last.seq).then((r) => setFullResult(r.content)).catch(() => {})}>
                  {t('schedules.seeAll')}
                </button>
              )}
            </div>
          ) : (
            <div className="sched-result__empty">{last ? last.error ?? t('schedules.noContent') : t('schedules.neverRan')}</div>
          )}
          {older.length > 0 && (
            <div className="sched-older">
              {older.map((r) => <RunRow key={r.seq} scheduleId={schedule.id} run={r} />)}
              <div className="sched-older__count">{t('schedules.showing', { n: runs.length, total: schedule.keepResults })}</div>
            </div>
          )}
        </div>
      )}

      {editing && (
        <ScheduleEditor
          projectId={schedule.projectId} editing={schedule}
          onClose={() => setEditing(false)}
          onSave={async (input) => { await updateSchedule(schedule.id, input); onChanged() }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={t('schedules.deleteTitle', { name: schedule.name })}
          message={t('schedules.deleteMsg')}
          confirmLabel={t('common.delete')}
          onConfirm={async () => { await deleteSchedule(schedule.id); onChanged() }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

/**
 * Terceiro modo do terminal (Chat · Terminal · Agendas). O que se abre todo dia é o
 * RESULTADO, não a configuração: por isso o último vem aberto e o editor mora atrás
 * do ✎.
 */
export function SchedulesView() {
  const { t } = useTranslation()
  const { sessions, activeLocalId, projects } = useStore()
  const openSession = useStore((s) => s.openSession)
  const session = activeLocalId ? sessions[activeLocalId] : undefined
  const project = projects.find((p) => p.id === session?.projectId)

  const [items, setItems] = useState<Schedule[]>([])
  const [creating, setCreating] = useState(false)

  const reload = useCallback(() => {
    if (!project) return
    void fetchProjectSchedules(project.id)
      .then((list) => {
        setItems(list)
        // Mantém o ⏱ da sidebar em dia sem esperar o próximo boot.
        const others = useStore.getState().schedules.filter((s) => s.projectId !== project.id)
        useStore.getState().setSchedules([...others, ...list])
      })
      .catch(() => setItems([]))
  }, [project?.id])

  useEffect(reload, [reload])

  if (!project) return <div className="sched-view__empty">{t('schedules.selectTerminal')}</div>

  return (
    <div className="sched-view">
      <header className="sched-view__head">
        <Icon className="sched-view__icon" value={project.icon} size={20} />
        <strong className="sched-view__title">{t('schedules.titleFor', { name: project.name })}</strong>
        {items.length > 0 && <span className="sched-view__count">{items.length}</span>}
        <div className="sched-view__actions">
          <button onClick={() => setCreating(true)}>＋ {t('schedules.new')}</button>
          {activeLocalId && (
            <button className="ghost" onClick={() => openSession(activeLocalId)}>{t('schedules.backToChat')}</button>
          )}
        </div>
      </header>

      <div className="sched-view__body">
        {/* Vazio é convite, não encolher de ombros: diz o que um agendamento faz e
            oferece a ação ali mesmo. */}
        {items.length === 0 && (
          <div className="sched-view__empty">
            <span className="sched-view__empty-icon" aria-hidden="true">⏱</span>
            <p className="sched-view__empty-title">{t('schedules.empty')}</p>
            <p className="sched-view__empty-hint">{t('schedules.emptyHint')}</p>
            <button onClick={() => setCreating(true)}>＋ {t('schedules.new')}</button>
          </div>
        )}
        {items.map((s) => <ScheduleCard key={s.id} schedule={s} onChanged={reload} />)}
      </div>

      {creating && (
        <ScheduleEditor
          projectId={project.id}
          onClose={() => setCreating(false)}
          onSave={async (input) => { await createSchedule(project.id, input); reload() }}
        />
      )}
    </div>
  )
}
