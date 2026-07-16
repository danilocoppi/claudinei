import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { isLive, sessionForEngine, startOrReviveEngine, displayStatusKey, dotClassOf } from '../engineSession'
import type { SessionInfo, SessionStatus } from '../types'
import { EngineIcon } from './EngineIcon'

/**
 * Abas por engine de um projeto — usadas no header do ChatView E na barra do
 * TerminalView, para alternar entre as engines de qualquer visão. Clicar numa
 * aba viva abre a sessão daquela engine (chat, ou a visão do terminal se ela
 * estiver `in_terminal` — o PTY segue vivo ao trocar). A engine parada/sem
 * sessão tem um ▶ que inicia ou revive. Dirigido por `store.engines` (sem
 * hardcode de engine — uma 3ª aparece sozinha).
 */
export function EngineTabs({ projectId, activeLocalId }: { projectId: number; activeLocalId: string }) {
  const { t } = useTranslation()
  const engines = useStore((s) => s.engines)
  const sessions = useStore((s) => s.sessions)
  const openSession = useStore((s) => s.openSession)
  const openTerminal = useStore((s) => s.openTerminal)
  const [startingEngine, setStartingEngine] = useState<string | null>(null)

  const handleStartEngine = async (engineId: string) => {
    if (startingEngine) return
    setStartingEngine(engineId)
    try {
      const localId = await startOrReviveEngine(projectId, engineId, sessions)
      openSession(localId)
    } catch {
      /* 409 raro (a engine ficou viva entre render e clique): não corrompe estado */
    } finally {
      setStartingEngine(null)
    }
  }

  const switchTo = (s: SessionInfo) => {
    // Sessão aberta no terminal → reabre a VISÃO do terminal (reconecta ao PTY
    // vivo); as demais → o chat. Assim dá pra alternar engines sem encerrar o
    // terminal da outra.
    if (s.status === 'in_terminal') openTerminal(s.localId)
    else openSession(s.localId)
  }

  return (
    <div className="engine-tabs" role="tablist" aria-label={t('session.engine')}>
      {engines.map((e) => {
        const tabSession = sessionForEngine(projectId, e.id, sessions)
        const live = isLive(tabSession)
        const active = !!tabSession && tabSession.localId === activeLocalId
        return (
          <div key={e.id} className={`engine-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active}>
            <button
              type="button"
              className="engine-tab__main"
              disabled={!live}
              onClick={() => { if (live && tabSession) switchTo(tabSession) }}
            >
              <EngineIcon className="engine-tab__icon" icon={e.icon} />
              <span className="engine-tab__label">{e.label}</span>
              <span className={tabSession ? dotClassOf(tabSession) : 'status-dot status-none'} />
              <span className="engine-tab__status">
                {tabSession ? t(`status.${displayStatusKey(tabSession)}` as 'status.in_terminal') : t('sidebar.noSession')}
              </span>
            </button>
            {!live && (e.available === false ? (
              // CLI não instalada no servidor: não oferece o ▶ (a sessão nasceria
              // morta) — badge com o comando de instalação no tooltip.
              <span
                className="engine-tab__missing"
                title={`${t('chat.engineNotInstalledHint')}${e.installHint ? ` — ${e.installHint}` : ''}`}
              >
                {t('chat.engineNotInstalled')}
              </span>
            ) : (
              <button
                type="button"
                className="engine-tab__play"
                title={t('chat.startEngine', { engine: e.label })}
                disabled={startingEngine === e.id}
                onClick={() => handleStartEngine(e.id)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5Z" /></svg>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}
