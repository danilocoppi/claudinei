import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { runAction, stopAction } from '../api'
import { dentroDaTela, JANELA, poseDefault } from '../actionRun'

type Run = ReturnType<typeof useStore.getState>['actionRuns'][number]

/**
 * As janelas onde as ações rodam.
 *
 * São terminais de verdade, e não painéis de log, porque o que está do outro lado
 * é um shell: um `npm run deploy` pergunta coisas, pinta barra de progresso,
 * espera confirmação. Log não responde.
 *
 * E são JANELAS, não modais. A diferença não é estética: um modal tem um véu que
 * come os cliques da página e some quando se clica fora — e aqui isso matava o
 * deploy sem avisar, porque fechar é parar. Uma janela flutua por cima, deixa o
 * resto da interface viva embaixo dela, e sai da frente sendo arrastada ou
 * encolhida — nunca sendo morta por engano.
 */
export function ActionRunModal() {
  const runs = useStore((s) => s.actionRuns)
  const abertas = runs.filter((r) => !r.minimized)
  const encolhidas = runs.filter((r) => r.minimized)

  return (
    <>
      {abertas.map((run, i) => (
        <ActionWindow key={run.actionId} run={run} indice={i} zIndex={60 + runs.indexOf(run)} />
      ))}
      {encolhidas.length > 0 && <Bandeja runs={encolhidas} />}
    </>
  )
}

/**
 * As encolhidas, lado a lado numa fileira.
 *
 * Empilhadas no mesmo ponto, a de cima escondia todas as outras — e um deploy
 * invisível é exatamente o que a pílula existe para evitar. A fileira cresce para
 * a esquerda e quebra em linhas quando não cabe mais.
 */
function Bandeja({ runs }: { runs: Run[] }) {
  const { t } = useTranslation()
  const minimizar = useStore((s) => s.setActionRunMinimized)
  return createPortal(
    <div className="actrun-tray" data-testid="action-run-tray">
      {runs.map((run) => (
        <button
          key={run.actionId}
          className="actrun-pill"
          data-testid={`action-run-pill-${run.actionId}`}
          onClick={() => minimizar(run.actionId, false)}
        >
          <span className={`actrun__dot ${run.exited ? 'actrun__dot--done' : ''}`} />
          <span className="actrun-pill__name">{run.name}</span>
          <span className="actrun-pill__state">{run.exited ? t('actions.finished') : t('actions.running')}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

function ActionWindow({ run, indice, zIndex }: { run: Run; indice: number; zIndex: number }) {
  const { t } = useTranslation()
  const close = useStore((s) => s.closeActionRun)
  const minimizar = useStore((s) => s.setActionRunMinimized)
  const mover = useStore((s) => s.moveActionRun)
  const trazerParaFrente = useStore((s) => s.raiseActionRun)
  const ref = useRef<HTMLDivElement>(null)
  const [confirmandoParar, setConfirmandoParar] = useState(false)

  const { actionId } = run
  const attachOnly = run.attachOnly ?? false

  useEffect(() => {
    if (!ref.current) return
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
    // Cada tecla vai direto para o PTY. É por isto que não há campo de digitação:
    // o terminal É o campo, e um `<input>` no rodapé perderia justamente o que faz
    // dele um terminal — Ctrl-C, setas, tab-completion, histórico do shell.
    const onData = term.onData((dados) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(dados))
    })
    window.addEventListener('resize', ajusta)

    // Foco só quando a janela foi ABERTA por alguém — nunca ao restaurar de um F5,
    // que rouba o cursor de quem acabou de carregar a página para escrever no chat.
    if (!attachOnly) term.focus()

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
        if (attachOnly) { useStore.getState().closeActionRun(actionId); return }
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

  /**
   * Arrastar pela barra de título.
   *
   * Nos listeners do `window`, e não do cabeçalho: o ponteiro corre mais que o
   * React, e ao passar por cima do terminal — ou sair da janela — o arrasto
   * morreria no meio com a janela largada onde ninguém pediu.
   */
  const pegar = (e: React.PointerEvent) => {
    const caixa = (e.currentTarget as HTMLElement).closest('.actrun')!.getBoundingClientRect()
    const dx = e.clientX - caixa.left
    const dy = e.clientY - caixa.top
    const arrasta = (ev: PointerEvent) => {
      const p = dentroDaTela(ev.clientX - dx, ev.clientY - dy)
      mover(actionId, p.x, p.y)
    }
    const solta = () => {
      window.removeEventListener('pointermove', arrasta)
      window.removeEventListener('pointerup', solta)
    }
    window.addEventListener('pointermove', arrasta)
    window.addEventListener('pointerup', solta)
  }

  const parar = () => {
    void stopAction(actionId).catch(() => {})
    close(actionId)
  }

  /**
   * O ✕ só mata na hora quando não há mais o que matar.
   *
   * Com o processo de pé ele pergunta antes, porque parar um deploy no meio não
   * tem desfazer — e quem só queria a janela fora da frente tem o "—" ao lado.
   */
  const pedirParaFechar = () => {
    if (run.exited) close(actionId)
    else setConfirmandoParar(true)
  }

  // Sem posição própria, pousa em cascata: duas janelas no mesmo canto deixariam a
  // de baixo inalcançável até a de cima sair da frente.
  const pose = run.x !== undefined && run.y !== undefined
    ? { left: run.x, top: run.y }
    : poseDefault(indice)

  return createPortal(
    <div
      className="actrun glass"
      data-testid={`action-run-${actionId}`}
      style={{ ...pose, width: JANELA.largura, height: JANELA.altura, zIndex }}
      onPointerDownCapture={() => trazerParaFrente(actionId)}
    >
      <div className="actrun__bar" onPointerDown={pegar}>
        <span className={`actrun__dot ${run.exited ? 'actrun__dot--done' : ''}`} />
        <strong className="actrun__name">{run.name}</strong>
        <span className="actrun__state">{run.exited ? t('actions.finished') : t('actions.running')}</span>
        {/* Os botões não arrastam: sem isto, um clique com o mínimo tremor no
            ponteiro viraria arrasto e o clique nunca chegaria. */}
        <button className="actrun__btn" title={t('actions.minimize')} data-testid={`action-run-min-${actionId}`}
                onPointerDown={(e) => e.stopPropagation()} onClick={() => minimizar(actionId, true)}>—</button>
        <button className="actrun__btn" title={t('common.close')} data-testid={`action-run-close-${actionId}`}
                onPointerDown={(e) => e.stopPropagation()} onClick={pedirParaFechar}>✕</button>
      </div>

      {confirmandoParar && (
        <div className="actrun__ask" data-testid={`action-run-ask-${actionId}`}>
          <span>{t('actions.stopAsk')}</span>
          <button className="ghost" onClick={() => setConfirmandoParar(false)}>{t('common.cancel')}</button>
          <button className="actrun__stop" onClick={parar}>{t('actions.stop')}</button>
        </div>
      )}

      <div className="actrun__screen" ref={ref} />
    </div>,
    document.body,
  )
}
