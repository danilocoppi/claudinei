import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { progressKey, useStore } from '../store'
import { isLive, sessionForEngine, startOrReviveEngine, displayStatusKey, dotClassOf } from '../engineSession'
import { hiddenEngines, listedOf, tabEngines } from '../terminalEngines'
import { setProjectEngines, stopSession } from '../api'
import type { SessionInfo, SessionStatus } from '../types'
import { EngineIcon } from './EngineIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMeter } from './ContextMeter'
import { ViewportPopover } from './ViewportPopover'
import { NewProjectModal } from './NewProjectModal'

/**
 * Abas por engine de um projeto — usadas no header do ChatView E na barra do
 * TerminalView, para alternar entre as engines de qualquer visão. Clicar numa
 * aba viva abre a sessão daquela engine (chat, ou a visão do terminal se ela
 * estiver `in_terminal` — o PTY segue vivo ao trocar). A engine parada/sem
 * sessão tem um ▶ que inicia ou revive. Dirigido por `store.engines` (sem
 * hardcode de engine — uma 3ª aparece sozinha), filtrado pela lista de motores
 * do terminal (`tabEngines`). No fim, o "+" acrescenta à lista um motor
 * escondido; retirar é pelo formulário do terminal.
 */
export function EngineTabs({ projectId, activeLocalId }: { projectId: number; activeLocalId: string }) {
  const { t } = useTranslation()
  const engines = useStore((s) => s.engines)
  const enginesLoaded = useStore((s) => s.enginesLoaded)
  const sessions = useStore((s) => s.sessions)
  const openSession = useStore((s) => s.openSession)
  const openTerminal = useStore((s) => s.openTerminal)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const terminalStates = useStore((s) => s.terminalStates)
  const setProjects = useStore((s) => s.setProjects)
  const [startingEngine, setStartingEngine] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [addError, setAddError] = useState('')
  const addRef = useRef<HTMLButtonElement>(null)
  // Encerrar é por ENGINE: um terminal pode ter Claude + Codex + Kimi vivos ao
  // mesmo tempo, e derrubar um não pode derrubar os outros.
  const [stopFor, setStopFor] = useState<{ session: SessionInfo; label: string } | null>(null)
  // O "editar" do aviso de nenhum motor instalado abre o formulário do terminal
  // aqui mesmo, o mesmo do ⋮ → Editar.
  const [editOpen, setEditOpen] = useState(false)

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

  // A lista crua, com os ids que esta tela não conhece: gravar sem eles os
  // apagaria do banco.
  const listed = listedOf(project)
  const visible = tabEngines({
    engines, listed, projectId, sessions, activeLocalId,
    // O aviso de limite de uso conta como o de interrompido: o limite absorve a
    // marca do reinício, e a aba do motor escondido não pode sumir com o aviso aberto.
    interrupted: (engine) => {
      const s = terminalStates[progressKey(projectId, engine)]
      return s?.interruption != null || s?.usageLimit != null
    },
  })
  // Sem o terminal no store (ainda não carregou), a lista lida seria o padrão,
  // e gravar a partir dela apagaria a verdadeira: o "+" espera o terminal.
  const hidden = project ? hiddenEngines(engines, listed) : []
  // Nenhum motor da lista do terminal está instalado (um id que o catálogo não
  // conhece também não roda) e nenhuma sessão deste terminal está viva. A aba da
  // conversa aberta na tela continua (o tabEngines a mantém), e o aviso fica ao
  // lado dela; sem aba nenhuma, ele ocupa o lugar das abas. Só vale com o
  // catálogo vindo do servidor: o embutido, usado até o GET /api/engines
  // responder (ou para sempre, se ele falhar), só tem Claude e Codex e não sabe
  // o que está instalado, e o aviso apareceria à toa. Também espera o terminal
  // chegar ao store.
  const noneInstalled = enginesLoaded && !!project
    && !listed.some((id) => engines.some((e) => e.id === id && e.available !== false))
    && !Object.values(sessions).some((s) => s.projectId === projectId && isLive(s))

  const addEngine = async (engineId: string) => {
    if (adding) return
    setAdding(engineId)
    setAddError('')
    try {
      const updated = await setProjectEngines(projectId, [...listed, engineId])
      // O servidor não avisa os outros clientes: quem mudou grava a resposta.
      // Lê o store na hora da resposta, não o do clique, para não desfazer o
      // que chegou enquanto o pedido estava em voo.
      setProjects(useStore.getState().projects.map((p) => (p.id === updated.id ? updated : p)))
      setAddOpen(false)
    } catch (err) {
      setAddError((err as Error).message)
    } finally {
      setAdding(null)
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
      {visible.map((e) => {
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
      {noneInstalled && (
        <div className="engine-tabs__none">
          {t('session.noEngineInstalled')} —{' '}
          <button type="button" className="engine-tabs__none-edit" onClick={() => setEditOpen(true)}>
            {t('session.noEngineEdit')}
          </button>
        </div>
      )}
      {hidden.length > 0 && (
        <button
          ref={addRef}
          type="button"
          className="engine-tabs__add"
          title={t('chat.addEngine')}
          aria-label={t('chat.addEngine')}
          aria-haspopup="menu"
          aria-expanded={addOpen}
          onClick={() => { setAddError(''); setAddOpen(true) }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
               strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
        </button>
      )}
      {addOpen && hidden.length > 0 && createPortal(
        // Mesmo padrão dos menus `.sess-pop`: o clique fora fecha, e nada anima.
        <div className="sess-pop__overlay" onClick={() => setAddOpen(false)}>
          <ViewportPopover x={0} y={0} minWidth={190} anchorRef={addRef}>
            <div className="sess-pop__eyebrow">{t('chat.addEngine')}</div>
            {hidden.map((e) => {
              const missing = e.available === false
              return (
                <div
                  key={e.id}
                  className={`sess-pop__item${adding || missing ? ' sess-pop__item--disabled' : ''}`}
                  // Não instalada aparece, mas desabilitada como no EnginePickerMenu:
                  // acrescentá-la daqui não daria aba nenhuma, e o clique pareceria
                  // não fazer nada. Quem quiser deixá-la na lista usa a edição do terminal.
                  title={missing ? `${t('chat.engineNotInstalledHint')}${e.installHint ? ` — ${e.installHint}` : ''}` : undefined}
                  aria-disabled={missing || undefined}
                  onClick={missing ? undefined : () => { void addEngine(e.id) }}
                >
                  <EngineIcon icon={e.icon} /><span className="engine-add__label">{e.label}</span>
                  {missing && <span className="engine-picker__missing">{t('chat.engineNotInstalled')}</span>}
                </div>
              )
            })}
            {addError && <div className="sess-pop__error" role="alert">{addError}</div>}
            <div className="sess-pop__hint">{t('chat.addEngineHint')}</div>
          </ViewportPopover>
        </div>,
        document.body,
      )}
      {editOpen && project && <NewProjectModal editProject={project} onClose={() => setEditOpen(false)} />}
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
