import { useDeferredValue, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmojiPicker } from './EmojiPicker'
import { Icon } from './Icon'
import { allBrands, allLucide, iconToken, parseIcon, useIconSet, type IconSet } from '../icons'

type Tab = 'emoji' | IconSet

/** Quantos desenhos a grade mostra de uma vez. */
const PAGE = 300

/**
 * Seletor de ícone com os três acervos: emoji, logos de marca e ícones de linha —
 * mais de seis mil ao todo.
 *
 * A grade mostra um pedaço de cada vez. Seis mil nós de SVG de uma vez travam a
 * aba por segundos, e ninguém percorre seis mil ícones com os olhos: quem sabe o
 * que quer, busca.
 */
export function IconPicker({ value, onSelect, onClose }: {
  value?: string
  onSelect: (icon: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(() => {
    const kind = parseIcon(value).kind
    return kind === 'emoji' ? 'emoji' : kind
  })
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  // A busca filtra milhares de itens: adiar mantém a digitação fluida enquanto a
  // grade se refaz.
  const search = useDeferredValue(query).trim().toLowerCase()

  // A versão muda quando o conjunto termina de carregar — é ela que refaz a lista.
  // (Chamar o hook dentro do array de dependências "funcionava", mas escondia que
  // há um hook ali e convidava a próxima pessoa a reordenar o array.)
  const loaded = useIconSet(tab === 'emoji' ? null : tab)

  const items = useMemo(() => {
    if (tab === 'brand') {
      return allBrands()
        .filter((b) => !search || b.t.toLowerCase().includes(search) || b.s.includes(search))
        .map((b) => ({ token: iconToken('brand', b.s), label: b.t }))
    }
    if (tab === 'lucide') {
      return allLucide()
        .filter((n) => !search || n.includes(search))
        .map((n) => ({ token: iconToken('lucide', n), label: n.replace(/-/g, ' ') }))
    }
    return []
  }, [tab, search, loaded])

  const shown = items.slice(0, limit)

  if (tab === 'emoji') {
    return (
      <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="icon-picker glass" onClick={(e) => e.stopPropagation()}>
          <Tabs tab={tab} setTab={(x) => { setTab(x); setLimit(PAGE) }} />
          <EmojiPicker inline onSelect={(emoji) => { onSelect(emoji); onClose() }} onClose={onClose} />
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="icon-picker glass" onClick={(e) => e.stopPropagation()}>
        <Tabs tab={tab} setTab={(x) => { setTab(x); setLimit(PAGE); setQuery('') }} />
        <input
          className="icon-picker__search" autoFocus data-testid="icon-search"
          value={query} placeholder={t('icons.search')}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE) }}
        />
        <div className="icon-picker__grid" data-testid="icon-grid">
          {shown.map((it) => (
            <button key={it.token} type="button" title={it.label}
                    className={`icon-picker__cell ${value === it.token ? 'on' : ''}`}
                    onClick={() => { onSelect(it.token); onClose() }}>
              <Icon value={it.token} size={22} />
            </button>
          ))}
        </div>
        <div className="icon-picker__foot">
          {items.length === 0
            ? <span>{t('icons.none')}</span>
            : <span>{t('icons.showing', { n: shown.length, total: items.length })}</span>}
          {items.length > shown.length && (
            <button className="ghost" onClick={() => setLimit((l) => l + PAGE)}>{t('icons.more')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { t } = useTranslation()
  return (
    <div className="icon-picker__tabs">
      {(['emoji', 'brand', 'lucide'] as Tab[]).map((id) => (
        <button key={id} type="button" data-testid={`icon-tab-${id}`}
                className={`ap-pill ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
          {t(`icons.tab.${id}` as 'icons.tab.emoji')}
        </button>
      ))}
    </div>
  )
}
