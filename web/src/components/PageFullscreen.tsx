import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { viewPage } from '../pages/api'
import { usePagesStore } from '../pages/pagesStore'
import { useDialogKeys } from './undo/useDialogKeys'
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
 *
 * Foco e Esc como os diálogos do desfazer (`useDialogKeys`): o foco entra no
 * diálogo, o Tab fica preso nele e, ao fechar, volta para onde estava. O Tab
 * de dentro da página não passa pelo diálogo (é outro documento): quem sai do
 * fim dela cai na guarda logo depois do diálogo, que devolve o foco ao ✕.
 */
export function PageFullscreen({ page, onClose }: { page: VisualPageDto; onClose(): void }) {
  const { t } = useTranslation()
  const { state, retry } = usePageUrl(page.id)
  const dialog = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const onKeyDown = useDialogKeys(dialog, onClose)
  // Depois do `useDialogKeys` (a limpeza dele roda antes desta): quem abriu foi
  // o "Tela cheia" do cartão vivo, que sumiu quando o cartão deixou de ser vivo.
  // Sem para onde voltar, o foco vai ao "Ver página" do cartão dessa página.
  useEffect(() => () => {
    if (document.activeElement && document.activeElement !== document.body) return
    // Compara o atributo em vez de pôr o id no seletor: nada de escapar.
    const card = [...document.querySelectorAll<HTMLElement>('.page-card[data-page-id]')].find(el => el.dataset.pageId === page.id)
    card?.querySelector<HTMLElement>('[data-page-view]')?.focus({ preventScroll: true })
  }, [page.id])

  return createPortal(
    <div className="page-card-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialog} className="page-card-full" role="dialog" aria-modal="true" aria-label={page.title}
           tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="page-card-full__bar">
          <div className="page-card-full__title" title={page.title}>{page.title}</div>
          <button
            ref={closeBtn} type="button" className="ghost page-card-full__close"
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
      <span className="page-card-full__guard" tabIndex={0} data-focus-guard="" onFocus={() => closeBtn.current?.focus()} />
    </div>,
    document.body,
  )
}

const closeFull = () => usePagesStore.getState().setFull(null)

/**
 * A tela cheia da página `fullPageId`, montada uma vez no ChatView, fora da
 * lista virtual: o cartão que a abriu pode desmontar sem fechá-la. Cada
 * abertura monta de novo (token novo).
 */
export function PageFullscreenHost() {
  const page = usePagesStore((s) => {
    const p = s.fullPageId ? s.byId[s.fullPageId] : undefined
    return typeof p === 'object' ? p : undefined
  })
  if (!page) return null
  return <PageFullscreen key={page.id} page={page} onClose={closeFull} />
}
