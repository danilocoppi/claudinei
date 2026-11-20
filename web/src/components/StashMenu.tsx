import { useEffect, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { StashEntry } from '../stash'

/**
 * A lista dos prompts guardados com Ctrl+S neste terminal, aberta pelo 🗂.
 *
 * O Ctrl+S com o campo vazio só traz o ÚLTIMO; daqui dá para escolher qualquer
 * um. Mostra o mais novo primeiro, mas devolve ao `onPick` o índice na ordem
 * guardada (0 = o mais antigo), que é o que o `takeStash` espera.
 */
export function StashMenu({ entries, onPick, onClose, anchorRef }: {
  entries: StashEntry[]
  onPick: (index: number) => void
  onClose: () => void
  /** O botão que abre: clicar nele de novo é com ele (alterna), não "clique fora". */
  anchorRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Abre com o foco no mais novo: dá para escolher só com o teclado.
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('.stash-item')?.focus() }, [])

  useEffect(() => {
    const fora = (e: MouseEvent) => {
      const alvo = e.target as Node
      if (ref.current?.contains(alvo) || anchorRef?.current?.contains(alvo)) return
      onCloseRef.current()
    }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [anchorRef])

  const teclado = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const itens = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.stash-item') ?? [])
    const i = itens.indexOf(document.activeElement as HTMLButtonElement)
    const passo = e.key === 'ArrowDown' ? 1 : -1
    itens[(i + passo + itens.length) % itens.length]?.focus()
  }

  const hora = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  // o mais novo primeiro, guardando o índice original
  const visiveis = entries.map((e, i) => ({ e, i })).reverse()

  return (
    <div ref={ref} className="stash-menu" data-testid="stash-menu" role="menu"
         aria-label={t('stash.menu')} onKeyDown={teclado}>
      <div className="stash-menu__title">{t('stash.menu')}</div>
      {visiveis.map(({ e, i }) => (
        <button key={`${e.savedAt}-${i}`} type="button" role="menuitem" className="stash-item"
                data-testid="stash-item" title={e.text} onClick={() => onPick(i)}>
          <span className="stash-item__text">{e.text.trim().split('\n')[0]}</span>
          <span className="stash-item__meta">
            {e.attachments.length > 0 && <>{t('stash.attachments', { count: e.attachments.length })} · </>}
            {hora(e.savedAt)}
          </span>
        </button>
      ))}
    </div>
  )
}
