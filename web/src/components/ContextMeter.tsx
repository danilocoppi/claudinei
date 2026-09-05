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
 * Medidor do contexto, renderizado DENTRO da aba da engine a que ele pertence.
 * O dado é por sessão — o `manager.ts` só o tem para engines cujo parser reporta
 * `usage` (hoje, o Claude) — então solto no header ele parecia um número do
 * terminal inteiro, valendo para as três abas.
 *
 * Duas leituras da mesma grandeza: o trilho ocupa o fio inferior da própria aba
 * (ambiente, comparável entre abas de relance, e não custa largura nenhuma numa
 * barra que rola no celular) e o numeral dá o valor exato. Sem dado — outra
 * engine, ou sessão sem turno desde o boot — não renderiza nada.
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
      <span className="ctx-meter__pct">{pct}%</span>
      {/* Posicionado contra a .engine-tab (não contra este span): atravessa a aba
          inteira, passando por baixo do ⏻. */}
      <span className="ctx-meter__rail" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
    </span>
  )
}
