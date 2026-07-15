/** Ritmo de uso: a cor da barra diz se o ritmo atual estoura o limite antes do reset. */

const HOUR = 3_600_000

/** Janela e granularidade por grupo de limite. Grupo desconhecido → sem ritmo. */
export function windowFor(group: string): { windowMs: number; chunkMs: number } | null {
  if (group === 'session') return { windowMs: 5 * HOUR, chunkMs: HOUR / 3 } // 5h em chunks de 20min
  if (group === 'weekly') return { windowMs: 168 * HOUR, chunkMs: HOUR }    // 7d em chunks de 1h
  return null
}

/** % da janela que já passou, quantizado por chunks (o chunk atual conta cheio). */
export function expectedPercent(resetsAt: string, windowMs: number, chunkMs: number, now: number): number {
  const reset = Date.parse(resetsAt)
  const start = reset - windowMs
  const elapsed = now - start
  const totalChunks = Math.round(windowMs / chunkMs)
  const chunks = Math.min(totalChunks, Math.max(1, Math.ceil(elapsed / chunkMs)))
  return (chunks / totalChunks) * 100
}

/** usado ÷ esperado. >1 = gastando rápido demais para chegar ao reset. */
export function paceRatio(percent: number, expected: number): number {
  if (expected <= 0) return percent > 0 ? Infinity : 0
  return percent / expected
}

/** ≤1 verde; 1→2 degradê (matiz 140→0); ≥2 vermelho; null = sem ritmo (accent). */
export function paceColor(ratio: number | null): string {
  if (ratio === null) return 'var(--accent)'
  if (ratio <= 1) return 'var(--ok)'
  if (ratio >= 2) return 'var(--err)'
  const hue = Math.round(140 * (2 - ratio)) // 1→140, 2→0
  return `hsl(${hue} 70% 55%)`
}
