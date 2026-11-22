import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { pageListSettled, usePagesStore, type PagePlace } from '../pages/pagesStore'
import { viewPage } from '../pages/api'
import { PAGE_HEIGHT_MESSAGE, type VisualPageDto } from '../../../shared/visual-pages'
import { PageUrlStatus, usePageUrl } from './PageFullscreen'
import { chatFollow } from '../chat/listHandle'
import '../pages/pages.css'

/** Altura de quem não sugeriu nenhuma. */
const DEFAULT_HEIGHT = 360
const MIN_HEIGHT = 120

/** De 120 px a 70% da janela; acima disso a página rola por dentro. */
function clampHeight(h: number): number {
  const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.7))
  return Math.round(Math.min(Math.max(h, MIN_HEIGHT), max))
}

/**
 * A altura que o script injetado manda (`{ type: PAGE_HEIGHT_MESSAGE, height }`),
 * já limitada, ou null se a mensagem não serve: outro tipo, altura que não é
 * número finito (string, NaN, Infinity) ou negativa.
 */
function heightOf(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const { type, height } = data as { type?: unknown; height?: unknown }
  if (type !== PAGE_HEIGHT_MESSAGE || typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null
  return clampHeight(height)
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

/**
 * Se o cartão está na tela. Só observa enquanto `active` (a página viva): as
 * paradas não pagam observer nenhum. Fora de `active`, ou antes do primeiro
 * aviso, conta como fora — o iframe só monta depois que o observer confirmar.
 * A margem da lista virtual (600 px) não conta: o observer é da janela.
 */
function useOnScreen(ref: RefObject<Element>, active: boolean): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) { setOn(false); return }
    if (typeof IntersectionObserver === 'undefined') { setOn(true); return }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === el) setOn(entry.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, active])
  return on
}

/**
 * O iframe da página viva. Monta com token novo (cada montagem pede o seu) e
 * aceita a altura só do próprio iframe (`event.source`). Enquanto o endereço
 * não vem, guarda o lugar com a mesma altura.
 */
function LiveFrame({ page, height, onHeight }: { page: VisualPageDto; height: number; onHeight(h: number): void }) {
  const { state, retry } = usePageUrl(page.id)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const own = frame.current?.contentWindow
      if (!own || e.source !== own) return
      const h = heightOf(e.data)
      if (h !== null) onHeight(h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onHeight])

  if (state.kind === 'ready') {
    // sandbox só com scripts (origem opaca), sem `allow` e nunca `srcdoc`, que herdaria a CSP do app.
    return <iframe ref={frame} className="page-card__frame" src={state.url} title={page.title}
                   sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ height }} />
  }
  if (state.kind === 'loading') return <div className="page-card__slot" style={{ height }} />
  return <PageUrlStatus state={state} retry={retry} />
}

/**
 * Uma página publicada pelo agente, na conversa. Parada: uma linha com título,
 * tamanho e "Ver página". Viva (`livePageId`, uma por vez): o iframe, montado
 * só com o cartão na tela; saiu da tela, desmonta; voltou e ainda é a viva,
 * monta de novo com token novo. Sem o DTO, busca pelo id.
 *
 * `localId`: o terminal da conversa em que o cartão está.
 * `page`: o DTO, quando quem desenha já o tem (as ancoradas no turno).
 * `place`: onde o cartão está, o chat (padrão) ou a lista "Páginas desta
 * conversa"; a viva só abre no lugar em que foi aberta.
 */
