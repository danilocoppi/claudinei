import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import type { FileKind } from '../files'
import { fileContentUrl } from '../files'
import { useStore } from '../store'

/** Modal de preview de arquivo (por tipo), aberto via `store.openFile`. Sem props:
 * lê `fileViewer` direto do store, então pode ser montado uma única vez (App.tsx)
 * e fica inerte (retorna null) enquanto não há arquivo aberto. */
export function FileViewerModal() {
  const fileViewer = useStore((s) => s.fileViewer)
  const closeFile = useStore((s) => s.closeFile)
  const { t } = useTranslation()

  useEffect(() => {
    if (!fileViewer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFile() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileViewer, closeFile])

  if (!fileViewer) return null
  const { path, kind, projectId } = fileViewer
  const url = fileContentUrl(path, projectId)
  const name = path.split('/').pop() || path

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeFile() }}>
      <div
        className="glass"
        style={{
          width: 720, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)',
          borderRadius: 16, padding: 0, cursor: 'default', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px',
          borderBottom: '1px solid var(--glass-border)', flex: 'none',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {path}
            </div>
          </div>
          <a href={url} download className="ghost" style={{
            display: 'inline-flex', alignItems: 'center', padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--glass-border)', color: 'var(--text)', textDecoration: 'none', fontSize: 13, flex: 'none',
          }}>
            {t('fileViewer.download')}
          </a>
          <button
            type="button" className="ghost" aria-label={t('fileViewer.close')} title={t('fileViewer.close')}
            onClick={closeFile}
            style={{ flex: 'none', padding: '7px 10px' }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 18, overflow: 'auto' }}>
          <FileBody kind={kind} url={url} name={name} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FileBody({ kind, url, name }: { kind: FileKind; url: string; name: string }) {
  const { t } = useTranslation()

  if (kind === 'image') {
    return <img src={url} alt={name} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />
  }
  if (kind === 'pdf') {
    return <iframe src={url} title="pdf" style={{ width: '100%', height: '70vh', border: 0, borderRadius: 8 }} />
  }
  if (kind === 'binary') {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px 0' }}>
        <p>{t('fileViewer.noPreview')}</p>
        <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
      </div>
    )
  }
  return <TextBody kind={kind} url={url} />
}

type TextState =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'ok'; text: string }

function TextBody({ kind, url }: { kind: FileKind; url: string }) {
  const { t } = useTranslation()
  const [state, setState] = useState<TextState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetch(url)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) { setState({ status: 'error', code: res.status }); return }
        const text = await res.text()
        if (cancelled) return
        setState({ status: 'ok', text })
      })
      .catch(() => { if (!cancelled) setState({ status: 'error', code: 0 }) })
    return () => { cancelled = true }
  }, [url])

  if (state.status === 'loading') {
    return <div style={{ color: 'var(--text-dim)' }}>{t('fileViewer.loading')}</div>
  }

  if (state.status === 'error') {
    if (state.code === 403) return <div style={{ color: 'var(--err)' }}>{t('fileViewer.forbidden')}</div>
    if (state.code === 413) {
      return (
        <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
          <p>{t('fileViewer.tooLarge')}</p>
          <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
        </div>
      )
    }
    // 404 e qualquer outro erro (0 = falha de rede) caem no mesmo aviso genérico.
    return <div style={{ color: 'var(--err)' }}>{t('fileViewer.notFound')}</div>
  }

  if (kind === 'markdown') {
    return (
      <div className="markdown" style={{ lineHeight: 1.6 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {state.text}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'monospace', fontSize: 13 }}>
      {state.text}
    </pre>
  )
}
