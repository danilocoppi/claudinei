import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'

/**
 * Dobras do chat (grupo de ações, cartão de ferramenta, "mostrar tudo",
 * resumo da compactação e raciocínio) guardadas no store pela chave estável do item.
 *
 * Com a lista virtual, o bloco que sai da tela desmonta: um `useState` voltaria
 * fechado quando o operador rolasse de volta. A chave ao vivo (`l<n>`) troca
 * pela confirmada quando o histórico chega, e o store leva a dobra junto (ver
 * `renameFolds` e `setHistoryTail`).
 */
export type FoldName = 'group' | 'tool' | 'more' | 'summary' | 'thinking'

/** Mensagens acima disso colapsam ("mostrar tudo"): mostra as primeiras linhas + botão de expandir. */
export const COLLAPSE_LINES = 13

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

/**
 * A dobra de um grupo de ações. O grupo é aberto pela chave do 1º item, mas
 * esse item muda: a página antiga junta ações no topo do grupo, ou o histórico
 * confirmado começa o grupo com um item que o ao vivo não tinha. Então o grupo
 * está aberto se QUALQUER membro guarda a dobra dele, e fechar limpa todas —
 * senão ele fecharia (e remontaria) bem onde o operador está lendo.
 *
 * O seletor devolve só o booleano: abrir outro grupo não re-renderiza este.
 * Sem sessão ou com o 1º item sem chave (legado), cai no estado local.
 */
export function useGroupFold(localId: string | undefined, itemKeys: (string | undefined)[]): [boolean, (open: boolean) => void] {
  const usaStore = !!localId && itemKeys[0] !== undefined
  // Assinatura estável das chaves: o array de itens é novo a cada render.
  const assinatura = usaStore ? itemKeys.filter((k) => k !== undefined).join('\n') : ''
  const ids = useMemo(() => (assinatura ? assinatura.split('\n').map((k) => foldId(k, 'group')) : []), [assinatura])
  const [local, setLocal] = useState(false)
  const stored = useStore(useCallback((s: { folds: Record<string, Record<string, true> | undefined> }) => {
    const f = localId ? s.folds[localId] : undefined
    return !!f && ids.some((id) => f[id])
  }, [localId, ids]))
  const setFold = useStore((s) => s.setFold)
  const set = useCallback((open: boolean) => {
    if (!usaStore) { setLocal(open); return }
    if (open) setFold(localId!, ids[0], true)
    else for (const id of ids) setFold(localId!, id, false)
  }, [usaStore, localId, ids, setFold])
  return [usaStore ? stored : local, set]
}
