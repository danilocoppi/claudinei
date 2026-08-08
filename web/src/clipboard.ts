/**
 * Copia texto para a área de transferência. Devolve se conseguiu.
 *
 * O fallback do `execCommand` não é legado inútil: a Clipboard API só existe em
 * contexto seguro, e abrir o Claudinei por IP na LAN (http://192.168.x.x:9105) NÃO
 * é contexto seguro — sem ele, copiar simplesmente não funcionaria fora do localhost.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }
}
