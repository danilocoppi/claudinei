import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserClientMsg, BrowserStateMsg } from '../../../shared/browser'
import { progressKey } from '../store'
import { closeBrowserTab, openBrowserTab, type BrowserApiError } from './api'
import { connectBrowser } from './browserSocket'
import {
  BROWSER_CLOSED, TAB_CLOSED, clearBrowserFailure, isClosedFailure, setBrowserFailure, setBrowserTab, useBrowserStore,
  type BrowserFailure,
} from './browserStore'
import { useEffectiveView } from './columnStore'
import { BrowserScreen, type FrameSink } from './BrowserScreen'
import { ServersStrip } from './ServersStrip'

type Props = { projectId: number; engine: string }

/** O "Entendi" do aviso de senha, lembrado por navegador. */
const PASSWORD_WARNED_KEY = 'claudinei:browserPasswordWarned'
/** O aviso do servidor para esquema recusado (em inglês, o texto do agente): a tela traduz por igualdade. */
const SCHEME_REFUSED = 'only http:, https: and about:blank URLs are allowed'
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

const readWarned = () => {
  try { return !!localStorage.getItem(PASSWORD_WARNED_KEY) } catch { return false }
}

/**
 * A vista Navegador do terminal. A recusa da última abertura (sem Chromium,
 * por exemplo) mostra o porquê, com "Tentar de novo"; senão, a tela ao vivo
 * pelo socket. A aba que fechou com a vista à mostra (`browser_closed`, ou o
 * `browser_tab` que chegou antes do motivo) fica na tela ao vivo, que mostra
 * "O navegador fechou — Reabrir" ou sai, conforme o motivo.
 */
export function BrowserColumn({ projectId, engine }: Props) {
  const key = progressKey(projectId, engine)
  const failure = useBrowserStore((s) => s.failed[key])
  if (failure && !isClosedFailure(failure)) {
    return (
      <div className="browser-col" data-testid="browser-failure">
        <BrowserFailureNote failure={failure} onRetry={() => reopen(projectId, engine)} />
      </div>
    )
  }
  return <BrowserLive projectId={projectId} engine={engine} />
}

/** Os terminais com um `POST` de reabertura a caminho: um segundo aperto não abre outra. */
const reopening = new Set<string>()

/**
 * Abre a aba de novo (Reabrir, Tentar de novo). Sem trocar a vista: até a
 * resposta, ela continua como está; com erro, a vista mostra o porquê.
 * Devolve true quando a aba abriu.
 */
async function reopen(projectId: number, engine: string): Promise<boolean> {
  const key = progressKey(projectId, engine)
  if (reopening.has(key)) return false
  reopening.add(key)
  try {
    await openBrowserTab(projectId, engine)
    setBrowserTab(key, true)
    return true
  } catch (err) {
    const e = err as BrowserApiError
    setBrowserFailure(key, { code: e.code, message: e.message, hint: e.hint })
    return false
  } finally {
    reopening.delete(key)
  }
}

/**
 * O porquê de não haver tela, no idioma da tela. Sem Chromium, o texto do i18n
 * com o comando de instalação; nos outros casos, a mensagem genérica com o
 * detalhe do servidor. Com `CLAUDINEI_CHROMIUM` apontando arquivo ausente o
 * código é o mesmo, mas a dica é corrigir a variável, não instalar: vai pela genérica.
 */
export function BrowserFailureNote({ failure, onRetry }: { failure: BrowserFailure; onRetry?: () => void }) {
  const { t } = useTranslation()
  const notInstalled = failure.code === 'browser_not_installed' && !!failure.hint && !failure.hint.includes('CLAUDINEI_CHROMIUM')
  return (
    <div className="browser-col__error" role="alert">
      {notInstalled ? (
        <p>{t('browser.column.notInstalled')} <code>{failure.hint}</code></p>
      ) : (
        <>
          <p>{t('browser.column.openFailed')}</p>
          {failure.message && <p>{t('browser.column.failureDetail', { detail: failure.message })}</p>}
          {failure.hint && <code>{failure.hint}</code>}
        </>
      )}
      {onRetry && (
        <p><button type="button" className="ghost browser-col__retry" onClick={onRetry}>{t('browser.retry')}</button></p>
      )}
    </div>
  )
}

