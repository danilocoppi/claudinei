import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { matchRanges } from './find'

/**
 * Destaque do termo buscado nas entradas MONTADAS da conversa, pela CSS Custom
 * Highlight API: os trechos viram `Range`s registrados num `Highlight`, e o CSS
 * (`::highlight(chat-find)`) pinta. Não mexe no DOM das mensagens (nada de
 * `<mark>` dentro do markdown) e não anima.
 *
 * Sem a API (navegador antigo, jsdom), não pinta nada: a ocorrência atual
 * continua marcada pelo `chat-hit` do bloco.
 */
const NOME = 'chat-find'
/** Teto de trechos pintados de uma vez (uma palavra comum numa saída enorme aberta). */
const MAX_TRECHOS = 2000
/** Espera entre a mudança e a pintura: junta os avisos de faixa da lista numa só passada. */
const ESPERA_MS = 120
/**
 * Nó de texto maior que isto não é pintado: dobrar sem acento custa por
 * caractere, e uma saída de ferramenta enorme aberta pesaria a cada faixa nova.
 * A ocorrência atual continua marcada pelo `chat-hit`.
 */
const MAX_NO_CHARS = 20_000

function suportado(): boolean {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
}

/**
 * Pinta `q` nas `.chat-entry` dentro de `root` (só o que a lista montou); `q`
 * vazio apaga. Devolve quantos trechos pintou.
 */
export function paintFindMatches(root: HTMLElement | null, q: string): number {
  if (!suportado()) return 0
  if (!root || !q) { CSS.highlights.delete(NOME); return 0 }
  const ranges: Range[] = []
  for (const entry of root.querySelectorAll('.chat-entry')) {
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && ranges.length < MAX_TRECHOS; node = walker.nextNode()) {
      const text = node.nodeValue ?? ''
      if (text.length > MAX_NO_CHARS) continue
      for (const [a, b] of matchRanges(text, q)) {
        const r = new Range()
        r.setStart(node, a)
        r.setEnd(node, b)
        ranges.push(r)
      }
    }
    if (ranges.length >= MAX_TRECHOS) break
  }
  CSS.highlights.set(NOME, new Highlight(...ranges))
  return ranges.length
}

/**
 * Agenda a pintura de `q` dentro de `rootRef`: quando `q` muda e quando quem
 * chama avisa (a faixa montada da lista mudou, uma dobra abriu). Uma pintura
 * pendente por vez — nada a cada quadro ou a cada evento de rolagem — e
 * nenhuma sem busca e sem nada pintado para apagar (barra fechada: o aviso de
 * faixa da lista não custa nada). Devolve o aviso, para o `rangeChanged`.
 */
export function useFindHighlight(rootRef: RefObject<HTMLElement | null>, q: string): () => void {
  const qRef = useRef(q)
  qRef.current = q
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pintado = useRef(false)
  const agendar = useCallback(() => {
    if (timer.current !== undefined || (!qRef.current && !pintado.current) || !suportado()) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      pintado.current = paintFindMatches(rootRef.current, qRef.current) > 0
    }, ESPERA_MS)
  }, [rootRef])
  useEffect(() => { agendar() }, [q, agendar])
  useEffect(() => () => {
    clearTimeout(timer.current)
    if (suportado()) CSS.highlights.delete(NOME)
  }, [])
  return agendar
}
