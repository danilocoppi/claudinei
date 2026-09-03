import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { lazy, Suspense } from 'react'

// `emoji-picker-react` era 18,6% do bundle — carregado na tela de login para uma
// aba que só abre quando se troca o ícone de um projeto. Baixa quando a aba abre.
const EmojiPicker = lazy(() => import('./EmojiPicker').then((m) => ({ default: m.EmojiPicker })))
import { Icon } from './Icon'
import { searchIcons } from '../api'
import { parseIcon, rememberIcons, type IconBody } from '../icons'

/**
 * Seletor de ícone sobre ~250 mil desenhos.
 *
 * UMA caixa de busca para tudo. O seletor antigo tinha uma aba por acervo e uma
 * busca por aba — quem procurava "servidor" tinha que repetir a busca em cada aba
 * para descobrir onde estava o desenho. Aqui o acervo é resultado, não pergunta:
 * a busca varre tudo e os resultados chegam agrupados por origem, para quem quer
 * um traço coerente conseguir escolher.
 *
 * O emoji continua ao lado porque é de outra natureza — é caractere, não desenho,
 * e é o único que não depende do servidor.
 */

/** Nome de gente para o prefixo do acervo. O que não estiver aqui usa o prefixo. */
const SET_LABEL: Record<string, string> = {
  lucide: 'Lucide',
  tabler: 'Tabler',
  'material-symbols': 'Material Symbols',
  ph: 'Phosphor',
  mdi: 'Material Design',
  'simple-icons': 'Marcas',
  'fa6-solid': 'Font Awesome',
  'fa6-brands': 'Font Awesome · marcas',
  carbon: 'Carbon',
  solar: 'Solar',
  hugeicons: 'Huge Icons',
  'game-icons': 'Game Icons',
  devicon: 'Devicon',
  logos: 'Logos',
  bi: 'Bootstrap',
  octicon: 'Octicons',
  ri: 'Remix',
  fluent: 'Fluent',
  streamline: 'Streamline',
}

/**
 * O que aparece antes de digitar. Uma grade vazia não ensina nada; estes são os
 * desenhos que a maioria dos terminais acaba usando, e servem de amostra do que
 * a busca alcança.
 */
const SUGGESTED = [
  'lucide:terminal', 'lucide:server', 'lucide:database', 'lucide:globe',
  'lucide:code', 'lucide:rocket', 'lucide:shield', 'lucide:users',
  'lucide:wallet', 'lucide:package', 'lucide:cloud', 'lucide:cpu',
  'lucide:git-branch', 'lucide:folder', 'lucide:bug', 'lucide:chart-bar',
  'lucide:bell', 'lucide:calendar', 'lucide:settings', 'lucide:zap',
  'lucide:brain', 'lucide:store', 'lucide:truck', 'lucide:flask-conical',
]

/** Digitar não pode virar uma busca por letra. */
const DEBOUNCE_MS = 220

export function IconPicker({ value, onSelect, onClose }: {
  value?: string
  onSelect: (icon: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'search' | 'emoji'>(() => (parseIcon(value).kind === 'emoji' && value ? 'emoji' : 'search'))
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IconBody[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); setBusy(false); return }
    setBusy(true)
    const timer = setTimeout(() => {
      let vivo = true
      void searchIcons(q)
        .then((icons) => {
          if (!vivo) return
          // Os desenhos já vieram na resposta da busca: guardar aqui evita que a
          // grade peça de novo, um por um, o que acabou de chegar.
          rememberIcons(icons)
          setResults(icons)
        })
        .catch(() => { if (vivo) setResults([]) })
        .finally(() => { if (vivo) setBusy(false) })
      return () => { vivo = false }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  /** Agrupado por acervo, na ordem em que o servidor ranqueou. */
  const groups = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const icon of results ?? []) {
      const prefix = icon.token.slice(0, icon.token.indexOf(':'))
      const list = out.get(prefix)
      if (list) list.push(icon.token)
      else out.set(prefix, [icon.token])
    }
    return [...out]
  }, [results])

  const pick = (token: string) => { onSelect(token); onClose() }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="icon-picker glass" onClick={(e) => e.stopPropagation()}>
        <div className="icon-picker__tabs">
          <button type="button" data-testid="icon-tab-search"
                  className={`ap-pill ${tab === 'search' ? 'on' : ''}`} onClick={() => setTab('search')}>
            {t('icons.tab.icons')}
          </button>
          <button type="button" data-testid="icon-tab-emoji"
                  className={`ap-pill ${tab === 'emoji' ? 'on' : ''}`} onClick={() => setTab('emoji')}>
            {t('icons.tab.emoji')}
          </button>
        </div>

        {tab === 'emoji' ? (
          <Suspense fallback={<div className="icon-picker__loading">…</div>}>
            <EmojiPicker inline onSelect={(emoji) => pick(emoji)} onClose={onClose} />
          </Suspense>
        ) : (
          <>
            <input
              className="icon-picker__search" autoFocus data-testid="icon-search"
              value={query} placeholder={t('icons.search')}
              onChange={(e) => setQuery(e.target.value)}
            />

            {results === null ? (
              <>
                <div className="icon-picker__hint">{t('icons.hint')}</div>
                <div className="icon-picker__grid" data-testid="icon-grid">
                  {SUGGESTED.map((token) => <Cell key={token} token={token} on={value === token} onPick={pick} />)}
                </div>
              </>
            ) : results.length === 0 ? (
              <div className="icon-picker__empty" data-testid="icon-empty">
                {busy ? t('common.loading') : t('icons.none')}
              </div>
            ) : (
              <div className="icon-picker__sets">
                {groups.map(([prefix, tokens]) => (
                  <div key={prefix} className="icon-picker__set" data-testid="icon-group">
                    <div className="icon-picker__set-name">
                      {SET_LABEL[prefix] ?? prefix}<span>{tokens.length}</span>
                    </div>
                    <div className="icon-picker__grid">
                      {tokens.map((token) => <Cell key={token} token={token} on={value === token} onPick={pick} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="icon-picker__foot">
              <span>{results === null ? t('icons.total') : t('icons.showing', { n: results.length })}</span>
              {busy && <span className="icon-picker__busy">{t('common.loading')}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Cell({ token, on, onPick }: { token: string; on: boolean; onPick: (t: string) => void }) {
  return (
    <button type="button" title={token} data-testid="icon-cell"
            className={`icon-picker__cell ${on ? 'on' : ''}`} onClick={() => onPick(token)}>
      <Icon value={token} size={22} />
    </button>
  )
}
