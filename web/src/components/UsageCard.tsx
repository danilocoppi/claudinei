import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { fetchUsage, type UsageLimit, type EngineUsage } from '../api'
import { windowFor, expectedPercent, paceRatio, paceColor } from '../usage/pace'
import { useStore } from '../store'
import { EngineIcon } from './EngineIcon'
import { UsageInfo } from './UsageInfo'

/** Formata contagem de tokens de forma compacta: 950 → "950", 12300 → "12.3k", 4500000 → "4.5M". */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const POLL_MS = 60_000
const ADVANCED_KEY = 'claudinei.usageAdvanced'

/** Rótulo: label da API (ex.: Fable) > i18n por kind > o próprio kind. */
function labelFor(l: UsageLimit, t: TFunction): string {
  if (l.label) return l.label
  if (l.kind === 'session') return t('usage.session')
  if (l.kind === 'weekly_all') return t('usage.weeklyAll')
  return l.kind.replace(/_/g, ' ')
}

function resetText(resetsAt: string, locale: string): string {
  const d = new Date(resetsAt)
  return d.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function UsageCard() {
  const { t, i18n } = useTranslation()
  const [limits, setLimits] = useState<UsageLimit[]>([])
  const [tokens, setTokens] = useState<Record<string, EngineUsage>>({})
  const engines = useStore((s) => s.engines)
  // avançado = todas as barras; desligado = só a sessão atual. Persistido.
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED_KEY) === '1')
  const [showInfo, setShowInfo] = useState(false)
  const toggleAdvanced = () => {
    setAdvanced((a) => {
      localStorage.setItem(ADVANCED_KEY, a ? '0' : '1')
      return !a
    })
  }

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchUsage()
        .then((r) => {
          if (!alive) return
          setLimits(Array.isArray(r?.limits) ? r.limits : [])
          setTokens(r?.tokens && typeof r.tokens === 'object' ? r.tokens : {})
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener('focus', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [])

  // Só engines que já reportaram tokens (ex.: Codex; o Claude reporta limites, não tokens).
  const tokenEntries = Object.entries(tokens).filter(([, v]) => v?.total && v.total.total > 0)
  if (limits.length === 0 && tokenEntries.length === 0) return null

  const now = Date.now()
  // modo simples: só a barra da sessão (fallback: a primeira, se a API mudar)
  const visible = advanced ? limits : [limits.find((l) => l.group === 'session') ?? limits[0]]
  return (
    <div className="usage-card glass">
      <div className="usage-card__head">
        <span className="eyebrow usage-card__title">{t('usage.title')}</span>
        <label className="switch switch--sm" title={t('usage.advanced')}>
          <input type="checkbox" checked={advanced} onChange={toggleAdvanced} aria-label={t('usage.advanced')} />
          <span className="track" />
          <span className="thumb" />
        </label>
      </div>
      {limits.length > 0 && (
        <div className="usage-card__group">
          {t('usage.claude')}
          <button type="button" className="usage-info-btn" title={t('usageInfo.title')}
                  aria-label={t('usageInfo.title')} onClick={() => setShowInfo(true)}>
            ⓘ
          </button>
        </div>
      )}
      {limits.length > 0 && visible.map((l) => {
        const win = windowFor(l.group)
        const ratio = win ? paceRatio(l.percent, expectedPercent(l.resetsAt, win.windowMs, win.chunkMs, now)) : null
        const color = paceColor(ratio)
        const tip = ratio !== null
          ? t('usage.pace', { percent: l.percent, ratio: (Math.round(ratio * 10) / 10).toLocaleString(i18n.language) })
          : `${l.percent}%`
        return (
          <div key={l.kind + (l.label ?? '')} className="usage-row" title={tip}>
            <div className="usage-row__head">
              <span className="usage-row__label">{labelFor(l, t)}</span>
              <span className="usage-row__pct">{l.percent}%</span>
            </div>
            <div className="usage-bar">
              <div className="usage-bar__fill" style={{ width: `${Math.min(100, l.percent)}%`, background: color }} />
            </div>
            <div className="usage-row__reset">{t('usage.resets', { when: resetText(l.resetsAt, i18n.language) })}</div>
          </div>
        )
      })}
      {tokenEntries.map(([id, tk]) => {
        const meta = engines.find((e) => e.id === id)
        return (
          <div key={id} className="usage-tokens" title={t('usage.tokensTip')}>
            <div className="usage-tokens__group">
              {meta?.icon && <EngineIcon icon={meta.icon} />}
              {meta?.label ?? id}
            </div>
            <div className="usage-tokens__total">
              <span className="usage-tokens__num">{fmtTokens(tk.total.total)}</span>
              <span className="usage-tokens__unit">{t('usage.tokens')}</span>
              <span className="usage-tokens__today">{t('usage.tokensToday', { n: fmtTokens(tk.today.total) })}</span>
            </div>
            <div className="usage-tokens__breakdown">
              {t('usage.tokenBreakdown', { in: fmtTokens(tk.total.input), out: fmtTokens(tk.total.output), reasoning: fmtTokens(tk.total.reasoning) })}
            </div>
          </div>
        )
      })}
      {showInfo && <UsageInfo onClose={() => setShowInfo(false)} />}
    </div>
  )
}
