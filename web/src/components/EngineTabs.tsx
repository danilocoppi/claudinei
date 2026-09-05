import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { isLive, sessionForEngine, startOrReviveEngine, displayStatusKey, dotClassOf } from '../engineSession'
import { stopSession } from '../api'
import type { SessionInfo, SessionStatus } from '../types'
import { EngineIcon } from './EngineIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMeter } from './ContextMeter'

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
  // Encerrar é por ENGINE: um terminal pode ter Claude + Codex + Kimi vivos ao
  // mesmo tempo, e derrubar um não pode derrubar os outros.
  const [stopFor, setStopFor] = useState<{ session: SessionInfo; label: string } | null>(null)

  const confirmStop = () => {
    if (!stopFor) return
    const { localId } = stopFor.session
    setStopFor(null)
    // A conversa fica no histórico e a engine pode ser revivida pelo ▶ da aba —
    // encerrar não descarta nada, só libera o processo.
    void stopSession(localId).catch(() => {})
  }

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
        // Não instalada e sem sessão viva: "não instalada" já diz tudo — mostrar
        // "○ sem sessão" junto é redundância que come a largura da barra.
        const missing = e.available === false && !live
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
              {!missing && <span className={tabSession ? dotClassOf(tabSession) : 'status-dot status-none'} />}
              {!missing && (
                <span className="engine-tab__status">
                  {tabSession ? t(`status.${displayStatusKey(tabSession)}` as 'status.in_terminal') : t('sidebar.noSession')}
                </span>
              )}
              {/* O contexto é da SESSÃO, então mora na aba da engine dona dele. */}
              {tabSession && <ContextMeter session={tabSession} />}
            </button>
            {live && tabSession && (
              <button
                type="button"
                className="engine-tab__stop"
                title={t('chat.stopEngine', { engine: e.label })}
                aria-label={t('chat.stopEngine', { engine: e.label })}
                onClick={() => setStopFor({ session: tabSession, label: e.label })}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                     strokeLinecap="round" aria-hidden="true">
                  <path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1 0 11 0" />
                </svg>
              </button>
            )}
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
      {stopFor && (
        <ConfirmDialog
          title={t('chat.stopEngineTitle', { engine: stopFor.label })}
          // O aviso do turno perdido só aparece quando há turno: fora disso
          // encerrar é inócuo, e um alerta constante ensina a ignorar o diálogo.
          message={stopFor.session.status === 'working'
            ? `${t('chat.stopEngineWorking')}\n\n${t('chat.stopEngineMsg')}`
            : t('chat.stopEngineMsg')}
          confirmLabel={t('chat.stopEngineConfirm')}
          onConfirm={confirmStop}
          onClose={() => setStopFor(null)}
        />
      )}
    </div>
  )
}
