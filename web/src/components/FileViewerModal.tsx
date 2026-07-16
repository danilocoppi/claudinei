import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import type { FileKind } from '../files'
import { fileContentUrl, langOfPath } from '../files'
import { useStore } from '../store'
import type { Components } from 'react-markdown'
import { MarkdownPre } from './MarkdownPre'

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
        data-testid="file-viewer-panel"
        style={{
          // Quase tela cheia e SEM transparência/blur: leitura em primeiro lugar
          // (o glass deixava o chat vazar por trás do texto).
          width: 'calc(100vw - 40px)', height: 'calc(100vh - 40px)',
          background: '#12141d', border: '1px solid var(--glass-border)',
          borderRadius: 16, padding: 0, cursor: 'default', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,.55)',
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
          <button
            type="button" className="ghost" aria-label={t('fileViewer.close')} title={t('fileViewer.close')}
            onClick={closeFile}
            style={{ flex: 'none', padding: '7px 10px' }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
          <FileBody kind={kind} url={url} name={name} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Corpo do preview por tipo — compartilhado entre o modal e o painel inline
 * (InlineFileView). `compact`: dentro do painel dockado, o PDF não pode exigir
 * 70vh de altura mínima (o painel tem ~40vh). */
export function FileBody({ kind, url, name, compact }: { kind: FileKind; url: string; name: string; compact?: boolean }) {
  const { t } = useTranslation()

  if (kind === 'image') {
    return <img src={url} alt={name} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />
  }
  if (kind === 'pdf') {
    return <iframe src={url} title="pdf" style={{ width: '100%', height: '100%', minHeight: compact ? 220 : '70vh', border: 0, borderRadius: 8 }} />
  }
  if (kind === 'binary') {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px 0' }}>
        <p>{t('fileViewer.noPreview')}</p>
        <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
      </div>
    )
  }
  return <TextBody kind={kind} url={url} name={name} />
}

type TextState =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'ok'; text: string }

function TextBody({ kind, url, name }: { kind: FileKind; url: string; name: string }) {
  const { t } = useTranslation()
  const openExternalLink = useStore((s) => s.openExternalLink)
  const [state, setState] = useState<TextState>({ status: 'loading' })
  // Links do markdown visualizado também passam pela confirmação de link externo.
  const mdComponents: Components = {
    pre: MarkdownPre,
    a: ({ href, children }) => (
      href && !href.startsWith('#')
        ? <a href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternalLink(href) }}>{children}</a>
        : <a href={href}>{children}</a>
    ),
  }

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
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
          {state.text}
        </ReactMarkdown>
      </div>
    )
  }

  // Código: colore com o MESMO pipeline do chat (fence markdown → rehypeHighlight,
  // sem innerHTML). Fence maior que qualquer sequência de ``` do arquivo (não
  // quebra em arquivos que contêm markdown); cap de 300KB — acima disso o
  // highlight travaria a UI e cai no <pre> puro.
  const lang = kind === 'code' ? langOfPath(name) : null
  if (lang && state.text.length <= 300_000) {
    const runs = state.text.match(/`{3,}/g)
    const fence = '`'.repeat(Math.max(3, ...(runs?.map((r) => r.length + 1) ?? [0])))
    return (
      <div className="markdown code-preview" style={{ lineHeight: 1.55 }}>
        <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={{ pre: MarkdownPre }}>
          {`${fence}${lang}\n${state.text}\n${fence}`}
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
