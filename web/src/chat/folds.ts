import { useCallback, useState } from 'react'
import { useStore } from '../store'

/**
 * Dobras do chat (grupo de ações, cartão de ferramenta, "mostrar tudo" e
 * resumo da compactação) guardadas no store pela chave estável do item.
 *
 * Com a lista virtual, o bloco que sai da tela desmonta: um `useState` voltaria
 * fechado quando o operador rolasse de volta. A chave ao vivo (`l<n>`) troca
 * pela confirmada quando o histórico chega, e o store leva a dobra junto (ver
 * `renameFolds` e `setHistoryTail`).
 */
export type FoldName = 'group' | 'tool' | 'more' | 'summary'

/** Id da dobra no store: a chave do item não tem ':', então o sufixo é o nome. */
export function foldId(itemKey: string, name: FoldName): string {
  return `${itemKey}:${name}`
}

/**
 * Estado aberto/fechado de uma dobra. Sem `itemKey` (item legado, sem chave) ou
 * sem sessão, cai no estado local, como era antes.
 *
 * O seletor devolve só o booleano desta dobra: abrir outra muda o mapa, mas não
 * este valor, e o bloco não re-renderiza.
 */
export function useFold(localId: string | undefined, itemKey: string | undefined, name: FoldName): [boolean, (open: boolean) => void] {
  const id = localId && itemKey ? foldId(itemKey, name) : undefined
  const [local, setLocal] = useState(false)
  const stored = useStore((s) => (id ? !!s.folds[localId!]?.[id] : false))
  const setFold = useStore((s) => s.setFold)
  const set = useCallback((open: boolean) => {
    if (id) setFold(localId!, id, open)
    else setLocal(open)
  }, [id, localId, setFold])
  return [id ? stored : local, set]
}
