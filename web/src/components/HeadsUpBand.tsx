import { useContext, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { dismissOf, type HeadsUpCard } from '../headsUp'
import type { HeadsUpNode } from '../types'

type Press = { plugin: string; handle: number; key?: string }

/**
 * Avisos do plugin "You should know" do Claude, acima do campo de digitação —
 * onde o terminal interativo os mostra. O servidor anexa o terminal como a
 * superfície `desktop` e repassa o cartão que o plugin desenha (a mesma árvore
 * que o app Desktop recebe); aqui ela vira HTML, os botões voltam ao plugin, e o
 * botão de dispensar dele vira o X. Vários avisos empilham: o mais novo embaixo,
 * perto do campo; os antigos ficam só para ler, até o X deles.
 */
export function HeadsUpBand({ localId }: { localId: string }) {
  const { t } = useTranslation()
  const cards = useStore((s) => s.headsUps[localId])
  const dismiss = useStore((s) => s.dismissHeadsUp)
  const ws = useContext(WsContext)
  if (!cards || cards.length === 0) return null

  const press = (p: Press) => ws?.send({ type: 'heads_up_press', localId, press: p })
  const close = (card: HeadsUpCard) => {
    const own = card.live ? dismissOf(card.tree) : null
    if (own) press(own)
    dismiss(localId, card.id)
  }

  return (
    <section className="heads-up-band" aria-label={t('headsUp.region')}>
      {cards.map((card) => (
        <article key={card.id} className={`heads-up${card.live ? '' : ' heads-up--old'}`}>
          <div className="heads-up__body">
            <HeadsUpTree node={card.tree} onPress={card.live ? press : null} />
          </div>
          <button type="button" className="heads-up__close" aria-label={t('headsUp.close')} title={t('headsUp.close')}
                  onClick={() => close(card)}>×</button>
        </article>
      ))}
    </section>
  )
}

/** Cores do plugin: chaves do tema do CLI → variáveis do Claudinei; cor crua passa. */
const THEME_COLORS: Record<string, string> = {
  warning: 'var(--warn)', error: 'var(--err)', success: 'var(--ok)',
  claude: 'var(--accent)', suggestion: 'var(--accent)', permission: 'var(--accent)', secondaryText: 'var(--text-dim)',
}
const colorOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value === '') return undefined
  if (THEME_COLORS[value]) return THEME_COLORS[value]
  return /^(#[0-9a-f]{3,8}|rgb\(|hsl\()/i.test(value) ? value : undefined
}
/** Medidas do plugin vêm em células do terminal. */
const cells = (value: unknown, px: number) => (typeof value === 'number' ? value * px : undefined)

const textStyle = (props: Record<string, unknown>): CSSProperties => ({
  fontWeight: props.bold === true || props.weight === 'bold' || props.weight === 'semibold' ? 600 : undefined,
  fontStyle: props.italic === true ? 'italic' : undefined,
  textDecoration: [props.underline === true && 'underline', props.strikethrough === true && 'line-through'].filter(Boolean).join(' ') || undefined,
  color: colorOf(props.color),
  opacity: props.dimColor === true ? 0.7 : undefined,
  fontFamily: props.mono === true ? 'var(--font-code)' : undefined,
})

const boxStyle = (props: Record<string, unknown>): CSSProperties => ({
  display: props.display === 'none' ? 'none' : 'flex',
  // Como no Ink do terminal: Box é linha, a menos que o plugin diga coluna.
  flexDirection: props.flexDirection === 'column' ? 'column' : 'row',
  flexWrap: 'wrap',
  alignItems: props.flexDirection === 'column' ? 'stretch' : 'baseline',
  gap: cells(props.gap, 6) ?? (props.flexDirection === 'column' ? 4 : 6),
  padding: cells(props.padding, 4),
  marginTop: cells(props.marginTop, 4),
  marginBottom: cells(props.marginBottom, 4),
})

const markdownLinks = (open: (href: string) => void): Components => ({
  a: ({ href, children }) => (href && /^https?:\/\//i.test(href)
    ? <a href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); open(href) }}>{children}</a>
    : <span>{children}</span>),
})

/** Desenha a árvore do plugin. `onPress` null = cartão antigo: botões só para ler. */
export function HeadsUpTree({ node, onPress }: { node: HeadsUpNode; onPress: ((p: Press) => void) | null }) {
  const openExternalLink = useStore((s) => s.openExternalLink)
  const draw = (n: HeadsUpNode, i: number): ReactNode => {
    if (typeof n === 'string') return n
    const props = n.props ?? {}
    const kids = (n.children ?? []).map(draw)
    switch (n.type) {
      case 'Box': case 'div':
        return <div key={i} style={boxStyle(props)}>{kids}</div>
      case 'span':
        return <span key={i}>{kids}</span>
      case 'b':
        return <strong key={i}>{kids}</strong>
      case 'Text':
        return <span key={i} style={textStyle(props)}>{kids}</span>
      case 'Button': {
        // O de dispensar é o X do cartão, não um botão a mais no corpo.
        if (props.role === 'dismiss') return null
        const label = typeof props.label === 'string' ? props.label : ''
        const key = typeof props.key === 'string' ? props.key : undefined
        const press = n.press
        return (
          <button key={i} type="button" aria-label={label || undefined}
                  className={`heads-up__btn${props.variant === 'primary' ? ' heads-up__btn--primary' : ''}`}
                  disabled={!onPress || !press}
                  onClick={() => { if (onPress && press) onPress({ ...press, ...(key ? { key } : {}) }) }}>
            {kids.length > 0 ? kids : label}
          </button>
        )
      }
      case 'Link': {
        const href = typeof props.href === 'string' ? props.href : ''
        const label = kids.length > 0 ? kids : (typeof props.label === 'string' ? props.label : href)
        // Só http/https vira link (como o CLI manda): o resto é texto.
        if (!/^https?:\/\//i.test(href)) return <span key={i}>{label}</span>
        return <a key={i} href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternalLink(href) }}>{label}</a>
      }
      case 'Markdown':
        return (
          <div key={i} className="markdown heads-up__md" style={props.dimColor === true ? { opacity: 0.7 } : undefined}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinks(openExternalLink)}>
              {typeof props.text === 'string' ? props.text : ''}
            </ReactMarkdown>
          </div>
        )
      case 'Code':
        return <pre key={i} className="heads-up__code"><code>{typeof props.source === 'string' ? props.source : ''}</code></pre>
      case 'Progress':
        return <span key={i} style={{ color: 'var(--text-dim)' }}>{String(props.label ?? '')} {String(props.valueText ?? '')}</span>
      default:
        // Input, Select, Client, Svg: o cartão de aviso não usa; ficam de fora.
        return null
    }
  }
  return <>{draw(node, 0)}</>
}
