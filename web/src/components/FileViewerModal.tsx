import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import 'highlight.js/styles/github-dark.css'
import type { FileKind } from '../files'
import { createFilePreview, fileContentUrl, isHtmlPath } from '../files'
import { useStore } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
import { TextDocument } from './TextDocument'

/** Modal de preview de arquivo (por tipo), aberto via `store.openFile`. Sem props:
 * lê `fileViewer` direto do store, então pode ser montado uma única vez (App.tsx)
 * e fica inerte (retorna null) enquanto não há arquivo aberto. */
export function FileViewerModal() {
  const fileViewer = useStore((s) => s.fileViewer)
  const closeFile = useStore((s) => s.closeFile)
  const sujo = useStore((s) => s.fileEditDirty)
  const [confirmando, setConfirmando] = useState(false)
  const { t } = useTranslation()

  // Fechar com edição pendente jogaria fora o que o operador escreveu, sem
  // aviso e sem desfazer — o editor não guarda rascunho em lugar nenhum.
  const tentarFechar = () => { if (sujo) setConfirmando(true); else closeFile() }

  useEffect(() => {
    if (!fileViewer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') tentarFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileViewer, closeFile, sujo])

  if (!fileViewer) return null
  const { path, kind, projectId } = fileViewer
  const url = fileContentUrl(path, projectId)
  const name = path.split('/').pop() || path

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) tentarFechar() }}>
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
            onClick={tentarFechar}
            style={{ flex: 'none', padding: '7px 10px' }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
          <FileBody kind={kind} url={url} name={name} path={path} projectId={projectId} />
        </div>
      </div>
      {confirmando && (
        <ConfirmDialog
          title={t('fileViewer.discardTitle')}
          message={t('fileViewer.discardBody')}
          confirmLabel={t('fileViewer.discard')}
          onConfirm={() => { setConfirmando(false); closeFile() }}
          onClose={() => setConfirmando(false)}
        />
      )}
    </div>,
    document.body,
  )
}

/** Corpo do preview por tipo — compartilhado entre o modal e o painel inline
 * (InlineFileView). `compact`: dentro do painel dockado, o PDF não pode exigir
 * 70vh de altura mínima (o painel tem ~40vh). */
export function FileBody({ kind, url, name, compact, path, projectId }: {
  kind: FileKind; url: string; name: string; compact?: boolean; path?: string; projectId?: number
}) {
  const { t } = useTranslation()

  // HTML: o fonte sozinho não responde "como ficou a página".
  if (kind === 'code' && path && isHtmlPath(name)) {
    return <HtmlBody key={`${projectId}:${path}`} url={url} name={name} path={path} projectId={projectId} compact={compact} />
  }

  if (kind === 'image') {
    return <img src={url} alt={name} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />
  }
  if (kind === 'pdf') {
    // No painel inline quem dá a altura é o painel (que o operador redimensiona);
    // no popup, o PDF garante uma área de leitura mínima.
    const dimensao = compact ? { flex: 1, minHeight: 0 } : { height: '100%', minHeight: '70vh' }
    return <iframe src={url} title="pdf" style={{ width: '100%', border: 0, borderRadius: 8, ...dimensao }} />
  }
  if (kind === 'binary') {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px 0' }}>
        <p>{t('fileViewer.noPreview')}</p>
        <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
      </div>
    )
  }
  return <TextDocument key={`${projectId}:${path}`} kind={kind} url={url} name={name} path={path ?? name} projectId={projectId} />
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; url: string; channel?: string }

/**
 * As duas leituras de um HTML, com a página por padrão — quem abre um `.html`
 * quer ver o que ele virou; o fonte fica a um clique.
 *
 * A página vai para um iframe `sandbox` SEM `allow-same-origin`. Isso é o que
 * separa "ver um arquivo" de "executá-lo dentro do Claudinei": na origem opaca o
 * script da página não enxerga o cookie de sessão, o storage nem o documento de
 * fora, e a API que roda comandos fica fora do alcance. `allow-scripts` fica
 * porque página de verdade usa script (a galeria que motivou isto monta as
 * imagens em JS) — e sem same-origin ele continua preso.
 *
 * O iframe fica MONTADO enquanto se olha o fonte, só escondido: remontar
 * recarregaria a página do zero e jogaria fora rolagem e estado interno dela.
 */
function HtmlBody({ url, name, path, projectId, compact }: {
  url: string; name: string; path: string; projectId?: number; compact?: boolean
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'page' | 'source'>('page')
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' })
  const previewRequest = useRef(0)
  const frame = useRef<HTMLIFrameElement>(null)

  const recarregarPagina = () => {
    const request = ++previewRequest.current
    createFilePreview(path, projectId, true)
      .then((r) => { if (request === previewRequest.current) setPreview({ status: 'ok', ...r }) })
      .catch(() => { if (request === previewRequest.current) setPreview({ status: 'error' }) })
  }

  useEffect(() => {
    setView('page')
    setPreview({ status: 'loading' })
    recarregarPagina()
    return () => { previewRequest.current++ }
  }, [path, projectId])

  const aba = (qual: 'page' | 'source', rotulo: string) => (
    <button
      type="button" className="html-view__tab" aria-pressed={view === qual}
      onClick={() => setView(qual)}
    >
      {rotulo}
    </button>
  )

  return (
    <div className="html-view">
      <div className="html-view__tabs">
        {aba('page', t('fileViewer.tabPage'))}
        {aba('source', t('fileViewer.tabSource'))}
      </div>
      <TextDocument
        kind="code" url={url} name={name} path={path} projectId={projectId} onSaved={recarregarPagina}
        html={{ view, baseUrl: preview.status === 'ok' ? preview.url : undefined,
          channel: preview.status === 'ok' ? preview.channel : undefined, frame, compact, preview: <>
          {preview.status === 'ok' && (
            <iframe ref={frame} key={preview.url} src={preview.url} title={name} sandbox="allow-scripts"
              className="html-view__frame" style={{ minHeight: compact ? 0 : '70vh' }} />
          )}
          {preview.status === 'loading' && <div role="status">{t('fileViewer.loading')}</div>}
          {preview.status === 'error' && <div className="text-document__alert" role="alert">
            {t('fileViewer.previewFailed')}
            <button type="button" className="ghost" onClick={recarregarPagina}>{t('fileViewer.reload')}</button>
          </div>}
        </> }}
      />
    </div>
  )
}
