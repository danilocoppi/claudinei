import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../types'

/**
 * Janela assumida quando o servidor ainda não disse qual é (sessão sem init
 * desde o boot). O valor real vem em `session.contextWindow`, derivado do modelo
 * em uso — os Opus/Sonnet/Fable atuais têm 1M, o Haiku tem estes 200k.
 */
export const CLAUDE_CONTEXT_WINDOW = 200_000

export const fmtK = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M` // 1M não vira "1000k"
  return n < 1000 ? String(n) : `${Math.round(n / 1000)}k`
}

/** Medidor por sessão. Codex usa a janela anunciada pelo protocolo; sem dado,
 * não assume o tamanho de outra engine. Claude conserva seu fallback legado. */
export function ContextMeter({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const used = session.contextTokens
  if (used === undefined) return null
  const janela = session.contextWindow ?? (session.engine === 'claude' ? CLAUDE_CONTEXT_WINDOW : undefined)
  if (!Number.isFinite(used) || used < 0 || !janela || !Number.isFinite(janela) || janela <= 0) return null
  const pct = Math.min(100, Math.round((used / janela) * 100))
  // Os mesmos degraus do card de uso: aviso na metade do caminho, alerta quando
  // compactar deixa de ser opcional.
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <span
      className={`ctx-meter ctx-meter--${tone}`}
      data-testid="ctx-meter"
      title={t(session.engine === 'codex' ? 'chat.ctxTipCodex' : 'chat.ctxTip', { used: fmtK(used), window: fmtK(janela) })}
    >
      <span className="ctx-meter__pct">{pct}%</span>
      {/* Posicionado contra a .engine-tab (não contra este span): atravessa a aba
          inteira, passando por baixo do ⏻. */}
      <span className="ctx-meter__rail" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </span>
  )
}
