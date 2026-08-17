import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { completeSessionAuth, startSessionAuth } from '../api'

/**
 * Reautenticação do Claude sem sair da web.
 *
 * Quando o OAuth expira, a CLI passa a responder `auth_expired` e a sessão vira
 * uma sequência de erros de API sem explicação — o operador só descobre a causa
 * quando lembra de rodar `/login` no terminal. Aqui o fluxo é o mesmo que a TUI
 * usa, conduzido por control_request.
 *
 * O link é o `automaticUrl` (o navegador volta sozinho ao callback), mas o campo
 * de código fica disponível junto: se o Claudinei está aberto de outro
 * dispositivo, o redirect automático não alcança o servidor e o código colado é
 * a única saída. A CLI devolve as duas URLs na mesma resposta, então oferecer as
 * duas não custa nada.
 */
export function ReauthBanner({ localId, expired }: { localId: string; expired?: boolean }) {
  const { t } = useTranslation()
  const [urls, setUrls] = useState<{ manualUrl: string; automaticUrl: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!expired) return null

  const begin = async () => {
    setBusy(true); setError('')
    try { setUrls(await startSessionAuth(localId)) }
    catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  const finish = async () => {
    const value = code.trim()
    if (!value) return
    setBusy(true); setError('')
    try {
      await completeSessionAuth(localId, value)
      setUrls(null); setCode('')
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="reauth" role="alert">
      <div className="reauth__head">
        <span aria-hidden="true">🔑</span>
        <span>{t('engineAuth.expired')}</span>
        {!urls && (
          <button type="button" className="ghost" disabled={busy} onClick={() => void begin()}>
            {t('engineAuth.reauth')}
          </button>
        )}
      </div>
      {urls && (
        <div className="reauth__flow">
          <a className="reauth__link" href={urls.automaticUrl} target="_blank" rel="noreferrer">
            {t('engineAuth.openLogin')}
          </a>
          <div className="reauth__hint">{t('engineAuth.pasteHint')}</div>
          <div className="reauth__row">
            <input
              value={code}
              placeholder={t('engineAuth.codePlaceholder')}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void finish() }}
            />
            <button type="button" disabled={busy} onClick={() => void finish()}>{t('engineAuth.finish')}</button>
          </div>
        </div>
      )}
      {error && <div className="reauth__error">{error}</div>}
    </div>
  )
}
