import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { EngineTabs } from './EngineTabs'
import { openTerminal as openTerminalApi, closeTerminal as closeTerminalApi, reviveSession } from '../api'

const MAX_RETRIES = 3

type ConnState = 'online' | 'reconnecting' | 'offline'

export function TerminalView() {
  const { t } = useTranslation()
  const localId = useStore((s) => s.activeLocalId)
  const projectId = useStore((s) => (localId ? s.sessions[localId]?.projectId : undefined))
  const openDashboard = useStore((s) => s.openDashboard)
  const openSession = useStore((s) => s.openSession)
  const ref = useRef<HTMLDivElement>(null)
  const [conn, setConn] = useState<ConnState>('online')
  const retryRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!localId || !ref.current) return
    let ws: WebSocket | undefined
    let disposed = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const term = new Terminal({ fontFamily: 'monospace', fontSize: 13, theme: { background: '#0b1020' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const sendResize = () => {
      fit.fit()
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d))
    })
    window.addEventListener('resize', sendResize)

    // Queda de transporte (backend reiniciou, rede): tenta reconectar com
    // backoff; após MAX_RETRIES mostra o banner offline com retry manual.
    const scheduleReconnect = () => {
      if (disposed) return
      if (attempts >= MAX_RETRIES) {
        setConn('offline')
        return
      }
      attempts += 1
      setConn('reconnecting')
      retryTimer = setTimeout(() => { void connect() }, attempts * 1000)
    }

    const connect = async () => {
      try {
        const { token, wsUrl } = await openTerminalApi(localId)
        if (disposed) return
        const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
        ws = new WebSocket(`${scheme}${location.host}${wsUrl}?token=${encodeURIComponent(token)}`)
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          attempts = 0
          setConn('online')
          sendResize()
        }
        ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
        ws.onclose = () => scheduleReconnect()
      } catch (err) {
        if (disposed) return
        term.write(`\r\n${t('terminal.openError', { error: String(err) })}\r\n`)
        scheduleReconnect()
      }
    }

    retryRef.current = () => {
      attempts = 0
      setConn('reconnecting')
      void connect()
    }

    void connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener('resize', sendResize)
      onData.dispose()
      if (ws) {
        ws.onclose = null // fechar no unmount não é queda: não agenda reconexão
        ws.close()
      }
      term.dispose()
    }
  }, [localId])

  const voltarAoChat = async () => {
    if (localId) {
      await closeTerminalApi(localId).catch(() => {})
      // revive automático: 1 clique para continuar a conversa; se falhar, o chat
      // mostra o botão Reviver como fallback
      await reviveSession(localId).catch(() => {})
      openSession(localId)
    } else {
      openDashboard()
    }
  }

  if (!localId) return null
  return (
    <div className="terminal-view">
      <div className="terminal-view__bar">
        {projectId !== undefined && <EngineTabs projectId={projectId} activeLocalId={localId} />}
        {conn !== 'online' && (
          <span className={`terminal-view__conn terminal-view__conn--${conn}`} data-testid="conn-banner">
            {conn === 'reconnecting' ? t('terminal.reconnecting') : t('terminal.disconnected')}
            {conn === 'offline' && (
              <button className="terminal-view__retry" onClick={() => retryRef.current()}>{t('terminal.reconnect')}</button>
            )}
          </span>
        )}
        <button onClick={voltarAoChat}>{t('terminal.backToChat')}</button>
      </div>
      <div className="terminal-view__screen" ref={ref} />
    </div>
  )
}
