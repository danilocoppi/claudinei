import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { runAction, stopAction } from '../api'

/**
 * A janelinha onde uma ação roda.
 *
 * É um terminal de verdade, e não um painel de log, porque o que está do outro
 * lado é um shell: um `npm run deploy` pergunta coisas, pinta barra de progresso,
 * espera confirmação. Log não responde.
 *
 * Ela é desenhada pelo App, não pelo menu que a abriu — o menu fecha no clique, e
 * um deploy de cinco minutos morreria junto.
 */
export function ActionRunModal() {
  const { t } = useTranslation()
  const run = useStore((s) => s.actionRun)
  const close = useStore((s) => s.closeActionRun)
  const ref = useRef<HTMLDivElement>(null)
  const actionId = run?.actionId
  const attachOnly = run?.attachOnly ?? false

  useEffect(() => {
    if (actionId === undefined || !ref.current) return
    let ws: WebSocket | undefined
    let disposed = false
    const term = new Terminal({ fontFamily: 'monospace', fontSize: 12, theme: { background: '#0b1020' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const ajusta = () => {
      fit.fit()
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d))
    })
    window.addEventListener('resize', ajusta)

    // O POST é idempotente no servidor: se a ação já estiver de pé, ele devolve um
    // token novo para o MESMO processo. É isso que faz um F5 reencontrar o deploy
    // em vez de disparar um segundo — e é por isso que não há um "reattach" à parte.
    void (async () => {
      try {
        const { token, wsUrl } = await runAction(actionId, { attachOnly })
        if (disposed) return
        const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
        ws = new WebSocket(`${scheme}${location.host}${wsUrl}?token=${encodeURIComponent(token)}`)
        ws.binaryType = 'arraybuffer'
        ws.onopen = ajusta
        ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
      } catch (err) {
        if (disposed) return
        // Restaurando de um F5 e o processo já acabou: a janela some sem alarde. Ela
        // só existia para acompanhar algo que estava acontecendo.
        if (attachOnly) { useStore.getState().closeActionRun(); return }
        term.write(`\r\n${String(err)}\r\n`)
      }
    })()

    return () => {
      disposed = true
      window.removeEventListener('resize', ajusta)
      onData.dispose()
      ws?.close()
      term.dispose()
    }
  }, [actionId, attachOnly])

  if (!run) return null

  // Fechar é PARAR: a caixinha é a única presença do processo na tela, e deixá-lo
  // rodando sem nada que o mostre é o terminal órfão que esta tela veio evitar.
  const fechar = () => {
    void stopAction(run.actionId).catch(() => {})
    close()
  }

  return createPortal(
    <div className="actrun__overlay" onClick={fechar}>
      <div className="actrun glass" data-testid="action-run" onClick={(e) => e.stopPropagation()}>
        <div className="actrun__bar">
          <span className={`actrun__dot ${run.exited ? 'actrun__dot--done' : ''}`} />
          <strong className="actrun__name">{run.name}</strong>
          <span className="actrun__state">
            {run.exited ? t('actions.finished') : t('actions.running')}
          </span>
          <button className="actrun__close" onClick={fechar} title={t('common.close')}>✕</button>
        </div>
        <div className="actrun__screen" ref={ref} />
      </div>
    </div>,
    document.body,
  )
}
