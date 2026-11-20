import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchUsageReport, type IndexStatus, type UsagePeriod, type UsageReport, type UsageTotals } from '../api'
import { useStore } from '../store'
import { byPriorityThenRecency, primarySessionOf } from '../engineSession'

const PERIODS: readonly UsagePeriod[] = ['24h', '7d', '30d', '90d']
const PERIOD_DAYS: Record<UsagePeriod, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
/** Enquanto a passada do indexador roda, o relatório é relido neste intervalo. */
const POLL_MS = 5_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

type Report = UsageReport & { index: IndexStatus }
type Terminal = UsageReport['terminals'][number]

/** Cor de cada motor nas barras; motor desconhecido fica neutro. */
const ENGINE_COLOR: Record<string, string> = { claude: 'var(--accent)', codex: 'var(--engine-teal)' }
const engineColor = (id: string) => ENGINE_COLOR[id] ?? 'var(--text-dim)'

const bySpent = <T extends { totals: UsageTotals }>(list: T[]): T[] =>
  [...list].sort((a, b) => b.totals.spent - a.totals.spent || b.totals.cacheRead - a.totals.cacheRead)

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0)

/**
 * Data do rótulo da série. O servidor já mandou o rótulo no fuso local
 * ('YYYY-MM-DDTHH' ou 'YYYY-MM-DD'); aqui só se formata, lendo os campos como
 * UTC e formatando em UTC — assim o navegador não refaz conta de fuso nenhuma.
 */
function bucketDate(bucket: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(bucket)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0))
}

/**
 * O Claude apaga os históricos com mais de ~30 dias: os 90 dias, ou um período
 * que começa antes da hora mais antiga do índice, mostram só o que já estava
 * indexado. `oldestHour` é a hora UTC 'YYYY-MM-DDTHH', comparável como texto.
 */
