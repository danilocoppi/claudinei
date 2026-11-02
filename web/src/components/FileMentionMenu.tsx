import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { fetchProjectFiles } from '../api'
import { kindOfPath } from '../files'
import { useStore, type FileMenuAction } from '../store'
import { ViewportPopover } from './ViewportPopover'
import type { ProjectFileEntry, ProjectFileListing } from '../../../shared/project-files'

/** O menu de ações de arquivo (FileOpenMenu) fica num portal próprio, fora deste painel. */
const inFileActions = (node: EventTarget | null) => node instanceof Element && !!node.closest('[data-file-actions]')

/**
 * Navegação por pastas: botões nativos, com busca, sem tratar pastas como valores.
 * Clicar num arquivo referencia; o ⋯ (ou o clique direito, ou a tecla de menu)
 * abre as mesmas ações do link de arquivo do chat.
 */
export function FileMentionMenu({ projectId, projectName, localId, anchorRef, onPick, onAction, onClose }: {
  projectId: number
  projectName: string
  /** Chat de onde o seletor abriu: habilita "Ver inline no chat". */
  localId?: string
  anchorRef: RefObject<HTMLElement>
  onPick: (path: string) => void
  /** Uma ação que não referencia (abrir, copiar…): quem abriu tira o `@!` e fecha. */
  onAction: (action: FileMenuAction) => void
  onClose: (restoreFocus: boolean) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const submitSearch = useRef<() => void>(() => {})
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<(ProjectFileListing & { query: string }) | null>(null)
  const current = result?.path === path && result.query === query ? result : null
  const ready = !loading && !composing && !error && !!current
  const visibleEntries = current && !composing && (ready || offset > 0) ? current.entries : []
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const openFileMenu = useStore((s) => s.openFileMenu)

  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !inFileActions(event.target)) closeRef.current(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      // O menu de ações que este seletor abriu não fica órfão quando ele some.
      const { fileMenu, closeFileMenu } = useStore.getState()
      if (fileMenu?.origin === id) closeFileMenu()
    }
  }, [id])

  useEffect(() => {
    let disposed = false
    let started = false
    let timedOut = false
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    setError(null)
    const load = () => {
      if (disposed || started || composing) return
      started = true
      timeout = setTimeout(() => { timedOut = true; controller.abort() }, 12_000)
      void fetchProjectFiles(projectId, path, query, offset, controller.signal).then(data => {
        if (disposed) return
        setResult(previous => ({
          ...data, query,
          entries: offset > 0 && previous?.path === path && previous.query === query
            ? [...new Map([...previous.entries, ...data.entries].map(entry => [entry.path, entry])).values()]
            : data.entries,
        }))
      }).catch(err => {
        if (!disposed) setError(timedOut ? 'timeout' : (err as Error).message)
      }).finally(() => {
        clearTimeout(timeout)
        if (!disposed) setLoading(false)
      })
    }
    const debounce = setTimeout(load, query && offset === 0 ? 300 : 0)
    submitSearch.current = load
    return () => { disposed = true; clearTimeout(debounce); clearTimeout(timeout); controller.abort() }
  }, [projectId, path, query, offset, retry, composing])

  const navigate = (next: string) => {
    setPath(next); setQuery(''); setOffset(0)
    input.current?.focus({ preventScroll: true })
    if (list.current) list.current.scrollTop = 0
  }
  const choose = (entry: ProjectFileEntry) => {
    if (!ready) return
    if (entry.isDir) navigate(entry.path)
    else onPick(entry.path)
  }
  const openActions = (entry: ProjectFileEntry, x: number, y: number, focus: boolean) => {
    if (!ready || entry.isDir) return
    openFileMenu({
      x, y, path: entry.path, kind: kindOfPath(entry.path), projectId, localId, focus, origin: id,
      reference: () => onPick(entry.path), afterAction: onAction,
    })
  }
  const actionsFromKeyboard = (entry: ProjectFileEntry, button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    openActions(entry, rect.right - 200, rect.bottom, true)
  }
  const errorText = error === 'forbidden_project' || error === 'outside_project' || error === 'directory_unreadable'
    ? t('chat.fileMentionDenied') : error === 'directory_not_found'
      ? t('chat.fileMentionMissing') : t('chat.fileMentionError')

  return createPortal(
    <ViewportPopover x={0} y={0} minWidth={280} width={400} anchorRef={anchorRef} placement="top">
      <div ref={panel} className="file-mention" role="dialog" aria-labelledby={`${id}-title`}
           data-testid="file-mention-menu"
           onBlur={(event) => {
             if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)
               && !inFileActions(event.relatedTarget)) onClose(false)
           }}
           onKeyDown={(event) => {
             if (event.nativeEvent.isComposing || event.keyCode === 229) return
             if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) }
           }}>
        <div className="file-mention__header">
          <strong id={`${id}-title`}>{t('chat.fileMentionTitle')}</strong>
          <button type="button" className="ghost" aria-label={t('common.close')} onClick={() => onClose(true)}>×</button>
        </div>
        <div className="file-mention__nav">
          <button type="button" className="ghost" disabled={!path} aria-label={t('chat.fileMentionBack')}
                  title={t('chat.fileMentionBack')} onClick={() => navigate(path.split('/').slice(0, -1).join('/'))}>↑</button>
          <button type="button" className="ghost file-mention__root" onClick={() => navigate('')}
                  title={t('chat.fileMentionRoot')}>{projectName}</button>
        </div>
        <div className="file-mention__path" aria-label={t('chat.fileMentionLocation')}>{path ? `./${path}` : './'}</div>
        <div className="file-mention__search">
          <input ref={input} value={query} maxLength={256} className="mention-menu__search"
                 aria-label={t('chat.fileMentionSearch')} aria-controls={`${id}-list`}
                 placeholder={t('chat.fileMentionSearch')} autoComplete="off" spellCheck={false}
                 onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
                 onChange={event => { setQuery(event.target.value); setOffset(0) }}
                 onKeyDown={event => {
                   if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return
                   if (event.key === 'ArrowDown' && ready) { event.preventDefault(); list.current?.querySelector<HTMLElement>('.file-mention__item')?.focus() }
                   if (event.key === 'Enter') {
                     event.preventDefault()
                     if (ready && current?.entries[0]) choose(current.entries[0])
                     else submitSearch.current()
                   }
                 }} />
          {query && <button type="button" className="ghost" aria-label={t('chat.fileMentionClear')}
                            onClick={() => { setQuery(''); setOffset(0); input.current?.focus() }}>×</button>}
        </div>
        <div className="file-mention__results" aria-busy={loading}>
          {loading && visibleEntries.length === 0 && <div className="mention-menu__empty" role="status">{t('chat.fileMentionLoading')}</div>}
          {error && <div className="file-mention__error" role="alert">
            <span>{errorText}</span>
            <button type="button" className="ghost" onClick={() => setRetry(value => value + 1)}>{t('chat.fileMentionRetry')}</button>
          </div>}
          {ready && current.entries.length === 0 && <div className="mention-menu__empty" role="status">
            {t(query ? 'chat.fileMentionNoMatch' : 'chat.fileMentionEmpty')}
          </div>}
          <ul ref={list} id={`${id}-list`} className="file-mention__list" aria-label={t('chat.fileMentionTitle')}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                // O ⋯ fica fora do percurso das setas: elas andam de item em item.
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.file-mention__item')]
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const next = index + (event.key === 'ArrowDown' ? 1 : -1)
                if (next < 0) input.current?.focus()
                else buttons[Math.min(next, buttons.length - 1)]?.focus()
              }}>
            {visibleEntries.map(entry => <li key={entry.path} className="file-mention__row">
              <button type="button" className="mention-item file-mention__item" disabled={!ready} onClick={() => choose(entry)}
                      onContextMenu={entry.isDir ? undefined : (event) => { event.preventDefault(); openActions(entry, event.clientX, event.clientY, false) }}
                      onKeyDown={entry.isDir ? undefined : (event) => {
                        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                          event.preventDefault(); actionsFromKeyboard(entry, event.currentTarget)
                        }
                      }}>
                <span aria-hidden="true">{entry.isDir ? '📁' : '📄'}</span>
                <span className="file-mention__name">{entry.name}</span>
                <span className="file-mention__kind">{t(entry.isDir ? 'chat.fileMentionFolder' : 'chat.fileMentionFile')}</span>
                {entry.isDir && <span aria-hidden="true">›</span>}
              </button>
              {!entry.isDir && <button type="button" className="ghost file-mention__actions" tabIndex={-1} disabled={!ready}
                      aria-label={t('chat.fileMentionActions', { name: entry.name })} title={t('chat.fileMentionActions', { name: entry.name })}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        openActions(entry, rect.right - 200, rect.bottom, event.detail === 0)
                      }}>⋯</button>}
            </li>)}
          </ul>
          {current?.nextOffset !== null && visibleEntries.length > 0 && !error && <button type="button" className="ghost file-mention__more"
            disabled={!ready} onClick={() => setOffset(current!.nextOffset!)}>
            {t(loading ? 'chat.fileMentionLoading' : 'chat.fileMentionMore')}
          </button>}
        </div>
        <div className="file-mention__hint">{t('chat.fileMentionHint')}</div>
      </div>
    </ViewportPopover>, document.body,
  )
}