export function PageCard({ pageId, localId, page: given, place = 'chat' }: {
  pageId: string; localId: string; page?: VisualPageDto; place?: PagePlace
}) {
  const { t } = useTranslation()
  const stored = usePagesStore(s => s.byId[pageId])
  const live = usePagesStore(s => s.livePageId === pageId && s.livePlace === place)
  const page = given ?? (typeof stored === 'object' ? stored : undefined)
  const root = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(root, live && !!page)
  // Altura vinda da página; fica entre montagens para a volta à tela não pular.
  const [reported, setReported] = useState<number | null>(null)
  const [tabError, setTabError] = useState<'deleted' | 'failed' | null>(null)

  // Sem DTO (id fora da lista da conversa): busca pelo id. 403/404 viram
  // 'unavailable' no store; outra falha fica aqui, com "tentar de novo".
  // Antes espera a lista da conversa, se está chegando: ao abrir a conversa, o
  // cartão monta junto e a lista quase sempre traz a página. A espera começa
  // depois da vez (microtarefa): o efeito que pede a lista é do ChatView, que
  // roda depois dos efeitos dos filhos.
  const missing = !page && stored === undefined
  const [fetchFailed, setFetchFailed] = useState(false)
  const [fetchAttempt, setFetchAttempt] = useState(0)
  useEffect(() => {
    if (!missing) return
    let alive = true
    setFetchFailed(false)
    Promise.resolve()
      .then(() => pageListSettled(localId))
      .then(() => {
        if (!alive || usePagesStore.getState().byId[pageId] !== undefined) return
        return usePagesStore.getState().fetchOne(pageId)
      })
      .catch((e) => {
        console.warn('[páginas] a página não veio', pageId, e)
        if (alive) setFetchFailed(true)
      })
    return () => { alive = false }
  }, [missing, pageId, localId, fetchAttempt])

  const onHeight = useCallback((h: number) => setReported(h), [])
  const height = page ? reported ?? clampHeight(page.height ?? DEFAULT_HEIGHT) : null

  // A viva do chat que cresce (a altura que a página manda) avisa o chat, que
  // puxa a tela se ela estava presa no fim. Depois do layout, antes da pintura:
  // a tela não chega a aparecer fora do fim. A primeira altura de cada abertura
  // é só a de partida; encolher não puxa.
  const lastHeight = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (!live || place !== 'chat' || height === null) { lastHeight.current = null; return }
    const prev = lastHeight.current
    lastHeight.current = height
    if (prev !== null && height > prev) chatFollow.grew(height - prev)
  }, [live, place, height])

  if (!page) {
    return (
      <div ref={root} className="page-card" data-page-id={pageId} data-local-id={localId}>
        <div className="page-card__bar">
          {stored === 'unavailable'
            ? <span className="page-card__note">{t('pages.unavailable')}</span>
            : fetchFailed
              ? <button type="button" className="page-card__btn" onClick={() => setFetchAttempt(n => n + 1)}>{t('pages.loadFailed')}</button>
              : <span className="page-card__note">{t('pages.loading')}</span>}
        </div>
      </div>
    )
  }

  const { setLive, setFull } = usePagesStore.getState()
  // A tela cheia fica fora da lista virtual (`PageFullscreenHost`) e tem o
  // próprio iframe: o cartão deixa de ser o vivo (o store solta).
  const openFull = () => setFull(page.id)
  const openTab = async () => {
    try {
      const { url } = await viewPage(page.id)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTabError(null)
    } catch (e) {
      console.warn('[páginas] a nova aba não abriu', page.id, e)
      setTabError(statusOf(e) === 404 ? 'deleted' : 'failed')
    }
  }
  const kb = Math.max(1, Math.round(page.bytes / 1024))
  const title = <span className="page-card__title" title={page.title}>{page.title}</span>

  return (
    <div ref={root} className={live ? 'page-card page-card--live' : 'page-card'} data-page-id={pageId} data-local-id={localId}>
      {live ? (
        <>
          <div className="page-card__bar">
            <span className="page-card__icon" aria-hidden="true">▦</span>
            {title}
            {tabError === 'deleted' && <span className="page-card__size">{t('pages.deleted')}</span>}
            {tabError === 'failed' && <button type="button" className="page-card__btn" onClick={openTab}>{t('pages.loadFailed')}</button>}
            <button type="button" className="page-card__btn" onClick={openFull}>{t('pages.fullscreen')}</button>
            <button type="button" className="page-card__btn" onClick={openTab}>{t('pages.newTab')}</button>
            <button type="button" className="page-card__btn" onClick={() => setLive(null)}>{t('pages.close')}</button>
          </div>
          {onScreen
            ? <LiveFrame page={page} height={height!} onHeight={onHeight} />
            : <div className="page-card__slot" style={{ height: height! }} />}
        </>
      ) : (
        <div className="page-card__bar">
          <span className="page-card__icon" aria-hidden="true">▦</span>
          {title}
          <span className="page-card__size">{t('pages.size', { kb })}</span>
          <button type="button" className="page-card__btn" onClick={() => setLive(page.id, place)}>{t('pages.view')}</button>
        </div>
      )}
    </div>
  )
}
