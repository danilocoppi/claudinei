import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../types'

/**
 * Janela assumida quando o servidor ainda não disse qual é (sessão sem init
 * desde o boot). O valor real vem em `session.contextWindow`, derivado do modelo
 * em uso — os Opus/Sonnet/Fable atuais têm 1M, o Haiku tem estes 200k.
 */
export const CLAUDE_CONTEXT_WINDOW = 200_000

const fmtK = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M` // 1M não vira "1000k"
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`
}

/**
 * Medidor do contexto da conversa no header do chat. O dado vem do `usage` que
 * cada result do Claude já traz (novo + cache lido + cache criado) — custo zero.
 * Sem dado (outras engines, sessão sem turno desde o boot), não renderiza nada.
 */
export function ContextMeter({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const used = session.contextTokens
  if (used === undefined) return null
  const janela = session.contextWindow ?? CLAUDE_CONTEXT_WINDOW
  const pct = Math.min(100, Math.round((used / janela) * 100))
  // Os mesmos degraus do card de uso: aviso na metade do caminho, alerta quando
  // compactar deixa de ser opcional.
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <span
      className={`ctx-meter ctx-meter--${tone}`}
      data-testid="ctx-meter"
      title={t('chat.ctxTip', { used: fmtK(used), window: fmtK(janela) })}
    >
      <span className="ctx-meter__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      <span className="ctx-meter__pct">{pct}%</span>
    </span>
  )
}