/**
 * A tela ao vivo: o socket, o cabeçalho (endereço, voltar, avançar, recarregar,
 * selo do bastão, fechar a aba), o aviso de senha, os servidores, a última ação
 * do agente, os avisos, a tela e o que a cobre (diálogo, página travada,
 * navegador fechado). Sem transição nem animação.
 *
 * Visível = a vista à mostra (coluna aberta nela) e o documento à vista e a
 * tela na vista (`IntersectionObserver`). Desmontar manda `visible: false` e
 * fecha o socket.
 */
function BrowserLive({ projectId, engine }: Props) {
  const { t } = useTranslation()
  const key = progressKey(projectId, engine)
  const failure = useBrowserStore((s) => s.failed[key])
  const active = useEffectiveView(projectId, engine) === 'browser'
  const [st, setSt] = useState<BrowserStateMsg | null>(null)
  /** Muda para reconectar (Reabrir, Tentar de novo). */
  const [gen, setGen] = useState(0)
  /** O servidor recusou a tela (1008): sem reconexão. */
  const [refused, setRefused] = useState(false)
  const [docHidden, setDocHidden] = useState(() => document.hidden)
  const [intersecting, setIntersecting] = useState(true)
  const [warned, setWarned] = useState(readWarned)
  /** O endereço em edição (null: a barra mostra a URL da aba). */
  const [addr, setAddr] = useState<string | null>(null)
  /** O diálogo já respondido (esconde até o próximo `state`). */
  const [answered, setAnswered] = useState<number | null>(null)
  const [promptText, setPromptText] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const connRef = useRef<ReturnType<typeof connectBrowser> | null>(null)
  const frameRef = useRef<FrameSink | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)
  const lastResize = useRef<BrowserClientMsg | null>(null)
  /** O motivo do fechamento da aba, dito pelo socket. */
  const closedReason = useRef<BrowserStateMsg['closed'] | null>(null)

  const send = useCallback((m: BrowserClientMsg) => {
    if (m.type === 'resize') lastResize.current = m
    connRef.current?.send(m)
  }, [])

  /** A raiz da vista ao vivo (o foco do diálogo só sai de dentro dela). */
  const rootRef = useRef<HTMLDivElement>(null)
  /** A capa do diálogo pendente. */
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // O socket da tela; reconecta quando `gen` muda.
  useEffect(() => {
    closedReason.current = null
    setRefused(false)
    const c = connectBrowser(projectId, engine, {
      onState: (s) => {
        setSt(s)
        if (!s.closed) return
        closedReason.current = s.closed
        if (s.closed === 'browser_closed') {
          setBrowserFailure(key, { code: BROWSER_CLOSED, message: '' })
        } else {
          // Fechada de propósito ou por ociosidade: a vista sai.
          clearBrowserFailure(key)
          setBrowserTab(key, false)
        }
      },
      onFrame: (f) => frameRef.current?.(f),
      onClose: (code, retrying) => { if (!retrying && code === 1008) setRefused(true) },
    })
    connRef.current = c
    if (lastResize.current) c.send(lastResize.current)
    return () => {
      releaseRef.current?.()
      c.send({ type: 'visible', visible: false })
      c.close()
      if (connRef.current === c) connRef.current = null
    }
  }, [projectId, engine, key, gen])

  const visible = active && !docHidden && intersecting
  useEffect(() => { connRef.current?.send({ type: 'visible', visible }) }, [visible, gen])

  // O `browser_tab` chegou antes do motivo: com o motivo já sabido, decide; sem ele, espera o socket.
  const failureCode = failure?.code
  useEffect(() => {
    if (failureCode !== TAB_CLOSED) return
    const r = closedReason.current
    if (r === 'browser_closed') setBrowserFailure(key, { code: BROWSER_CLOSED, message: '' })
    else if (r || refused) clearBrowserFailure(key)
  }, [failureCode, key, refused])

  const doReopen = async () => {
    if (busy) return
    setBusy(true)
    const ok = await reopen(projectId, engine)
    setBusy(false)
    if (ok) {
      setSt(null)
      setGen((g) => g + 1)
    }
  }

  const closeTab = () => {
    setCloseError(null)
    closeBrowserTab(projectId, engine)
      .then(() => setBrowserTab(key, false))
      .catch((err: Error) => setCloseError(err.message))
  }

  const onIntersect = useCallback((on: boolean) => setIntersecting(on), [])
  const openUrl = useCallback((url: string) => send({ type: 'navigate', url }), [send])

  const onAddrKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const url = (addr ?? st?.url ?? '').trim()
      if (url) send({ type: 'navigate', url })
      setAddr(null)
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      setAddr(null)
      e.currentTarget.blur()
    }
  }

  const baton = st?.baton
  const you = baton?.kind === 'operator' && baton.you
  const closedShown = isClosedFailure(failure)
  const dialog = st?.dialog && st.dialog.id !== answered ? st.dialog : null
  const vp = st?.viewport ?? DEFAULT_VIEWPORT
  const la = st?.lastAction ?? null
  // A marca muda só com os campos (o `state` chega novo a cada mudança): a tela, com `memo`, não redesenha à toa.
  const mx = la?.point?.x
  const my = la?.point?.y
  const mat = la?.at
  const mark = useMemo(
    () => (mx !== undefined && my !== undefined && mat !== undefined ? { x: mx, y: my, at: mat } : null),
    [mx, my, mat],
  )

  // O diálogo da página chegou: o foco vai ao campo do `prompt` (ou ao OK), senão
  // as teclas iriam à tela, que a página não atende até a resposta. Só quando o
  // foco já estava na vista (ou em lugar nenhum): quem digita no chat não o perde.
  const dialogId = dialog?.id
  useEffect(() => {
    if (dialogId === undefined) return
    const at = document.activeElement
    if (at && at !== document.body && !rootRef.current?.contains(at)) return
    dialogRef.current?.querySelector<HTMLElement>('.browser-dialog__input, .browser-dialog__ok')?.focus()
  }, [dialogId])

  const answer = (accept: boolean) => {
    if (!dialog) return
    setAnswered(dialog.id)
    send(accept && dialog.type === 'prompt' ? { type: 'dialog', accept, text: promptText } : { type: 'dialog', accept })
    // Respondido de dentro do diálogo: o teclado volta à tela.
    if (dialogRef.current?.contains(document.activeElement)) {
      rootRef.current?.querySelector<HTMLElement>('.browser-screen__keys')?.focus({ preventScroll: true })
    }
  }

  if (st?.unavailable) {
    const u = st.unavailable
    return (
      <div className="browser-col" data-testid="browser-unavailable">
        <BrowserFailureNote failure={{ code: u.code, message: u.message, hint: u.hint }} onRetry={() => { void doReopen() }} />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="browser-col browser-col--live" data-testid="browser-live">
      <div className="browser-head">
        <button type="button" className="ghost browser-head__btn" aria-label={t('browser.back')} title={t('browser.back')}
                onClick={() => send({ type: 'history', action: 'back' })}>←</button>
        <button type="button" className="ghost browser-head__btn" aria-label={t('browser.forward')} title={t('browser.forward')}
                onClick={() => send({ type: 'history', action: 'forward' })}>→</button>
        <button type="button" className="ghost browser-head__btn" aria-label={t('browser.reload')} title={t('browser.reload')}
                onClick={() => send({ type: 'history', action: 'reload' })}>↻</button>
        <input className="browser-head__addr" aria-label={t('browser.address')} spellCheck={false} autoComplete="off"
               value={addr ?? st?.url ?? ''} aria-busy={st?.loading || undefined}
               onChange={(e) => setAddr(e.target.value)} onKeyDown={onAddrKey} onBlur={() => setAddr(null)} />
        <button type="button" className="ghost browser-head__btn" aria-label={t('browser.closeTab')} title={t('browser.closeTab')}
                onClick={closeTab}>
          {/* Desligar, e não ×: o × logo acima fecha só a coluna (a aba continua). */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
               strokeLinecap="round" aria-hidden="true"><path d="M12 3v8" /><path d="M6.3 7.3a8 8 0 1 0 11.4 0" /></svg>
        </button>
      </div>
      <div className="browser-meta">
        {baton && (
          <span className={`browser-baton browser-baton--${baton.kind}`} data-testid="browser-baton">
            {baton.kind === 'agent' ? t('browser.baton.agent')
              : baton.kind === 'free' ? t('browser.baton.free')
                : baton.you ? t('browser.baton.you') : t('browser.baton.other', { name: baton.name })}
          </span>
        )}
        {you && (
          <button type="button" className="ghost browser-meta__btn" onClick={() => send({ type: 'release' })}>
            {t('browser.baton.release')}
          </button>
        )}
        {st?.sandbox === false && (
          <span className="browser-meta__nosandbox" title={t('browser.noSandboxTitle')}>{t('browser.noSandbox')}</span>
        )}
      </div>
      {/* As faixas que ficam (servidores; a última ação, que não volta a null; os avisos, que
          o servidor não esvazia) vêm acima da tela, fora da área medida: quando uma aparece,
          sai um único `resize` e a tela volta a 1:1. */}
      <ServersStrip projectId={projectId} engine={engine} visible={visible} onOpen={openUrl} />
      {la && <div className="browser-last" data-testid="browser-last-action">{t('browser.lastAction', { text: la.text })}</div>}
      {(!!st?.notices.length || closeError) && (
        <ul className="browser-notices" aria-label={t('browser.notices.label')}>
          {st?.notices.slice(-3).map((n, i) => (
            <li key={`${i}:${n}`}>{n === SCHEME_REFUSED ? t('browser.notices.schemeRefused') : n}</li>
          ))}
          {closeError && <li>{closeError}</li>}
        </ul>
      )}
      <div className="browser-view">
        <BrowserScreen viewportWidth={vp.width} viewportHeight={vp.height} you={you} visible={visible} mark={mark}
                       send={send} frameRef={frameRef} releaseRef={releaseRef} onIntersect={onIntersect} />
        {/* O aviso de senha (só na primeira tomada do bastão) é uma camada sobre o topo
            da tela: não muda a medida, nem manda `resize`. */}
        {you && !warned && (
          <div className="browser-warning" role="note">
            <span>{t('browser.passwordWarning')}</span>
            <button type="button" className="ghost browser-meta__btn" onClick={() => {
              try { localStorage.setItem(PASSWORD_WARNED_KEY, '1') } catch { /* só não lembra */ }
              setWarned(true)
            }}>{t('browser.passwordOk')}</button>
          </div>
        )}
        {/* O que cobre a tela fica fora dela: a tela (memo) não redesenha a cada `state`. */}
        {closedShown ? (
          <div className="browser-cover" role="alert">
            <p>{t('browser.closed')}</p>
            <button type="button" className="ghost" disabled={busy} onClick={() => { void doReopen() }}>{t('browser.reopen')}</button>
          </div>
        ) : refused ? (
          <div className="browser-cover" role="alert"><p>{t('browser.refused')}</p></div>
        ) : st?.crashed ? (
          <div className="browser-cover" role="alert" data-testid="browser-crashed">
            <p>{t('browser.crashed')}</p>
            <button type="button" className="ghost" onClick={() => send({ type: 'history', action: 'reload' })}>{t('browser.reload')}</button>
          </div>
        ) : dialog ? (
          <div ref={dialogRef} key={dialog.id} className="browser-cover browser-dialog" role="dialog" aria-label={t('browser.dialog.label')}>
            <p className="browser-dialog__msg">{dialog.message}</p>
            {dialog.type === 'prompt' && (
              <PromptField label={dialog.message} initial={dialog.defaultValue ?? ''} onChange={setPromptText}
                           onEnter={() => answer(true)} />
            )}
            <div className="browser-dialog__actions">
              <button type="button" className="ghost" onClick={() => answer(false)}>{t('browser.dialog.cancel')}</button>
              <button type="button" className="browser-dialog__ok" onClick={() => answer(true)}>{t('browser.dialog.ok')}</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** O campo do `prompt` da página, com o valor padrão dele. */
function PromptField({ label, initial, onChange, onEnter }: {
  label: string; initial: string; onChange(v: string): void; onEnter(): void
}) {
  const [v, setV] = useState(initial)
  useEffect(() => { onChange(initial) }, [initial, onChange])
  return (
    <input className="browser-dialog__input" aria-label={label} value={v}
           onChange={(e) => { setV(e.target.value); onChange(e.target.value) }}
           onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter() } }} />
  )
}
