import { useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore, type FileMenuAction } from '../store'
import { copyText } from '../clipboard'
import { revealFile } from '../api'
import { isLocalHost, toFullPath, toRelativePath } from '../filePaths'

/**
 * Menu de contexto do link de arquivo: escolher entre abrir no POPUP
 * (FileViewerModal, como sempre) ou INLINE (painel dockado acima do input do
 * chat, que deixa continuar conversando com a engine enquanto lê).
 * Montado uma única vez (App.tsx); inerte sem `store.fileMenu`.
 *
 * O seletor do `@!` abre o mesmo menu pelo ⋯ de um arquivo: aí "Referenciar na
 * mensagem" vem em primeiro, e as outras ações avisam quem abriu (o `@!` sai).
 */
export function FileOpenMenu() {
  const { t } = useTranslation()
  const menu = useStore((s) => s.fileMenu)
  const closeFileMenu = useStore((s) => s.closeFileMenu)
  const openFile = useStore((s) => s.openFile)
  const openFileInline = useStore((s) => s.openFileInline)
  const projects = useStore((s) => s.projects)
  const box = useRef<HTMLDivElement>(null)
  /** Onde o foco estava ao abrir: fechar sem escolher devolve o foco para lá. */
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!menu) return
    opener.current = document.activeElement as HTMLElement | null
    if (menu.focus) box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // Esc fecha só este menu: em captura, antes do seletor do `@!` (que fecharia
    // junto) ver a tecla.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage ao menu aberto, não a cada render
  }, [menu])

  if (!menu) return null
  const name = menu.path.split('/').pop() || menu.path
  // clamp: o menu (~200×260 com os itens de copiar e referenciar) não pode nascer
  // estourando a borda da janela
  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 210))
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 280))

  // O path do chat vem ora relativo, ora absoluto: normaliza para as duas formas.
  const projectPath = projects.find((p) => p.id === menu.projectId)?.path
  const relative = toRelativePath(menu.path, projectPath)
  const full = toFullPath(menu.path, projectPath)

  function dismiss() {
    const back = opener.current
    closeFileMenu()
    if (back?.isConnected) back.focus({ preventScroll: true })
  }
  const done = (action: FileMenuAction, run: () => void) => () => {
    closeFileMenu(); run(); menu.afterAction?.(action)
  }

  const items: { key: string; icon: string; label: string; title?: string; run: () => void }[] = []
  if (menu.reference) {
    const reference = menu.reference
    items.push({ key: 'reference', icon: '🔗', label: t('fileViewer.referenceInMessage'), run: () => { closeFileMenu(); reference() } })
  }
  items.push({ key: 'popup', icon: '🗗', label: t('fileViewer.openPopup'), run: done('popup', () => openFile(menu.path, menu.kind, menu.projectId)) })
  if (menu.localId) {
    const localId = menu.localId
    items.push({ key: 'inline', icon: '📎', label: t('fileViewer.openInline'), run: done('inline', () => openFileInline(localId, menu.path, menu.kind, menu.projectId)) })
  }
  items.push({ key: 'copy', icon: '🏷', label: t('fileViewer.copyPath'), title: relative, run: done('copy', () => { void copyText(relative) }) })
  items.push({ key: 'copy-full', icon: '📋', label: t('fileViewer.copyFullPath'), title: full, run: done('copy', () => { void copyText(full) }) })
  // Só em acesso local: o gerenciador de arquivos abre na máquina do SERVIDOR —
  // de outro dispositivo, o clique não faria nada visível.
  if (isLocalHost()) {
    items.push({ key: 'reveal', icon: '📂', label: t('fileViewer.revealInFolder'), run: done('reveal', () => { void revealFile(menu.path, menu.projectId).catch(() => {}) }) })
  }

  const onItemKey = (event: KeyboardEvent<HTMLDivElement>, run: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = all.indexOf(event.currentTarget)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
    all[next]?.focus()
  }

  // z-index acima do seletor do `@!` (também um popover), de onde o menu pode abrir.
  return createPortal(
    <div className="sess-pop__overlay" style={{ zIndex: 70 }} data-file-actions="" onClick={() => dismiss()}>
      <div ref={box} className="sess-pop glass" role="menu" aria-label={name}
           style={{ left: x, top: y, minWidth: 200 }} onClick={(e) => e.stopPropagation()}>
        <div className="sess-pop__eyebrow" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        {items.map((item) => (
          <div key={item.key} className="sess-pop__item" role="menuitem" tabIndex={-1} title={item.title}
               onClick={item.run} onKeyDown={(event) => onItemKey(event, item.run)}>
            <span aria-hidden="true">{item.icon}</span><span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
