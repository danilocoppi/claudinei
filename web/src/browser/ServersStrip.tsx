import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchServers, stopLocalServer, type LocalServer } from './api'

/** A varredura dos servidores, com a vista visível. */
const POLL_MS = 5000

type Props = {
  projectId: number
  engine: string
  /** A vista está à vista: fora dela, nenhuma leitura. */
  visible: boolean
  /** O Abrir: navega a aba para o endereço. */
  onOpen(url: string): void
}

const same = (a: LocalServer[], b: LocalServer[]) =>
  a.length === b.length && a.every((s, i) => s.pid === b[i].pid && s.port === b[i].port && s.label === b[i].label
    && s.startTime === b[i].startTime && s.marker === b[i].marker)

/** `::1` (ou a forma longa, `0:0:0:0:0:0:0:1`): o loopback do IPv6. */
const isIpv6Loopback = (host: string) => /^[0:]*:0*1$/.test(host.replace(/^\[|\]$/g, ''))

/**
 * O endereço do Abrir: o servidor que escuta só em `::1` não atende em
 * 127.0.0.1, e vai por `http://[::1]:<porta>`; os outros, por 127.0.0.1.
 */
export function serverUrl(s: Pick<LocalServer, 'host' | 'port'>): string {
  return isIpv6Loopback(s.host) ? `http://[::1]:${s.port}` : `http://127.0.0.1:${s.port}`
}

/**
 * A faixa dos servidores locais do terminal (":5173 vite — Abrir · Parar"),
 * lida a cada 5 s só com a vista visível (uma leitura na hora em que ela fica
 * visível). O Abrir navega a aba para `http://127.0.0.1:<porta>` (ou
 * `http://[::1]:<porta>`, com o servidor só no loopback do IPv6). O Parar
 * manda o início do processo (contra PID reaproveitado) e pode demorar até
 * ~5 s (o SIGKILL): mostra "parando…" e não repete. Sem marcador (achado pela
 * pasta), só Abrir. Sem servidores, a faixa some.
 */
export const ServersStrip = memo(function ServersStrip({ projectId, engine, visible, onOpen }: Props) {
  const { t } = useTranslation()
  const [servers, setServers] = useState<LocalServer[]>([])
  /** Os PIDs com um Parar a caminho. */
  const [stopping, setStopping] = useState<Record<number, true>>({})
  /** O erro do último Parar, por PID. */
  const [errors, setErrors] = useState<Record<number, string>>({})
  /** Muda depois de um Parar: a lista é relida na hora. */
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!visible) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = () => {
      fetchServers(projectId, engine)
        .then((r) => {
          if (!alive || !Array.isArray(r?.servers)) return
          setServers((cur) => (same(cur, r.servers) ? cur : r.servers))
        })
        .catch(() => { /* fica a lista anterior; a próxima leitura tenta de novo */ })
        .finally(() => { if (alive) timer = setTimeout(read, POLL_MS) })
    }
    read()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [projectId, engine, visible, tick])

  const stop = (s: LocalServer) => {
    if (stopping[s.pid]) return
    setStopping((cur) => ({ ...cur, [s.pid]: true }))
    setErrors(({ [s.pid]: _old, ...rest }) => rest)
    stopLocalServer(projectId, engine, s.pid, s.startTime)
      .then(() => setTick((n) => n + 1))
      .catch((err: Error) => setErrors((cur) => ({ ...cur, [s.pid]: err.message })))
      .finally(() => setStopping(({ [s.pid]: _done, ...rest }) => rest))
  }

  if (!servers.length) return null
  return (
    <ul className="browser-servers" aria-label={t('localServers.label')}>
      {servers.map((s) => (
        <li key={`${s.pid}:${s.port}`} className="browser-servers__item" data-testid={`server-${s.port}`}>
          <span className="browser-servers__name">
            <b>:{s.port}</b> {s.label}
            {s.marker === 'cwd' && (
              <span className="browser-servers__nomark" title={t('localServers.noMarkerTitle')}>{t('localServers.noMarker')}</span>
            )}
          </span>
          <span className="browser-servers__sep" aria-hidden="true">—</span>
          <span className="browser-servers__actions">
            <button type="button" className="link-btn" title={t('localServers.openTitle', { url: serverUrl(s) })}
                    onClick={() => onOpen(serverUrl(s))}>{t('localServers.open')}</button>
            {s.marker === 'exact' && (stopping[s.pid]
              ? <span className="browser-servers__stopping">{t('localServers.stopping')}</span>
              : <> · <button type="button" className="link-btn" onClick={() => stop(s)}>{t('localServers.stop')}</button></>)}
          </span>
          {errors[s.pid] && <span className="browser-servers__error" role="status">{errors[s.pid]}</span>}
        </li>
      ))}
    </ul>
  )
})
