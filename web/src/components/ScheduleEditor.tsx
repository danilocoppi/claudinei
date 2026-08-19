import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { previewCadence, type Cadence, type Schedule } from '../api'
import { useStore } from '../store'
import { defaultCadence } from '../cadenceText'

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

/**
 * O agendamento como uma FRASE que se completa, não como cinco campos de cron.
 * A linha de "próximas execuções" é o coração da tela: vem do servidor a cada
 * mudança, então o que se vê é literalmente o que o agendador vai fazer.
 */
export function ScheduleEditor({
  projectId, editing, onClose, onSave,
}: {
  projectId: number
  editing?: Schedule | null
  onClose: () => void
  onSave: (input: Record<string, unknown>) => Promise<void>
}) {
  const { t } = useTranslation()
  const engines = useStore((s) => s.engines)

  const [name, setName] = useState(editing?.name ?? '')
  const [task, setTask] = useState(editing?.task ?? '')
  const [cadence, setCadence] = useState<Cadence>(editing?.cadence ?? { kind: 'daily', at: '09:00' })
  const [engine, setEngine] = useState(editing?.engine ?? '')
  const [model, setModel] = useState(editing?.model ?? '')
  const [effort, setEffort] = useState(editing?.effort ?? '')
  const [expectsResult, setExpectsResult] = useState(editing?.expectsResult ?? true)
  const [keepResults, setKeepResults] = useState(editing?.keepResults ?? 10)
  const [next, setNext] = useState<string[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // O preview é a prova de vida da frase: mostra o que o AGENDADOR faria, porque é
  // ele quem calcula. Um cálculo próprio aqui acabaria discordando com o tempo.
  useEffect(() => {
    let alive = true
    previewCadence(cadence)
      // `?? []` não é paranoia: uma resposta sem `next` (proxy, versão antiga do
      // servidor) apagaria o editor inteiro em vez de só o preview.
      .then((r) => { if (alive) { setNext(r.next ?? []); setError('') } })
      .catch((err) => { if (alive) { setNext([]); setError((err as Error).message) } })
    return () => { alive = false }
  }, [JSON.stringify(cadence)])

  const patch = <K extends Cadence>(over: Partial<K>) => setCadence((c) => ({ ...c, ...over } as Cadence))
  const toggleWeekday = (d: number) => {
    const cur = ('weekdays' in cadence ? cadence.weekdays : undefined) ?? []
    patch({ weekdays: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort() } as never)
  }
  const weekdaysOf = () => ('weekdays' in cadence ? cadence.weekdays : undefined) ?? []
  const atOf = () => ('at' in cadence ? cadence.at : '09:00')

  const engineMeta = engines.find((e) => e.id === (engine || 'claude'))

  const save = async () => {
    setSaving(true)
    try {
      await onSave({
        name: name.trim(), task: task.trim(), cadence,
        engine: engine || null, model: model || null, effort: effort || null,
        expectsResult, keepResults,
      })
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const canSave = !!name.trim() && !!task.trim() && next.length > 0 && !saving

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal glass sched-editor" data-testid="sched-editor" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? t('schedules.editTitle') : t('schedules.newTitle')}</h3>

        <label className="sched-field">
          <span>{t('schedules.name')}</span>
          <input data-testid="sched-name" value={name} onChange={(e) => setName(e.target.value)}
                 placeholder={t('schedules.namePlaceholder')} />
        </label>

        <label className="sched-field">
          <span>{t('schedules.task')}</span>
          <textarea data-testid="sched-task" rows={4} value={task} onChange={(e) => setTask(e.target.value)}
                    placeholder={t('schedules.taskPlaceholder')} />
        </label>

        <div className="sched-field">
          <span>{t('schedules.repeat')}</span>
          <div className="sched-sentence">
            <select data-testid="sched-kind" value={cadence.kind}
                    onChange={(e) => setCadence(defaultCadence(e.target.value as Cadence['kind'], cadence))}>
              {(['every', 'daily', 'weekly', 'monthly', 'cron'] as const).map((k) => (
                <option key={k} value={k}>{t(`schedules.kind.${k}` as 'schedules.kind.every')}</option>
              ))}
            </select>

            {cadence.kind === 'every' && (
              <>
                <input data-testid="sched-n" type="number" min={1} max={59} className="sched-num"
                       value={cadence.n} onChange={(e) => patch({ n: Number(e.target.value) } as never)} />
                <select value={cadence.unit} onChange={(e) => patch({ unit: e.target.value as 'minutes' | 'hours' } as never)}>
                  <option value="minutes">{t('schedules.unit.minutes')}</option>
                  <option value="hours">{t('schedules.unit.hours')}</option>
                </select>
              </>
            )}

            {cadence.kind === 'monthly' && (
              <input type="number" min={1} max={31} className="sched-num"
                     value={cadence.day} onChange={(e) => patch({ day: Number(e.target.value) } as never)} />
            )}

            {cadence.kind === 'cron' && (
              <input className="sched-cron" value={cadence.expr}
                     onChange={(e) => patch({ expr: e.target.value } as never)} placeholder="*/15 9-18 * * 1-5" />
            )}

            {(cadence.kind === 'daily' || cadence.kind === 'weekly' || cadence.kind === 'monthly') && (
              <input type="time" value={atOf()} onChange={(e) => patch({ at: e.target.value } as never)} />
            )}
          </div>

          {(cadence.kind === 'every' || cadence.kind === 'daily' || cadence.kind === 'weekly') && (
            <div className="sched-days">
              <span className="sched-days__label">{t('schedules.onlyOn')}</span>
              {WEEKDAYS.map((d) => (
                <button key={d} type="button"
                        className={`sched-day ${weekdaysOf().includes(d) ? 'on' : ''}`}
                        onClick={() => toggleWeekday(d)}>
                  {t(`schedules.weekday.d${d}` as 'schedules.weekday.d0')}
                </button>
              ))}
            </div>
          )}

          {cadence.kind === 'every' && (
            <div className="sched-window">
              <span className="sched-days__label">{t('schedules.betweenLabel')}</span>
              <input type="time" value={cadence.from ?? ''} onChange={(e) => patch({ from: e.target.value || undefined } as never)} />
              <span>—</span>
              <input type="time" value={cadence.to ?? ''} onChange={(e) => patch({ to: e.target.value || undefined } as never)} />
            </div>
          )}

          <div className="sched-preview" data-testid="sched-preview">
            {next.length > 0
              ? <>▸ {t('schedules.nextRuns')}: {next.map((d) => new Date(d).toLocaleString()).join(' · ')}</>
              : <span className="sched-preview--bad">{error || t('schedules.noNextRun')}</span>}
          </div>
        </div>

        <div className="sched-field">
          <span>{t('schedules.result')}</span>
          <div className="sched-radios">
            <label>
              <input type="radio" checked={expectsResult} onChange={() => setExpectsResult(true)} />
              {t('schedules.keepResult')}
            </label>
            <label>
              <input data-testid="sched-no-result" type="radio" checked={!expectsResult} onChange={() => setExpectsResult(false)} />
              {t('schedules.fireOnly')}
            </label>
          </div>
          {expectsResult && (
            <label className="sched-keep">
              {t('schedules.keepLast')}
              <input data-testid="sched-keep" type="number" min={1} max={50} className="sched-num"
                     value={keepResults} onChange={(e) => setKeepResults(Number(e.target.value))} />
            </label>
          )}
        </div>

        {/* "Manter o atual" é o padrão: obrigar a escolher faria o operador fixar um
            modelo sem querer e descobrir semanas depois. */}
        <div className="sched-field sched-runtime">
          <label>
            <span>{t('schedules.engine')}</span>
            <select data-testid="sched-engine" value={engine} onChange={(e) => { setEngine(e.target.value); setModel('') }}>
              <option value="">{t('schedules.keepCurrent')}</option>
              {engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </label>
          <label>
            <span>{t('schedules.model')}</span>
            <select data-testid="sched-model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t('schedules.keepCurrent')}</option>
              {(engineMeta?.models ?? []).filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label>
            <span>{t('schedules.effort')}</span>
            <select data-testid="sched-effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">{t('schedules.keepCurrent')}</option>
              {(engineMeta?.efforts ?? []).map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </div>

        {error && next.length > 0 && <div className="sched-error">{error}</div>}

        <div className="modal__actions">
          <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!canSave} onClick={() => void save()}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  )
}
