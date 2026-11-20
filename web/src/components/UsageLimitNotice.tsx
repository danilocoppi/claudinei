import { memo, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { usageLimitAction } from '../api'
import { progressKey, useStore } from '../store'
import type { TerminalState, UsageLimit } from '../types'

/** A retomada armada sai esta folga depois da reabertura (como `graceMs` do servidor). */
const RESUME_GRACE_S = 60
/** Atualização do "daqui a X min": grossa de propósito (sem GPU, sem animação). */
const RELATIVE_REFRESH_MS = 30_000

/**
 * Hora local de um epoch em SEGUNDOS: HH:MM em 24 h no pt-BR e no es; no en, o
 * formato do próprio idioma (3:00 PM).
 */
export function formatLimitTime(epochSeconds: number, lang: string): string {
  const d = new Date(epochSeconds * 1000)
  if (lang.startsWith('en')) return d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "daqui a 2 h 10 min" até a reabertura, arredondado para cima no minuto. */
function relativeUntil(epochSeconds: number, nowMs: number, t: TFunction): string {
  const mins = Math.max(1, Math.ceil((epochSeconds * 1000 - nowMs) / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return t('limit.inMinutes', { m })
  return m === 0 ? t('limit.inHours', { h }) : t('limit.inHoursMinutes', { h, m })
}

/** Reabertura conhecida e ainda no futuro: só então dá para armar ou adiar. */
const futureReset = (limit: UsageLimit, nowMs: number): number | null =>
  limit.resetsAt != null && limit.resetsAt * 1000 > nowMs ? limit.resetsAt : null

/**
 * Aviso do limite de uso, logo acima do campo do chat (abaixo do aviso do
 * reinício), para o terminal da aba (projeto + motor).
 *
 * - Sem ação (`none`) e com a reabertura conhecida no futuro: **Continuar quando
 *   reabrir** (arma a retomada), **Adiar até reabrir** (esconde o aviso até lá),
 *   **Continuar agora** e o ×. Sem a hora (ou já passada), só **Continuar agora**
 *   e o ×. O × manda `cancel`, que tira o aviso.
 * - Armado (`armed`): a hora da retomada (reabertura + 60 s), **Cancelar** (volta
 *   ao aviso) e **Continuar agora**.
 * - Adiado (`snoozed`): nada aqui; só a marca do cartão da lateral.
 *
 * Estático de propósito: a interface precisa andar sem GPU (AGENTS.md). O "daqui
 * a X min" é recalculado a cada 30 s, só enquanto o aviso em `none` tem hora.
 */
export function UsageLimitNotice({ projectId, engine }: { projectId: number; engine: string }) {
  const { t, i18n } = useTranslation()
  const key = progressKey(projectId, engine)
  const limit = useStore((s) => s.terminalStates[key]?.usageLimit ?? null)
  const [busy, setBusy] = useState(false)
  // O erro é do limite em que aconteceu: um limite novo começa sem ele.
  const [error, setError] = useState<{ at: string; message: string } | null>(null)
  const [, tick] = useReducer((n: number) => n + 1, 0)

  // Só em `none` o texto depende do relógio ("daqui a X min", e as opções somem
  // quando a hora passa); armado mostra uma hora fixa.
  const ticking = limit?.action === 'none' && limit.resetsAt != null
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(tick, RELATIVE_REFRESH_MS)
    return () => clearInterval(id)
  }, [ticking])

  if (!limit || limit.action === 'snoozed') return null

  // Aplica o que a chamada devolveu sem esperar o WebSocket. Parte do estado ATUAL
  // do store: um interruptor mudado enquanto a chamada ia não volta atrás.
  const applyLimit = (usageLimit: TerminalState['usageLimit']) => {
    const atual = useStore.getState().terminalStates[key]
    if (atual) useStore.getState().setTerminalState({ ...atual, usageLimit })
  }

  const run = async (action: 'arm' | 'snooze' | 'cancel' | 'continue') => {
    setBusy(true); setError(null)
    try {
      const saved = await usageLimitAction(projectId, engine, action)
      applyLimit(saved.usageLimit)
    } catch (err) {
      const e = err as Error & { code?: string }
      // Outro caminho já levou o limite (o relógio, outra aba): o aviso sai.
      if (e.code === 'no_usage_limit') applyLimit(null)
      // O revive que falha não chega pelo WebSocket: o erro que a chamada devolveu é o único sinal.
      else setError({ at: limit.hitAt, message: e.message })
    } finally { setBusy(false) }
  }

  const lang = i18n.language
  const errorLine = error?.at === limit.hitAt && <div className="restart-notice__error">{error.message}</div>
  const continueNow = (
    <button type="button" disabled={busy} onClick={() => void run('continue')}>{t('limit.continueNow')}</button>
  )

  if (limit.action === 'armed') {
    const text = limit.resetsAt != null
      ? t('limit.armed', { time: formatLimitTime(limit.resetsAt + RESUME_GRACE_S, lang) })
      : t('limit.hit')
    return (
      <div className="restart-notice limit-notice limit-notice--armed" role="status">
        <div className="restart-notice__head">
          <span aria-hidden="true">⏳</span>
          <span className="restart-notice__text">{text}</span>
          <button type="button" className="ghost" disabled={busy} onClick={() => void run('cancel')}>{t('limit.cancel')}</button>
          {continueNow}
        </div>
        {errorLine}
      </div>
    )
  }

  const now = Date.now()
  const reset = futureReset(limit, now)
  const text = reset != null
    ? `${t('limit.hit')} ${t('limit.reopens', { time: formatLimitTime(reset, lang), rel: relativeUntil(reset, now, t) })}`
    : t('limit.hit')

  return (
    <div className="restart-notice limit-notice" role="status">
      <div className="restart-notice__head">
        <span aria-hidden="true">⏳</span>
        <span className="restart-notice__text">{text}</span>
        <button type="button" className="ghost restart-notice__close" disabled={busy}
                aria-label={t('limit.dismiss')} title={t('limit.dismiss')} onClick={() => void run('cancel')}>×</button>
      </div>
      <div className="limit-notice__actions">
        {reset != null && (
          <>
            <button type="button" disabled={busy} onClick={() => void run('arm')}>{t('limit.arm')}</button>
            <button type="button" disabled={busy} onClick={() => void run('snooze')}>{t('limit.snooze')}</button>
          </>
        )}
        {continueNow}
      </div>
      {errorLine}
    </div>
  )
}

/**
 * O que a marca do cartão mostra, compacto: `<ação>:<resetsAt>` do primeiro
 * terminal do projeto com limite ativo, ou `null` (em `none`, sem a hora: a
 * marca não a mostra). Só uma string: a lateral não se redesenha quando muda o
 * que a marca não mostra (interruptores, origem, hora do bate, outros terminais).
 */
const limitMarkerKey = (states: Record<string, TerminalState>, projectId: number): string | null => {
  for (const st of Object.values(states)) {
    if (st.projectId !== projectId || !st.usageLimit) continue
    const { action, resetsAt } = st.usageLimit
    return action === 'none' ? 'none:' : `${action}:${resetsAt ?? ''}`
  }
  return null
}

/**
 * Marca do cartão da lateral: o terminal está no limite de uso, em qualquer ação.
 * Com o aviso adiado, é o único sinal que fica. Em `none`, sempre "limite de
 * uso", sem a hora: a marca não se atualiza quando a janela reabre, e o aviso
 * já mostra a hora. Adiado, "limite até 15:00"; armado, "retoma às 15:01".
 * Estática (sem GPU).
 *
 * No cartão expandido mora na linha de status (`inStatus`), onde cabe inteira;
 * no colapsado, na linha do nome, onde encolhe com reticências.
 */
export const UsageLimitCardMarker = memo(function UsageLimitCardMarker({ projectId, inStatus = false }: { projectId: number; inStatus?: boolean }) {
  const { t, i18n } = useTranslation()
  const marker = useStore((s) => limitMarkerKey(s.terminalStates, projectId))
  if (!marker) return null
  const [action, raw] = marker.split(':')
  const resetsAt = raw ? Number(raw) : null
  const text = action === 'none' || resetsAt == null ? t('limit.cardMarkerUnknown')
    : action === 'armed' ? t('limit.cardMarkerArmed', { time: formatLimitTime(resetsAt + RESUME_GRACE_S, i18n.language) })
    : t('limit.cardMarker', { time: formatLimitTime(resetsAt, i18n.language) })
  return (
    <span data-testid="limit-marker" className={`term-card__limit${inStatus ? ' term-card__limit--status' : ''}`} title={text}>{text}</span>
  )
})
