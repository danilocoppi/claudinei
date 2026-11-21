import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { listedOf } from '../terminalEngines'
import { handoff } from '../branch/api'
import { handoffTargets, type HandoffTarget } from '../branch/handoff'
import { EngineIcon } from './EngineIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { ViewportPopover } from './ViewportPopover'
import { formatLimitTime } from './UsageLimitNotice'

/**
 * ⇄ Continuar noutro motor: o menu da aba ativa, no padrão `.sess-pop` do "+".
 * Lista os outros motores instalados da lista do terminal, cada um com o estado
 * e o que ele já tinha pendente (goal, fila, avisos de resultado). Trabalhando
 * ou no limite, o servidor recusa: ficam desabilitados. Ocioso tem a conversa
 * encerrada, e o goal ativo do destino fica pausado: os dois pedem confirmação
 * antes do POST. Deu certo, abre a aba do
 * destino; deu errado, o erro fica no menu.
 *
 * Montado só com o menu aberto: as assinaturas de fila e estados do terminal
 * não re-renderizam a barra de abas.
 */
export function HandoffMenu({ projectId, from, anchorRef, onClose }: {
  projectId: number
  /** O motor da conversa de origem (a aba ativa). */
  from: string
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const engines = useStore((s) => s.engines)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const sessions = useStore((s) => s.sessions)
  const terminalStates = useStore((s) => s.terminalStates)
  const queues = useStore((s) => s.queues)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmFor, setConfirmFor] = useState<HandoffTarget | null>(null)

  // Esc fecha o menu, como nos outros `.sess-pop`. Em captura e consumido
  // (preventDefault + stopPropagation, o padrão do FileOpenMenu): a busca e os
  // outros ouvintes de Esc da página não o veem, e um segundo Esc já é deles.
  // Com a confirmação aberta o menu saiu da frente, e o Esc não é dele.
  const menuOpen = !confirmFor
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      // Como o clique fora: com o pedido no ar, o menu fica.
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menuOpen, busy, onClose])

  // Teclado: o foco entra no primeiro destino livre ao abrir (e ao voltar da
  // confirmação); as setas andam entre os livres, em volta. Enter/Espaço escolhem.
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[data-free]')?.focus({ preventScroll: true })
  }, [menuOpen])
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const free = [...(menuRef.current?.querySelectorAll<HTMLElement>('[data-free]') ?? [])]
    if (free.length === 0) return
    e.preventDefault()
    const i = free.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % free.length : (i <= 0 ? free.length - 1 : i - 1)
    free[next].focus({ preventScroll: true })
  }

  const targets = handoffTargets({ projectId, from, engines, listed: listedOf(project), sessions, terminalStates, queues })
  const fromLabel = engines.find((e) => e.id === from)?.label ?? from

  const run = async (target: HandoffTarget) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const session = await handoff(projectId, from, target.engine.id)
      // O WebSocket costuma trazer a sessão antes; sem ela no store, o chat
      // abriria em branco até o próximo `session_status`.
      useStore.setState((s) => (s.sessions[session.localId] ? s : { sessions: { ...s.sessions, [session.localId]: session } }))
      useStore.getState().openSession(session.localId)
      onClose()
    } catch (err) {
      // `req` já traduz o código do servidor (`localizeServerError`).
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pick = (target: HandoffTarget) => {
    if (busy || target.state === 'working' || target.state === 'limited') return
    // Ocioso tem a conversa encerrada; sem conversa, o goal ativo do destino fica pausado: os dois confirmam.
    if (target.state === 'idle' || target.pending.goal) setConfirmFor(target)
    else void run(target)
  }

  const stateText = (target: HandoffTarget): string => {
    if (target.state !== 'limited') return t(`branch.target.${target.state}`)
    if (!target.limitUntil) return t('branch.target.limitedUnknown')
    return t('branch.target.limited', { time: formatLimitTime(Date.parse(target.limitUntil) / 1000, i18n.language) })
  }

  const pendingText = (target: HandoffTarget): string[] => {
    const { goal, queue, taskResults } = target.pending
    return [
      ...(goal ? [t('branch.pending.goal')] : []),
      ...(queue > 0 ? [t('branch.pending.queue', { count: queue })] : []),
      ...(taskResults > 0 ? [t('branch.pending.taskResults', { count: taskResults })] : []),
    ]
  }

  return (
    <>
      {/* Com a confirmação aberta o menu sai da frente: o `.sess-pop` (60/61)
          fica acima do diálogo (50) e tomaria os cliques dele. Cancelar o traz de volta. */}
      {!confirmFor && createPortal(
        // Mesmo padrão dos menus `.sess-pop`: o clique fora fecha, e nada anima.
        <div className="sess-pop__overlay" onClick={() => { if (!busy) onClose() }}>
          <ViewportPopover x={0} y={0} minWidth={260} anchorRef={anchorRef}>
            <div role="menu" ref={menuRef} onClick={(e) => e.stopPropagation()} onKeyDown={onMenuKey}>
              <div className="sess-pop__eyebrow">{t('branch.handoff.button')}</div>
              {targets.map((target) => {
                const off = target.state === 'working' || target.state === 'limited'
                const pending = pendingText(target)
                return (
                  <div
                    key={target.engine.id}
                    className={`sess-pop__item handoff-target${off || busy ? ' sess-pop__item--disabled' : ''}`}
                    role="menuitem"
                    tabIndex={off ? -1 : 0}
                    data-free={off ? undefined : ''}
                    aria-disabled={off || busy || undefined}
                    onClick={() => pick(target)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(target) } }}
                  >
                    <EngineIcon icon={target.engine.icon} />
                    <div className="handoff-target__text">
                      <span className="engine-add__label">{target.engine.label}</span>
                      <span className="handoff-target__state">{stateText(target)}</span>
                      {pending.length > 0 && (
                        <span className="handoff-target__pending">
                          {pending.map((p) => <span key={p}>{p}</span>)}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              {error && <div className="sess-pop__error" role="alert">{error}</div>}
              <div className="sess-pop__hint">{t('branch.handoff.footer', { engine: fromLabel })}</div>
            </div>
          </ViewportPopover>
        </div>,
        document.body,
      )}
      {confirmFor && (
        <ConfirmDialog
          title={t('branch.handoff.confirmTitle', { engine: confirmFor.engine.label })}
          message={[
            t(confirmFor.state === 'idle' ? 'branch.handoff.confirmMsg' : 'branch.handoff.confirmNewMsg',
              { engine: confirmFor.engine.label, from: fromLabel }),
            ...(confirmFor.pending.goal ? [t('branch.handoff.confirmGoal', { engine: confirmFor.engine.label })] : []),
          ].join('\n\n')}
          confirmLabel={t('branch.handoff.confirm')}
          onConfirm={() => { const target = confirmFor; setConfirmFor(null); void run(target) }}
          onClose={() => setConfirmFor(null)}
        />
      )}
    </>
  )
}
