/**
 * Colar texto grande no campo de mensagem.
 *
 * Um log ou um arquivo inteiro colado no campo deixa o prompt ilegível e pesa
 * no histórico da conversa. Acima destes limites o texto colado vira um anexo
 * `colado-HHMMSS.txt`, e o campo recebe só o token `[📎 …]`. Ctrl+Shift+V cola
 * como texto mesmo assim (ver ChatInput).
 */
export const PASTE_MAX_BYTES = 10_240
export const PASTE_MAX_LINES = 100

/** Linhas como o usuário as vê: a quebra no fim da última não abre uma linha nova. */
const contaLinhas = (text: string): number => {
  if (!text) return 0
  const quebras = text.match(/\r\n|\r|\n/g)?.length ?? 0
  return /(\r\n|\r|\n)$/.test(text) ? quebras : quebras + 1
}

/** Grande demais para o campo: mais de 10 240 bytes em UTF-8 ou mais de 100 linhas. */
export function isLargePaste(text: string): boolean {
  if (contaLinhas(text) > PASTE_MAX_LINES) return true
  // atalho barato: cada caractere UTF-16 vira no máximo 3 bytes
  if (text.length * 3 <= PASTE_MAX_BYTES) return false
  return new TextEncoder().encode(text).length > PASTE_MAX_BYTES
}

const dois = (n: number) => String(n).padStart(2, '0')

/** Nome do anexo, na hora local: `colado-HHMMSS.txt`. */
export function pasteFileName(now: Date = new Date()): string {
  return `colado-${dois(now.getHours())}${dois(now.getMinutes())}${dois(now.getSeconds())}.txt`
}
