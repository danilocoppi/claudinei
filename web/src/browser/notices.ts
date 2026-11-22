import type { TFunction } from 'i18next'

/** O aviso do servidor para esquema recusado (o texto do agente, em inglês). */
const SCHEME_REFUSED = 'only http:, https: and about:blank URLs are allowed'
/** O `schemeOf` do servidor quando a URL não tem esquema legível. */
const UNKNOWN_SCHEME = 'an unknown scheme'

/**
 * Os avisos da aba (`state.notices`) chegam com o texto fixo do servidor, em
 * inglês, porque o agente lê os mesmos (terminal-tab.ts, baton.ts, input.ts).
 * Ao operador eles vão no idioma da tela: cada padrão conhecido vira a chave
 * `browser.notice.*` com as partes variáveis; o que não casar sai como veio.
 */
export function noticeText(n: string, t: TFunction): string {
  if (n === SCHEME_REFUSED) return t('browser.notices.schemeRefused')
  if (n === 'beforeunload accepted') return t('browser.notice.beforeunloadAccepted')
  if (n === 'file chooser cancelled (file upload is not supported)') return t('browser.notice.fileChooserCancelled')
  if (n === 'page crashed; use browser_navigate action=reload') return t('browser.notice.pageCrashed')
  if (n === 'control returned to the agent') return t('browser.notice.controlReturned')
  let m = /^dialog pending: (\w+) "([\s\S]*)"$/.exec(n)
  if (m) return t('browser.notice.dialogPending', { type: m[1], message: m[2] })
  m = /^alert accepted: "([\s\S]*)"$/.exec(n)
  if (m) return t('browser.notice.alertAccepted', { message: m[1] })
  // O nome pode ter vírgula: a URL vem depois do último ", from ".
  m = /^download blocked: ([\s\S]*), from ([\s\S]*)$/.exec(n)
  if (m) return t('browser.notice.downloadBlocked', { name: m[1], url: m[2] })
  m = /^navigation to ([\s\S]+) blocked; back to about:blank$/.exec(n)
  if (m) {
    return m[1] === UNKNOWN_SCHEME
      ? t('browser.notice.navigationBlockedUnknown')
      : t('browser.notice.navigationBlocked', { scheme: m[1] })
  }
  return n
}
