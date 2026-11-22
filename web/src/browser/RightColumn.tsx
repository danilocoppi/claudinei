import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { progressKey, useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import type { SessionStatus } from '../types'
import { ProgressColumn } from '../components/ProgressColumn'
import { SideColumn } from '../components/SideColumn'
import { useBrowserStore } from './browserStore'
import { useColumnStore, useEffectiveView } from './columnStore'
import { columnWidth, tabsFor } from './columnModel'
import { ColumnResizer } from './ColumnResizer'
import { BrowserColumn } from './BrowserColumn'

type Props = { projectId: number; engine: string; localId: string; sessionStatus?: SessionStatus }

/**
 * A última lateral vista de cada terminal (o `info.id`, ou null sem lateral),
 * fora do componente: voltar do painel ao chat remonta a coluna, e a lateral
 * que já estava lá não "nasce" de novo.
 */
const seenSide = new Map<string, string | null>()

/**
 * A lateral do terminal nasceu (null → id) ou sumiu (id → null): ela toma a
 * coluna, e ao sumir volta a vista de antes. Trocar de terminal não conta: o
 * operador vai a outro terminal, não a outra vista.
 *
 * Só vale o que já foi lido nesta conexão (`readAt` do sideStore igual ao
 * `progressEpoch`). Antes disso, "sem lateral" no store quer dizer "ainda não
 * lido": a lateral que o terminal já tinha, trazida pela leitura depois de
 * trocar de terminal, não é nascida. Por isso a troca para um terminal não lido
 * esquece a última lateral vista dele, e a leitura só a anota.
 */
function useSideTakesColumn(key: string): void {
  const sideId = useSideStore((s) => s.sides[key]?.info.id ?? null)
  const epoch = useStore((s) => s.progressEpoch)
  const known = useSideStore((s) => s.readAt[key] === epoch)
  const lastKey = useRef<string | null>(null)
  useLayoutEffect(() => {
    const switched = lastKey.current !== null && lastKey.current !== key
    lastKey.current = key
    if (!known) {
      if (switched) seenSide.delete(key)
      return
    }
    const before = seenSide.get(key)
    seenSide.set(key, sideId)
    if (switched || before === undefined || before === sideId) return
    if (sideId && !before) useColumnStore.getState().sideBorn()
    else if (!sideId && before) useColumnStore.getState().sideGone()
  }, [key, sideId, known])
}

/**
 * A largura do `.chat-layout` (a área do chat com a coluna), medida ao montar e
 * quando ela muda (janela, lista de terminais alargada). Alargar a coluna não a
 * muda: a área é a do pai.
 */
function useArea(ref: React.RefObject<HTMLElement>, active: boolean): number {
  const [area, setArea] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current?.parentElement
    if (!active || !el) return
    const measure = () => setArea(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active, ref])
  return area
}

/**
 * A coluna da direita do chat: as abas de texto das vistas que existem, o
 * puxador, a tela cheia, o fechar e a vista (Acompanhamento, Lateral ou
 * Navegador). Sem transição nem animação (frontend sem GPU): a marca da aba é
 * estática.
 */
export function RightColumn({ projectId, engine, localId, sessionStatus }: Props) {
  const { t } = useTranslation()
  const key = progressKey(projectId, engine)
  useSideTakesColumn(key)
  const view = useEffectiveView(projectId, engine)
  const hasSide = useSideStore((s) => !!s.sides[key])
  const hasBrowser = useBrowserStore((s) => !!s.tabs[key] || !!s.failed[key])
  const fullscreen = useColumnStore((s) => s.fullscreen)
  const marked = useColumnStore((s) => s.marks[key])
  const stored = useColumnStore((s) => (view ? s.widths[view] : undefined))
  const ref = useRef<HTMLElement>(null)
  const area = useArea(ref, view !== null)
  /** A largura durante o arrasto, ainda sem gravar. */
  const [live, setLive] = useState<number | null>(null)
  useEffect(() => { setLive(null) }, [view])
  // A vista num elemento guardado: o arrasto do puxador redesenha a coluna a cada
  // `pointermove` (a largura), e o React pula a vista inteira quando o elemento é o mesmo.
  const body = useMemo(() => (
    view === 'progress' ? <ProgressColumn projectId={projectId} engine={engine} sessionStatus={sessionStatus} />
      : view === 'side' ? <SideColumn projectId={projectId} engine={engine} localId={localId} />
        : view === 'browser' ? <BrowserColumn key={key} projectId={projectId} engine={engine} />
          : null
  ), [view, projectId, engine, localId, sessionStatus, key])

  if (!view) return null
  const width = live ?? columnWidth(view, stored, area)
  const fit = (px: number) => columnWidth(view, px, ref.current?.parentElement?.clientWidth ?? area)
  const { selectView, closeColumn, toggleFullscreen, setWidth } = useColumnStore.getState()

  return (
    <aside ref={ref} className={`right-column${fullscreen ? ' right-column--full' : ''}`} data-view={view}
           style={fullscreen ? undefined : { width }} aria-label={t('browser.column.label')}>
      {!fullscreen && (
        <ColumnResizer width={width} onMove={(px) => setLive(fit(px))}
                       onCommit={(px) => { setWidth(view, fit(px)); setLive(null) }} />
      )}
      <div className="right-column__bar">
        <div className="right-column__tabs" role="tablist">
          {tabsFor({ side: hasSide, browser: hasBrowser }).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={v === view}
                    className={`right-column__tab${v === view ? ' right-column__tab--on' : ''}`}
                    onClick={() => selectView(v)}>
              {t(`browser.column.tabs.${v}`)}
              {marked?.includes(v) && v !== view && (
                <span className="right-column__mark" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
        <button type="button" className="ghost right-column__btn" aria-pressed={fullscreen}
                aria-label={fullscreen ? t('browser.column.exitFullscreen') : t('browser.column.fullscreen')}
                title={fullscreen ? t('browser.column.exitFullscreen') : t('browser.column.fullscreen')}
                onClick={toggleFullscreen}>
          {fullscreen ? '⤡' : '⤢'}
        </button>
        {/* Na Lateral, o × logo abaixo (o da conversa) encerra a lateral: dois × lado a
            lado confundiriam. Ali a coluna fecha pela aba Acompanhamento (ou pelo botão do cabeçalho). */}
        {view !== 'side' && (
          <button type="button" className="ghost right-column__btn" aria-label={t('browser.column.close')}
                  title={t('browser.column.close')} onClick={closeColumn}>×</button>
        )}
      </div>
      <div className="right-column__view">{body}</div>
    </aside>
  )
}
