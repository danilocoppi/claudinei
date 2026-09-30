import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { visualHtml } from '../editor/html-visual'

/** Same-origin ONLY while scripts are disabled by both sandbox and CSP. Never
 * add allow-scripts here: the interactive preview uses a separate opaque frame.
 * https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe */
export function HtmlVisualEditor({ value, baseUrl, name, compact, onChange, onSave }: {
  value: string; baseUrl?: string; name: string; compact?: boolean
  onChange: (value: string) => void; onSave: () => void
}) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }
  const last = useRef(value)
  const [model, setModel] = useState(() => visualHtml(value, baseUrl))
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState<Record<string, boolean>>({})
  const selection = useRef<Range | null>(null)
  const cleanup = useRef<() => void>(() => {})

  // Local typing must never reload the iframe (cursor, scroll and undo history).
  // A reload after a conflict, or a change from Source, replaces the document.
  useEffect(() => {
    if (last.current === value) return
    last.current = value
    setReady(false)
    selection.current = null
    setModel(visualHtml(value, baseUrl))
  }, [value, baseUrl])
  useEffect(() => () => cleanup.current(), [])

  const changed = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const next = model.read(doc)
    last.current = next
    callbacks.current.onChange(next)
  }
  const loaded = () => {
    cleanup.current()
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    doc.designMode = 'on'
    const remember = () => {
      const current = doc.getSelection()
      if (current?.rangeCount) selection.current = current.getRangeAt(0).cloneRange()
      setActive(Object.fromEntries(['bold', 'italic', 'underline'].map(command => [command, doc.queryCommandState(command)])))
    }
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
        event.preventDefault()
        changed()
        callbacks.current.onSave()
      }
    }
    const noNavigation = (event: Event) => event.preventDefault()
    // Pasting HTML from elsewhere can carry layout, embeds and tracking URLs.
    // Paste text; the original document and toolbar own formatting.
    const paste = (event: ClipboardEvent) => {
      event.preventDefault()
      doc.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '')
      changed()
    }
    doc.addEventListener('input', changed)
    doc.addEventListener('selectionchange', remember)
    doc.addEventListener('keydown', key)
    doc.addEventListener('click', noNavigation)
    doc.addEventListener('submit', noNavigation)
    doc.addEventListener('drop', noNavigation)
    doc.addEventListener('paste', paste)
    cleanup.current = () => {
      doc.removeEventListener('input', changed)
      doc.removeEventListener('selectionchange', remember)
      doc.removeEventListener('keydown', key)
      doc.removeEventListener('click', noNavigation)
      doc.removeEventListener('submit', noNavigation)
      doc.removeEventListener('drop', noNavigation)
      doc.removeEventListener('paste', paste)
    }
    setReady(true)
    frame.current?.contentWindow?.focus()
  }
  const format = (command: string) => {
    const doc = frame.current?.contentDocument
    if (!doc || !ready) return
    frame.current?.contentWindow?.focus()
    if (selection.current) {
      const current = doc.getSelection()
      current?.removeAllRanges()
      current?.addRange(selection.current)
    }
    // execCommand preserves native undo, unlike replacing the selected DOM.
    // https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
    doc.execCommand(command)
    setActive(Object.fromEntries(['bold', 'italic', 'underline'].map(action => [action, doc.queryCommandState(action)])))
    changed()
  }
  const actions = [
    ['bold', 'bold', 'B'], ['italic', 'italic', 'I'], ['underline', 'underline', 'U'],
    ['insertUnorderedList', 'bulletList', '• ≡'], ['insertOrderedList', 'numberedList', '1. ≡'],
    ['undo', 'undo', '↶'], ['redo', 'redo', '↷'],
  ] as const
  return <div className="html-editor">
    <div className="html-editor__tools" role="group" aria-label={t('fileViewer.formatting')}>
      {actions.map(([command, label, icon]) => <button key={command} type="button" className="ghost"
        disabled={!ready} aria-label={t(`fileViewer.${label}`)} title={t(`fileViewer.${label}`)}
        aria-pressed={['bold', 'italic', 'underline'].includes(command) ? !!active[command] : undefined}
        onMouseDown={(event) => event.preventDefault()} onClick={() => format(command)}>
        <span aria-hidden="true" className={`html-editor__${command}`}>{icon}</span>
      </button>)}
    </div>
    <p className="html-editor__hint">{t('fileViewer.visualHint')}</p>
    {!ready && <div role="status">{t('fileViewer.loading')}</div>}
    <iframe ref={frame} title={t('fileViewer.visualTitle', { name })} srcDoc={model.srcDoc}
      sandbox="allow-same-origin" className="html-view__frame" onLoad={loaded}
      style={{ minHeight: compact ? 0 : '60vh' }} />
  </div>
}
