import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../types'
import { setSessionOptions, type PermissionMode } from '../api'
import { WsContext } from '../wsContext'
import { useStore, useEngineFor, useSessionSlashCommands } from '../store'
import { MODE_KEY, MODE_COLOR } from '../permissionLabels'

/** Chaves i18n dos rótulos de modelo conhecidos (hoje só os do Claude). Modelos
 * sem entrada aqui (ex.: Codex) usam o próprio id como label. */
const MODEL_KEY: Record<string, string> = { '': 'session.modelDefault', fable: 'session.modelFable', opus: 'session.modelOpus', sonnet: 'session.modelSonnet', haiku: 'session.modelHaiku' }

export function SessionControls({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const addLocalUserText = useStore((st) => st.addLocalUserText)
  const effort = useStore((st) => st.sessionEffort[session.localId] ?? session.effort ?? 'auto')
  const engine = useEngineFor(session)
  const models = engine?.models ?? []
  const efforts = engine?.efforts ?? []
  const permissions = engine?.permissions ?? []
  // Lista de slash da sessão (protocolo do Claude ou curada de outra engine) — decide
  // se o /effort é enviado como mensagem de chat, sem hardcode por engine.
  const slashCommands = useSessionSlashCommands(session)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, right: 0 })
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const disabled = session.status === 'working'
  const mode = (session.permissionMode ?? 'bypassPermissions') as PermissionMode
  const model = session.model ?? ''

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    // alinha a borda DIREITA do popover à do pill (que fica colado ao Enviar,
    // perto da borda da tela) — abre para a esquerda, sem cortar no viewport.
    if (r) setPos({ bottom: window.innerHeight - r.top + 8, right: window.innerWidth - r.right })
    setOpen((o) => !o)
  }
  // Sem control_request para effort no protocolo — quando a sessão tem 'effort' na
  // lista de slash (protocolo do Claude traz; curada de outras engines pode não
  // trazer), ele é um slash command headless-executável (spike 2026-07-12): envia
  // como mensagem normal e a confirmação volta pelo chat, movendo o ✓ (farejador
  // no store). Decisão dirigida pela lista de slash da sessão — SEM hardcode por engine.
  const applyEffort = (level: string) => {
    if (slashCommands.includes('effort')) {
      const text = `/effort ${level}`
      ws?.send({ type: 'send_message', localId: session.localId, text })
      addLocalUserText(session.localId, text)
    }
    // persiste para o relaunch (--effort); ultracode é por sessão — a flag de
    // launch não o aceita, então não persistimos (a dica no popover explica)
    if (level !== 'ultracode') void setSessionOptions(session.localId, { effort: level }).catch(() => {})
    setFlash(true); setTimeout(() => setFlash(false), 1200)
  }

  const apply = async (opts: { model?: string; permissionMode?: PermissionMode }) => {
    setError(null)
    try {
      await setSessionOptions(session.localId, opts)
      setFlash(true); setTimeout(() => setFlash(false), 1200)
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <>
      <button ref={ref} data-testid="session-controls-pill" className="input-action sess-pill" disabled={disabled}
              title={disabled ? t('controls.workingHint') : t('controls.title')} onClick={toggle}>
        <span className="sess-pill__gear" style={{ color: MODE_COLOR[mode] }}>⚙</span>
        {flash && <span className="sess-pill__flash">✓</span>}
      </button>
      {open && createPortal(
        <div className="sess-pop__overlay" onClick={() => setOpen(false)}>
          <div className="sess-pop glass" style={{ bottom: pos.bottom, right: pos.right }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__eyebrow">{t('controls.model')}</div>
            {models.map((m) => (
              <div key={m || 'default'} className={`sess-pop__item ${m === model ? 'active' : ''}`} onClick={() => void apply({ model: m || undefined })}>
                <span>{MODEL_KEY[m] ? t(MODEL_KEY[m] as any) : m}</span>{m === model && <span className="sess-pop__check">✓</span>}
              </div>
            ))}
            <div className="sess-pop__eyebrow">{t('controls.effort')}</div>
            {efforts.map((lvl) => (
              <div key={lvl} className={`sess-pop__item ${lvl === effort ? 'active' : ''}`} onClick={() => applyEffort(lvl)}>
                <span style={{ flex: 1 }}>{lvl === 'auto' ? t('session.effortAuto') : lvl}</span>
                {lvl === effort && <span className="sess-pop__check">✓</span>}
              </div>
            ))}
            {permissions.length > 0 && (
              <>
                <div className="sess-pop__eyebrow">{t('controls.permission')}</div>
                {permissions.map((m) => (
                  <div key={m} className={`sess-pop__item ${m === mode ? 'active' : ''}`} onClick={() => void apply({ permissionMode: m as PermissionMode })}>
                    <span className="sess-pill__dot" style={{ background: MODE_COLOR[m as PermissionMode] }} />
                    <span style={{ flex: 1 }}>{t(MODE_KEY[m as PermissionMode] as any)}</span>{m === mode && <span className="sess-pop__check">✓</span>}
                  </div>
                ))}
              </>
            )}
            {effort === 'ultracode' && <div className="sess-pop__warn">{t('session.effortUltracodeHint')}</div>}
            {permissions.length > 0 && mode !== 'bypassPermissions' && <div className="sess-pop__warn">{t('session.permWarning')}</div>}
            {error && <div className="sess-pop__error">⚠ {error}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