function needsRetentionNotice(r: Report, now: number): boolean {
  if (r.period === '90d') return true
  if (!r.oldestHour) return false
  const start = new Date(Math.floor((now - PERIOD_DAYS[r.period] * DAY_MS) / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13)
  return r.oldestHour > start
}

export function UsagePage() {
  const { t, i18n } = useTranslation()
  const engines = useStore((s) => s.engines)
  const [period, setPeriod] = useState<UsagePeriod>('7d')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Se a passada rodava no último relatório bom; uma busca que falha no meio dela
  // não pode congelar o "Indexando…", então ela agenda outra tentativa.
  const indexingRef = useRef(false)

  // Uma busca por vez: a próxima só é agendada quando a anterior volta (com ou
  // sem erro), e só enquanto a passada do indexador roda. Trocar o período ou
  // sair da página aborta a busca em voo e apaga o agendamento.
  useEffect(() => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      fetchUsageReport(period, new Date().getTimezoneOffset(), ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return
          setReport(r)
          setError(null)
          indexingRef.current = !!r.index?.running
          if (indexingRef.current) timer = setTimeout(load, POLL_MS)
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return
          setError(err instanceof Error ? err.message : String(err))
          if (indexingRef.current) timer = setTimeout(load, POLL_MS)
        })
    }
    load()
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [period])

  const num = useMemo(() => new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }), [i18n.language])
  const pctFmt = useMemo(() => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }), [i18n.language])
  const engineLabel = (id: string) => engines.find((e) => e.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1)

  const openTerminal = (term: Terminal) => {
    const s = useStore.getState()
    // A sessão "cara" de cada terminal da pasta (prioridade de status, depois a mais
    // recente — a regra da lateral) e, entre elas, a melhor. Parada ou morta não abre,
    // como no cartão da lateral: sem sessão aberta, o painel.
    const best = term.projectIds
      .map((id) => primarySessionOf(id, s.sessions))
      .filter((x): x is NonNullable<typeof x> => !!x && x.status !== 'stopped' && x.status !== 'dead')
      .sort(byPriorityThenRecency)[0]
    if (!best) s.openDashboard()
    else if (best.status === 'in_terminal') s.openTerminal(best.localId)
    else s.openSession(best.localId)
  }

  const terminalName = (term: Terminal) =>
    term.projectIds.length === 0 ? t('usagePage.outside') : term.names.length ? term.names.join(' / ') : (term.path ?? '?')

  const hourly = report?.period === '24h'
  const bucketLabel = (bucket: string, withDay: boolean) => {
    const d = bucketDate(bucket)
    if (!d) return bucket
    const opts: Intl.DateTimeFormatOptions = hourly
      ? { ...(withDay ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit' }
    return new Intl.DateTimeFormat(i18n.language, { ...opts, timeZone: 'UTC' }).format(d)
  }

  const terminals = report ? bySpent(report.terminals) : []
  const models = report ? bySpent(report.models) : []
  const maxTerm = terminals[0]?.totals.spent ?? 0
  const maxModel = models[0]?.totals.spent ?? 0
  const series = report?.series ?? []
  const maxPoint = series.reduce((m, p) => Math.max(m, p.spent), 0)

  const row = (key: string, name: string, total: number, bar: ReactNode, sub: string, onClick?: () => void) => {
    const body = (
      <>
        <span className="usage-page__row-head">
          <span className="usage-page__row-name">{name}</span>
          <span className="usage-page__row-num">{num.format(total)}</span>
        </span>
        <span className="usage-page__bar">{bar}</span>
        {sub && <span className="usage-page__row-sub">{sub}</span>}
      </>
    )
    return (
      <li key={key}>
        {onClick
          ? <button type="button" className="usage-page__row usage-page__row--link" title={t('usagePage.openTerminal')} onClick={onClick}>{body}</button>
          : <div className="usage-page__row">{body}</div>}
      </li>
    )
  }

  return (
    <div className="usage-page">
      <div className="usage-page__head">
        <h2 className="usage-page__title">{t('usagePage.title')}</h2>
        <div className="usage-page__periods" role="group" aria-label={t('usagePage.period')}>
          {PERIODS.map((p) => (
            <button key={p} type="button" className={`usage-page__period ${p === period ? 'on' : ''}`}
                    aria-pressed={p === period} onClick={() => setPeriod(p)}>
              {t(`usagePage.periods.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {report?.index?.running && (
        <p className="usage-page__notice">{t('usagePage.indexing', { done: report.index.filesDone, total: report.index.filesTotal })}</p>
      )}
      {report && needsRetentionNotice(report, Date.now()) && (
        <p className="usage-page__notice">{t('usagePage.claudeRetention')}</p>
      )}
      {error && <p className="usage-page__error">{error}</p>}
      {!report && !error && <p className="usage-page__dim">{t('common.loading')}</p>}

      {report && (
        <>
          <section className="usage-page__block usage-page__totals">
            <div className="usage-page__stat usage-page__stat--main" title={t('usagePage.spentTip')}>
              <span className="eyebrow">{t('usagePage.spent')}</span>
              <span className="usage-page__big" data-testid="usage-total-spent">{num.format(report.totals.spent)}</span>
            </div>
            <div className="usage-page__stat"><span className="eyebrow">{t('usagePage.input')}</span><span>{num.format(report.totals.input)}</span></div>
            <div className="usage-page__stat">
              <span className="eyebrow">{t('usagePage.output')}</span>
              <span>{num.format(report.totals.output)}</span>
              {report.totals.reasoning > 0 && (
                <span className="usage-page__dim">{t('usagePage.reasoning', { n: num.format(report.totals.reasoning) })}</span>
              )}
            </div>
            <div className="usage-page__stat"><span className="eyebrow">{t('usagePage.cacheWrite')}</span><span>{num.format(report.totals.cacheWrite)}</span></div>
            <div className="usage-page__stat"><span className="eyebrow">{t('usagePage.cacheRead')}</span><span>{num.format(report.totals.cacheRead)}</span></div>
            <p className="usage-page__cache">{t('usagePage.cacheShare', { pct: pctFmt.format(report.cachePct) })}</p>
          </section>

          <div className="usage-page__grid">
            <section className="usage-page__block usage-page__terminals">
              <h3 className="eyebrow">{t('usagePage.terminals')}</h3>
              {terminals.length === 0
                ? <p className="usage-page__dim">{t('usagePage.empty')}</p>
                : (
                  <ul className="usage-page__list">
                    {terminals.map((term) => {
                      const parts = Object.entries(term.byEngine).sort(([, a], [, b]) => b.spent - a.spent)
                      return row(
                        term.path ?? '\u0000outside',
                        terminalName(term),
                        term.totals.spent,
                        parts.map(([id, v]) => (
                          <span key={id} className="usage-page__seg" style={{ width: `${pct(v.spent, maxTerm)}%`, background: engineColor(id) }} />
                        )),
                        parts.map(([id, v]) => `${engineLabel(id)} ${num.format(v.spent)}`).join(' · '),
                        term.projectIds.length ? () => openTerminal(term) : undefined,
                      )
                    })}
                  </ul>
                )}
            </section>

            <section className="usage-page__block usage-page__models">
              <h3 className="eyebrow">{t('usagePage.models')}</h3>
              {models.length === 0
                ? <p className="usage-page__dim">{t('usagePage.empty')}</p>
                : (
                  <ul className="usage-page__list">
                    {models.map((m) => row(
                      `${m.engine}\u0000${m.model}`,
                      m.model,
                      m.totals.spent,
                      <span className="usage-page__seg" style={{ width: `${pct(m.totals.spent, maxModel)}%`, background: engineColor(m.engine) }} />,
                      engineLabel(m.engine),
                    ))}
                  </ul>
                )}
            </section>
          </div>

          {series.length > 0 && (
            <section className="usage-page__block">
              <h3 className="eyebrow">{t(hourly ? 'usagePage.seriesHourly' : 'usagePage.seriesDaily')}</h3>
              <div className="usage-page__series">
                {series.map((p) => (
                  <span key={p.bucket} className="usage-page__col" style={{ height: `${pct(p.spent, maxPoint)}%` }}
                        title={`${bucketLabel(p.bucket, true)} · ${num.format(p.spent)}`} />
                ))}
              </div>
              <div className="usage-page__axis">
                <span>{bucketLabel(series[0].bucket, false)}</span>
                <span>{bucketLabel(series[series.length - 1].bucket, false)}</span>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
