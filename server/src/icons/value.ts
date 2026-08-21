/**
 * O que serve como ícone de um terminal, grupo ou setor.
 *
 * Duas formas, e a regra precisa conhecer as duas:
 *
 *   📁            um emoji
 *   mdi:server    um token do acervo (`prefixo:nome`)
 *
 * A validação do grupo tinha um teto de 16 caracteres, herdado de quando ícone era
 * só emoji. Com o acervo novo isso virou uma loteria pelo COMPRIMENTO do nome —
 * `mdi:server` (10) passava, `tabler:credit-card` (18) tomava 400 — e o cliente
 * engolia o erro, então Salvar não fazia nada. O terminal nunca sofreu disso
 * porque a rota dele não validava nada: os dois extremos do mesmo descuido.
 */

/** `prefixo:nome`, os dois em minúsculas com hífen — o formato do Iconify. */
const TOKEN = /^[a-z0-9][a-z0-9-]{0,38}:[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Quantos pontos de código um emoji pode ter. Uma família (👨‍👩‍👧‍👦) tem sete, com os
 * juntadores; tom de pele e seletor de variação somam mais alguns.
 */
const MAX_EMOJI_POINTS = 12

export function isIconValue(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s === '') return false
  if (TOKEN.test(s)) return true
  // Emoji: poucos pontos de código e nada de espaço ou controle, que não desenham
  // nada e só sujariam a linha.
  return [...s].length <= MAX_EMOJI_POINTS && !/[\s\p{Cc}]/u.test(s)
}

/** O valor já aparado, ou null se não serve. */
export const iconValueOf = (v: unknown): string | null =>
  isIconValue(v) ? (v as string).trim() : null
