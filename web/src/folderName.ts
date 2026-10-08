/**
 * O nome de pasta sugerido a partir do nome do terminal: "AlFinex - Backend" →
 * "alfinex-backend". Sem acento nem espaço, porque a pasta vai parar em linha de
 * comando e em caminho de import; ponto e sublinhado do meio ficam. Nada que
 * suba de pasta sobrevive — o servidor recusaria de qualquer jeito.
 */
export function folderSlug(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
}
