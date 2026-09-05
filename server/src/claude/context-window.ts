/**
 * Janela de contexto assumida quando não dá para reconhecer o modelo (tokens).
 * Subestimar é o erro seguro: o medidor mostra um % maior que o real e o
 * auto-compact dispara cedo — nunca tarde demais.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Janela dos modelos atuais de contexto longo. */
const LONG_CONTEXT_WINDOW = 1_000_000

/**
 * Famílias com 1M de janela. O CLI não anuncia o tamanho no stream, então a
 * janela sai do modelo que o `init` reporta — que pode ser o id completo
 * (`claude-opus-5`) ou o alias que o Claudinei passou no --model (`opus`).
 *
 * Fora desta lista, conservador: Haiku 4.5 tem 200k, e Opus 4.5/4.1 e os mais
 * antigos também. Um modelo novo que ninguém mapeou aqui aparece como 200k até
 * ganhar sua linha — errar para baixo é de propósito.
 */
const LONG_CONTEXT = [
  /^(fable|mythos)$/,
  /(fable|mythos)-\d/,
  /^opus$/, /opus[-_ ]?5\b/, /opus[-_ ]?4[-_.]?[678]\b/,
  /^sonnet$/, /sonnet[-_ ]?5\b/, /sonnet[-_ ]?4[-_.]?6\b/,
]

/**
 * Tamanho da janela de contexto (tokens) do modelo — o denominador do medidor
 * e do auto-compact. O sufixo `[1m]` do CLI tem a palavra final: é o beta de 1M
 * ligado explicitamente.
 */
export function contextWindowFor(model: string | null | undefined): number {
  const m = (model ?? '').trim().toLowerCase()
  if (!m) return DEFAULT_CONTEXT_WINDOW
  if (m.includes('[1m]')) return LONG_CONTEXT_WINDOW
  // Haiku é da geração atual mas tem 200k — checa antes das famílias longas.
  if (m.includes('haiku')) return DEFAULT_CONTEXT_WINDOW
  return LONG_CONTEXT.some((re) => re.test(m)) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW
}
