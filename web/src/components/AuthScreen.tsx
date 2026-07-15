import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { login, setupMaster, type Me } from '../api'

/** Tela de login OU de criação do master (1º acesso). Padrão Glass, centrada. */
export function AuthScreen({ mode, onDone }: { mode: 'login' | 'setup'; onDone: (me: Me) => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'setup' && password !== confirm) {
      setError(t('auth.passwordsDontMatch'))
      return
    }
    setBusy(true)
    try {
      const me = mode === 'setup' ? await setupMaster(username, password) : await login(username, password)
      onDone(me)
    } catch (err) {
      const e2 = err as Error & { retryAfterMs?: number }
      if (e2.message === 'locked' && e2.retryAfterMs) {
        setError(t('auth.locked', { minutes: Math.ceil(e2.retryAfterMs / 60_000) }))
      } else if (e2.message === 'invalid_credentials') {
        setError(t('auth.invalidCredentials'))
      } else {
        setError(e2.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card glass" onSubmit={submit}>
        <div className="auth-card__logo"><span className="sidebar__logo-star">✳</span> Claudinei</div>
        <h1>{mode === 'setup' ? t('auth.setupTitle') : t('auth.signInTitle')}</h1>
        {mode === 'setup' && <p className="auth-card__hint">{t('auth.setupHint')}</p>}
        <label>
          {t('auth.username')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          {t('auth.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} />
        </label>
        {mode === 'setup' && (
          <label>
            {t('auth.confirmPassword')}
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <div className="auth-card__error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {mode === 'setup' ? t('auth.createMaster') : t('auth.signIn')}
        </button>
      </form>
    </div>
  )
}
