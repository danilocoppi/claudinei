import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { isForeignField } from '../keyboard'
import { closeFind, searchMore, startFind, stepFind } from '../chat/findRun'

/** Tamanho aceito pela rota de busca. */
const Q_MIN = 2
const Q_MAX = 200

/**
 * Barra de busca da conversa (Ctrl+F), no topo da coluna do chat, sem animação.
 *
 * Enter busca (consulta nova) ou vai à ocorrência mais antiga seguinte;
 * Shift+Enter volta à mais recente. Esc fecha e cancela o pedido no ar. A
 * contagem diz quantas achou enquanto varre, "i de n" depois, "500+" no teto e
 * oferece "buscar mais para trás" quando a rodada de 64 MB acabou antes do
 * começo da conversa.
 */
export function FindBar({ localId }: { localId: string }) {
  const { t } = useTranslation()
  const find = useStore((s) => (s.find?.localId === localId ? s.find : null))
  const [draft, setDraft] = useState(find?.q ?? '')
  const [tools, setTools] = useState(find?.tools ?? false)
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Esc fecha também com o foco na coluna do chat (fora de campos e de
  // modais): quem clicou numa mensagem depois de ir à ocorrência não precisa
  // voltar à barra. Fora da coluna — ou com o foco em nada — o Esc é de quem
  // está aberto lá (menu do usuário, controles da sessão, idioma, visualizador
  // de arquivo, que escutam a janela).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const alvo = e.target instanceof Element ? e.target : null
      const naBarra = !!alvo && !!barRef.current?.contains(alvo)
      const noChat = !!alvo?.closest('.chat-main') && !isForeignField(alvo, null)
        && !alvo.closest('.modal-overlay, [role="dialog"], [aria-modal="true"], [role="menu"], .xterm, [data-terminal]')
      if (!naBarra && !noChat) return
      e.preventDefault()
      closeFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = (q: string, withTools: boolean) => {
    if (q.length >= Q_MIN) startFind(localId, q, withTools)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    const q = draft.trim()
    if (!find || find.q !== q || find.tools !== tools || (find.error && find.hits.length === 0)) { run(q, tools); return }
    stepFind(e.shiftKey ? -1 : 1)
  }

  const onTools = (v: boolean) => {
    setTools(v)
    // Já há uma busca desta consulta: refaz com o novo alcance.
    if (find?.q && find.q === draft.trim()) run(find.q, v)
  }

  let status: string | null = null
  if (find?.q) {
    if (find.scanning) status = t('find.scanning', { n: find.hits.length })
    else if (find.error) status = find.error
    else if (find.hits.length > 0) status = t('find.count', { i: find.index + 1, n: find.hits.length })
    else if (find.atStart) status = t('find.none')
  }
  const podeMais = !!find?.q && !find.scanning && !find.atStart && !find.capped && find.before !== null && !find.error
  const temHits = !!find && find.hits.length > 0

  return (
    <div className="find-bar" ref={barRef} role="search">
      <input
        ref={inputRef}
        className="find-bar__input"
        type="text"
        value={draft}
        maxLength={Q_MAX}
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="find-bar__status" aria-live="polite">
        {status}
        {find?.capped && <span className="find-bar__capped">{t('find.capped')}</span>}
      </span>
      {podeMais && (
        <button type="button" className="ghost find-bar__more" onClick={() => searchMore()}>{t('find.more')}</button>
      )}
      <button type="button" className="ghost find-bar__step" disabled={!temHits}
              aria-label={t('find.older')} title={t('find.older')} onClick={() => stepFind(1)}>↑</button>
      <button type="button" className="ghost find-bar__step" disabled={!temHits}
              aria-label={t('find.newer')} title={t('find.newer')} onClick={() => stepFind(-1)}>↓</button>
      <label className="find-bar__tools">
        <input type="checkbox" checked={tools} onChange={(e) => onTools(e.target.checked)} />
        {t('find.tools')}
      </label>
      <button type="button" className="ghost find-bar__close" aria-label={t('common.close')} title={t('common.close')}
              onClick={() => closeFind()}>×</button>
    </div>
  )
}
