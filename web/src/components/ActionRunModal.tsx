import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { runAction, stopAction } from '../api'
import { dentroDaTela, JANELA } from '../actionRun'

/**
 * A janelinha onde uma ação roda.
 *
 * É um terminal de verdade, e não um painel de log, porque o que está do outro
 * lado é um shell: um `npm run deploy` pergunta coisas, pinta barra de progresso,
 * espera confirmação. Log não responde.
 *
 * E é uma JANELA, não um modal. A diferença não é estética: um modal tem um véu
 * que come os cliques da página e some quando se clica fora — e aqui isso matava
 * o deploy sem avisar, porque fechar é parar. Uma janela flutua por cima, deixa o
 * resto da interface viva embaixo dela, e sai da frente sendo arrastada ou
 * encolhida — nunca sendo morta por engano.
 */
export function ActionRunModal() {
  const { t } = useTranslation()
  const run = useStore((s) => s.actionRun)
  const close = useStore((s) => s.closeActionRun)
  const minimizar = useStore((s) => s.setActionRunMinimized)
  const mover = useStore((s) => s.moveActionRun)
  const ref = useRef<HTMLDivElement>(null)
  /** O terminal vivo, para o campo de digitação poder escrever nele. */
  const envio = useRef<((texto: string) => void) | null>(null)
  const [confirmandoParar, setConfirmandoParar] = useState(false)
  const [linha, setLinha] = useState('')

  const actionId = run?.actionId
  const attachOnly = run?.attachOnly ?? false
  const minimizado = !!run?.minimized

  useEffect(() => {
    // Minimizada, o container não existe no DOM — e um xterm sem onde se desenhar
    // mede 0x0 e nunca mais volta ao tamanho certo. Melhor não montar.
    if (actionId === undefined || minimizado || !ref.current) return
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
    const manda = (dados: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(dados))
    }
    const onData = term.onData(manda)
    envio.current = manda
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
      envio.current = null
      window.removeEventListener('resize', ajusta)
      onData.dispose()
      ws?.close()
      term.dispose()
    }
  }, [actionId, attachOnly, minimizado])

  /**
   * Arrastar pela barra de título.
   *
   * Nos listeners do `window`, e não do cabeçalho: o ponteiro corre mais que o
   * React, e ao passar por cima do terminal — ou sair da janela — o arrasto
   * morreria no meio com a janela largada onde ninguém pediu.
   */
  const pegar = (e: React.PointerEvent) => {
    if (!run) return
    const caixa = (e.currentTarget as HTMLElement).closest('.actrun')!.getBoundingClientRect()
    const dx = e.clientX - caixa.left
    const dy = e.clientY - caixa.top
    const arrasta = (ev: PointerEvent) => {
      const p = dentroDaTela(ev.clientX - dx, ev.clientY - dy)
      mover(p.x, p.y)
    }
    const solta = () => {
      window.removeEventListener('pointermove', arrasta)
      window.removeEventListener('pointerup', solta)
    }
    window.addEventListener('pointermove', arrasta)
    window.addEventListener('pointerup', solta)
  }

  if (!run) return null

  const parar = () => {
    void stopAction(run.actionId).catch(() => {})
    close()
  }

  /**
   * O ✕ só mata na hora quando não há mais o que matar.
   *
   * Com o processo de pé ele pergunta antes, porque parar um deploy no meio não
   * tem desfazer — e quem só queria a janela fora da frente tem o "—" ao lado.
   */
  const pedirParaFechar = () => {
    if (run.exited) close()
    else setConfirmandoParar(true)
  }

  const enviarLinha = () => {
    if (!envio.current) return
    envio.current(`${linha}\r`)
    setLinha('')
  }

  if (minimizado) {
    return createPortal(
      <button className="actrun-pill" data-testid="action-run-pill" onClick={() => minimizar(false)}>
        <span className={`actrun__dot ${run.exited ? 'actrun__dot--done' : ''}`} />
        <span className="actrun-pill__name">{run.name}</span>
        <span className="actrun-pill__state">{run.exited ? t('actions.finished') : t('actions.running')}</span>
      </button>,
      document.body,
    )
  }

  const pose = run.x !== undefined && run.y !== undefined
    ? { left: run.x, top: run.y }
    : { right: 20, bottom: 20 }

  return createPortal(
    <div
      className="actrun glass"
      data-testid="action-run"
      style={{ ...pose, width: JANELA.largura, height: JANELA.altura }}
    >
      <div className="actrun__bar" onPointerDown={pegar}>
        <span className={`actrun__dot ${run.exited ? 'actrun__dot--done' : ''}`} />
        <strong className="actrun__name">{run.name}</strong>
        <span className="actrun__state">{run.exited ? t('actions.finished') : t('actions.running')}</span>
        {/* Os botões não arrastam: sem isto, um clique com o mínimo tremor no
            ponteiro viraria arrasto e o clique nunca chegaria. */}
        <button className="actrun__btn" title={t('actions.minimize')} data-testid="action-run-min"
                onPointerDown={(e) => e.stopPropagation()} onClick={() => minimizar(true)}>—</button>
        <button className="actrun__btn" title={t('common.close')} data-testid="action-run-close"
                onPointerDown={(e) => e.stopPropagation()} onClick={pedirParaFechar}>✕</button>
      </div>

      {confirmandoParar && (
        <div className="actrun__ask" data-testid="action-run-ask">
          <span>{t('actions.stopAsk')}</span>
          <button className="ghost" onClick={() => setConfirmandoParar(false)}>{t('common.cancel')}</button>
          <button className="actrun__stop" onClick={parar}>{t('actions.stop')}</button>
        </div>
      )}

      <div className="actrun__screen" ref={ref} />

      {/* O campo existe porque digitar direto no terminal exige saber que dá — e
          porque aqui dá para corrigir antes de mandar, o que o PTY (que recebe
          tecla a tecla) não permitiria. */}
      {run.allowInput && !run.exited && (
        <form className="actrun__input" onSubmit={(e) => { e.preventDefault(); enviarLinha() }}>
          <input
            value={linha}
            spellCheck={false}
            placeholder={t('actions.inputPlaceholder')}
            data-testid="action-run-input"
            onChange={(e) => setLinha(e.target.value)}
          />
          <button type="submit" title={t('actions.send')}>↵</button>
        </form>
      )}
    </div>,
    document.body,
  )
}
