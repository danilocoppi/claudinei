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

function suportado(): boolean {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
}

/** Pinta `q` nas `.chat-entry` dentro de `root` (só o que a lista montou); `q` vazio apaga. */
export function paintFindMatches(root: HTMLElement | null, q: string): void {
  if (!suportado()) return
  if (!root || !q) { CSS.highlights.delete(NOME); return }
  const ranges: Range[] = []
  for (const entry of root.querySelectorAll('.chat-entry')) {
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node && ranges.length < MAX_TRECHOS; node = walker.nextNode()) {
      for (const [a, b] of matchRanges(node.nodeValue ?? '', q)) {
        const r = new Range()
        r.setStart(node, a)
        r.setEnd(node, b)
        ranges.push(r)
      }
    }
    if (ranges.length >= MAX_TRECHOS) break
  }
  CSS.highlights.set(NOME, new Highlight(...ranges))
}

/**
 * Agenda a pintura de `q` dentro de `rootRef`: quando `q` muda e quando quem
 * chama avisa (a faixa montada da lista mudou, uma dobra abriu). Uma pintura
 * pendente por vez — nada a cada quadro ou a cada evento de rolagem. Devolve
 * o aviso, para passar ao `rangeChanged` da lista.
 */
export function useFindHighlight(rootRef: RefObject<HTMLElement | null>, q: string): () => void {
  const qRef = useRef(q)
  qRef.current = q
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const agendar = useCallback(() => {
    if (!suportado() || timer.current !== undefined) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      paintFindMatches(rootRef.current, qRef.current)
    }, ESPERA_MS)
  }, [rootRef])
  useEffect(() => { agendar() }, [q, agendar])
  useEffect(() => () => {
    clearTimeout(timer.current)
    if (suportado()) CSS.highlights.delete(NOME)
  }, [])
  return agendar
}
