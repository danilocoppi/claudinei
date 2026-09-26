/** Ritmo de uso: a cor da barra diz se o ritmo atual estoura o limite antes do reset. */

const HOUR = 3_600_000

/** Janela e granularidade por grupo de limite. Grupo desconhecido → sem ritmo. */
export function windowFor(group: string, windowMinutes?: number): { windowMs: number; chunkMs: number } | null {
  if (windowMinutes !== undefined && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    const windowMs = windowMinutes * 60_000
    return { windowMs, chunkMs: windowMs / (windowMinutes <= 300 ? 15 : 168) }
  }
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

/** <0,7 azul; até 1 verde; 1→1,5 passa por amarelo; 1,5→2 vermelho; >2 roxo. */
export function paceColor(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return 'var(--text-dim)'
  if (ratio < 0.7) return 'var(--usage-low)'
  if (ratio <= 1) return 'var(--ok)'
  if (ratio > 2) return 'var(--usage-high)'
  if (ratio >= 1.5) return 'var(--err)'
  if (ratio === 1.25) return 'var(--warn)'
  const [from, to, start] = ratio < 1.25 ? ['ok', 'warn', 1] as const : ['warn', 'err', 1.25] as const
  const percent = Math.round((ratio - start) * 40000) / 100
  return `color-mix(in srgb, var(--${from}), var(--${to}) ${percent}%)`
}
