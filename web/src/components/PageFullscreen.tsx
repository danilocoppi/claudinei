import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { viewPage } from '../pages/api'
import type { VisualPageDto } from '../../../shared/visual-pages'
import '../pages/pages.css'

/** O endereço da página para um iframe: pedido de novo a cada montagem (token novo, 10 min). */
export type PageUrlState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'deleted' }
  | { kind: 'failed' }

/**
 * Pede um token novo ao montar e a cada `retry`. 404 é página apagada; o resto
 * é falha que se tenta de novo. Resposta de um pedido antigo não sobrescreve.
 */
export function usePageUrl(id: string): { state: PageUrlState; retry(): void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PageUrlState>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    viewPage(id).then(
      ({ url }) => { if (alive) setState({ kind: 'ready', url }) },
      (e) => {
        if (!alive) return
        const status = (e as { status?: number } | null)?.status
        if (status !== 404) console.warn('[páginas] o endereço da página não veio', id, e)
        setState({ kind: status === 404 ? 'deleted' : 'failed' })
      },
    )
    return () => { alive = false }
  }, [id, attempt])
  const retry = useCallback(() => setAttempt(n => n + 1), [])
  return { state, retry }
}

/** "Página apagada", ou "Não carregou — tentar de novo" (o botão pede outro token), ou "Carregando…". */
export function PageUrlStatus({ state, retry }: { state: PageUrlState; retry(): void }) {
  const { t } = useTranslation()
  if (state.kind === 'deleted') return <div className="page-card__status" role="status">{t('pages.deleted')}</div>
  if (state.kind === 'failed') {
    return (
      <div className="page-card__status">
        <button type="button" className="page-card__btn" onClick={retry}>{t('pages.loadFailed')}</button>
      </div>
    )
  }
  return <div className="page-card__status">{t('pages.loading')}</div>
}

/**
 * A página quase em tela cheia: o invólucro do `FileViewerModal`
 * (`calc(100vw - 40px)` × `calc(100vh - 40px)`), sem desfoque, com token
 * próprio. Esc, o ✕ ou um clique fora fecham.
 */
export function PageFullscreen({ page, onClose }: { page: VisualPageDto; onClose(): void }) {
  const { t } = useTranslation()
  const { state, retry } = usePageUrl(page.id)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div className="page-card-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="page-card-full" role="dialog" aria-modal="true" aria-label={page.title}>
        <div className="page-card-full__bar">
          <div className="page-card-full__title" title={page.title}>{page.title}</div>
          <button
            type="button" className="ghost page-card-full__close" autoFocus
            aria-label={t('pages.closeFullscreen')} title={t('pages.closeFullscreen')} onClick={onClose}
          >
            ✕
          </button>
        </div>
        {state.kind === 'ready'
          ? <iframe className="page-card-full__frame" src={state.url} title={page.title}
                    sandbox="allow-scripts" referrerPolicy="no-referrer" />
          : <PageUrlStatus state={state} retry={retry} />}
      </div>
    </div>,
    document.body,
  )
}
