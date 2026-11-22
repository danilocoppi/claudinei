import type { BrowserClientMsg, BrowserStateMsg, FrameHeader } from '../../../shared/browser'
import { parseFrame } from './frame'

/** As esperas antes de cada nova tentativa; depois da última, ela se repete. */
const RETRY_MS = [1000, 2000, 5000, 10000]

export interface BrowserSocketHandlers {
  onState(s: BrowserStateMsg): void
  onFrame(f: { header: FrameHeader; image: Blob }): void
  /** O socket fechou; `retrying`: outra tentativa já está marcada. */
  onClose(code: number, retrying: boolean): void
}

/**
 * O WebSocket da tela do navegador do terminal (`/ws/browser/:projectId/:engine`).
 * Texto é `state`; binário é quadro. O `visible` e o `resize` mais recentes
 * ficam guardados e saem de novo a cada conexão (o espectador nasce invisível
 * e sem tamanho no servidor); as outras mensagens, sem conexão aberta, são
 * descartadas (um clique de 5 s atrás não vale mais).
 *
 * Reconecta em 1 s, 2 s, 5 s e 10 s (e de 10 em 10 s); a espera zera quando
 * uma conexão abre. Não reconecta em 1008 (origem, acesso, horário, revogação)
 * nem no 1000 que segue um `state` com `closed` (a aba fechou).
 */
export function connectBrowser(projectId: number, engine: string, h: BrowserSocketHandlers): {
  send(m: BrowserClientMsg): void
  close(): void
} {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${location.host}/ws/browser/${projectId}/${encodeURIComponent(engine)}`
  let ws: WebSocket | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let visible: BrowserClientMsg | null = null
  let resize: BrowserClientMsg | null = null

  const isOpen = () => !!ws && ws.readyState === 1

  function open(): void {
    let closedState = false
    const sock = new WebSocket(url)
    sock.binaryType = 'arraybuffer'
    ws = sock
    sock.onopen = () => {
      attempt = 0
      for (const m of [visible, resize]) if (m) sock.send(JSON.stringify(m))
    }
    sock.onmessage = (e: MessageEvent) => {
      if (stopped) return
      if (typeof e.data === 'string') {
        let msg: BrowserStateMsg
        try { msg = JSON.parse(e.data) } catch { return }
        if (msg?.type !== 'state') return
        if (msg.closed) closedState = true
        h.onState(msg)
      } else if (e.data instanceof ArrayBuffer) {
        let f: ReturnType<typeof parseFrame>
        try { f = parseFrame(e.data) } catch { return }
        h.onFrame(f)
      }
    }
    sock.onclose = (e: CloseEvent) => {
      if (stopped || ws !== sock) return
      ws = null
      const final = e.code === 1008 || (e.code === 1000 && closedState)
      if (!final) {
        const ms = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
        attempt++
        timer = setTimeout(() => { timer = null; if (!stopped) open() }, ms)
      }
      h.onClose(e.code, !final)
    }
  }

  open()
  return {
    send(m) {
      if (stopped) return
      if (m.type === 'visible') visible = m
      else if (m.type === 'resize') resize = m
      if (isOpen()) ws!.send(JSON.stringify(m))
    },
    close() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      const sock = ws
      ws = null
      if (sock) {
        sock.onopen = null
        sock.onmessage = null
        sock.onclose = null
        try { sock.close(1000) } catch { /* já fechado */ }
      }
    },
  }
}
