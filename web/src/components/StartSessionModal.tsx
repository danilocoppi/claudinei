import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { startSession, type PermissionMode } from '../api'
import { useStore } from '../store'
import { MODE_KEY } from '../permissionLabels'
import { EngineIcon } from './EngineIcon'

/** Chaves i18n dos rótulos de modelo conhecidos (hoje só os do Claude). Modelos
 * sem entrada aqui (ex.: Codex) usam o próprio id como label. */
const MODEL_KEY: Record<string, string> = {
  '': 'session.modelDefault', fable: 'session.modelFable', opus: 'session.modelOpus', sonnet: 'session.modelSonnet', haiku: 'session.modelHaiku',
}

// Últimas escolhas do operador (engine global; model/permission POR engine) — sem
// isto, toda sessão nova voltava aos defaults (sintoma: "restartei o servidor e
// perdi a escolha do model": sessão nova em vez de revive → tudo default).
const LAST_ENGINE_KEY = 'claudinei:lastEngine'
const lastModelKey = (id: string) => `claudinei:lastModel:${id}`
const lastPermissionKey = (id: string) => `claudinei:lastPermission:${id}`
const recall = (k: string): string => { try { return localStorage.getItem(k) ?? '' } catch { return '' } }
const remember = (k: string, v: string) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k) } catch { /* sem storage: só não lembra */ }
}

export function StartSessionModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation()
  const openSession = useStore((s) => s.openSession)
  const engines = useStore((s) => s.engines)
  const [engineId, setEngineId] = useState(() => recall(LAST_ENGINE_KEY) || 'claude')
  const [continueConversation, setContinueConversation] = useState(true)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => (recall(lastPermissionKey(recall(LAST_ENGINE_KEY) || 'claude')) || 'bypassPermissions') as PermissionMode,
  )
  const [model, setModel] = useState(() => recall(lastModelKey(recall(LAST_ENGINE_KEY) || 'claude')))
  const [error, setError] = useState('')

  const engine = engines.find((e) => e.id === engineId) ?? engines.find((e) => e.id === 'claude') ?? engines[0]
  const models = engine?.models ?? []
  const permissions = engine?.permissions ?? []
  // Valida o lembrado contra as listas atuais da engine (model removido/lista ainda
  // carregando → Padrão; permission desconhecida → bypass) — nunca submete valor inválido.
  const modelValue = models.includes(model) ? model : ''
  const permissionValue = permissions.includes(permissionMode) ? permissionMode : 'bypassPermissions'

  const pickEngine = (id: string) => {
    setEngineId(id)
    // a lista de modelos muda por engine — carrega o lembrado DELA (não vaza entre engines)
    setModel(recall(lastModelKey(id)))
    setPermissionMode((recall(lastPermissionKey(id)) || 'bypassPermissions') as PermissionMode)
  }

  const submit = async () => {
    try {
      const info = await startSession(project.id, {
        continueConversation,
        ...(permissions.length > 0 ? { permissionMode: permissionValue } : {}),
        ...(modelValue ? { model: modelValue } : {}),
        engine: engine?.id ?? engineId,
      })
      remember(LAST_ENGINE_KEY, engine?.id ?? engineId)
      remember(lastModelKey(engine?.id ?? engineId), modelValue)
      if (permissions.length > 0) remember(lastPermissionKey(engine?.id ?? engineId), permissionValue)
      openSession(info.localId)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="glass"
        style={{ width: 460, maxWidth: 'calc(100vw - 32px)', borderRadius: 16, padding: 22, cursor: 'default' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontSize: 24, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 12, background: 'rgba(0,0,0,.25)', border: `1px solid ${project.color}`, flex: 'none',
            }}
          >
            {project.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>{t('session.title')}</h3>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.name}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          {engines.length > 0 && (
            <div className="engine-picker" role="group" aria-label={t('session.engine')}>
              {engines.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`engine-picker__btn ${e.id === engineId ? 'active' : ''}`}
                  disabled={e.available === false}
                  title={e.available === false
                    ? `${t('chat.engineNotInstalledHint')}${e.installHint ? ` — ${e.installHint}` : ''}`
                    : undefined}
                  onClick={() => pickEngine(e.id)}
                >
                  <EngineIcon className="engine-picker__icon" icon={e.icon} />
                  <span>{e.label}</span>
                  {e.available === false && <span className="engine-picker__missing">{t('chat.engineNotInstalled')}</span>}
                </button>
              ))}
            </div>
          )}

          <label className="option-row">
            <div className="opt-text">
              <div className="opt-title">{t('session.model')}</div>
              <div className="opt-desc">{t('session.modelDesc')}</div>
            </div>
            <select
              aria-label={t('session.model')}
              value={modelValue}
              onChange={(e) => setModel(e.target.value)}
              style={{
                background: 'rgba(0,0,0,.25)', color: 'var(--text)', border: '1px solid rgba(255,255,255,.15)',
                borderRadius: 8, padding: '6px 10px', fontSize: 13, flex: 'none',
              }}
            >
              {models.map((m) => (
                <option key={m || 'default'} value={m}>{MODEL_KEY[m] ? t(MODEL_KEY[m] as any) : m}</option>
              ))}
            </select>
          </label>

          <label className="option-row">
            <div className="opt-text">
              <div className="opt-title">{t('session.continueTitle')}</div>
              <div className="opt-desc">{t('session.continueDesc')}</div>
            </div>
            <span className="switch">
              <input
                type="checkbox"
                aria-label={t('session.continueTitle')}
                checked={continueConversation}
                onChange={(e) => setContinueConversation(e.target.checked)}
              />
              <span className="track" />
              <span className="thumb" />
            </span>
          </label>

          {permissions.length > 0 && (
            <label className="option-row">
              <div className="opt-text">
                <div className="opt-title">{t('session.skipTitle')}</div>
                <div className="opt-desc">{t('session.skipDesc')}</div>
              </div>
              <select
                aria-label={t('session.skipTitle')}
                value={permissionValue}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                style={{
                  background: 'rgba(0,0,0,.25)', color: 'var(--text)', border: '1px solid rgba(255,255,255,.15)',
                  borderRadius: 8, padding: '6px 10px', fontSize: 13, flex: 'none',
                }}
              >
                {permissions.map((m) => (
                  <option key={m} value={m}>{t(MODE_KEY[m as PermissionMode] as any)}</option>
                ))}
              </select>
            </label>
          )}

          {permissions.length > 0 && permissionMode !== 'bypassPermissions' && (
            <div className="notice-warn">
              <span aria-hidden="true">⚠️</span>
              <span>{t('session.permWarning')}</span>
            </div>
          )}

          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button onClick={submit}>{t('session.start')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
