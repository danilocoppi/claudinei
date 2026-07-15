/** Mescla o texto transcrito entre `before` e `after`, cuidando do espaçamento. */
export function mergeTranscript(before: string, after: string, tx: string): string {
  const sep = before && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
  return before + sep + tx + after
}
