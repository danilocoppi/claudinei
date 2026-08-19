import { parseIcon, brandPath, lucideNodes, useIconSet, type ParsedIcon } from '../icons'

/**
 * Desenha o ícone de um terminal, grupo ou setor — seja ele emoji, logo de marca
 * ou ícone de linha. Um lugar só: sem isto, cada tela que mostra `{p.icon}`
 * precisaria saber dos três formatos, e um formato novo seria uma varredura.
 *
 * Os SVGs usam `currentColor` de propósito. Cor de marca (o azul do Docker) é mais
 * reconhecível, mas some no tema que por acaso tiver o mesmo fundo — e o cartão do
 * terminal já carrega a cor dele no trilho da esquerda.
 */
export function Icon({ value, size, className }: { value?: string | null; size?: number; className?: string }) {
  const parsed = parseIcon(value)
  const set = parsed.kind === 'emoji' ? null : parsed.kind
  useIconSet(set)   // re-renderiza quando o conjunto termina de carregar
  return <IconGlyph parsed={parsed} size={size} className={className} />
}

function IconGlyph({ parsed, size, className }: { parsed: ParsedIcon; size?: number; className?: string }) {
  const cls = ['icon', className].filter(Boolean).join(' ')
  const px = size ?? 16

  if (parsed.kind === 'brand') {
    const d = brandPath(parsed.id)
    // Enquanto o conjunto não chegou (ou o slug não existe mais), o espaço é
    // reservado em vez de a linha "pular" quando o desenho aparecer.
    if (!d) return <span className={cls} style={{ width: px, height: px, display: 'inline-block' }} />
    return (
      <svg className={cls} width={px} height={px} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={d} />
      </svg>
    )
  }

  if (parsed.kind === 'lucide') {
    const nodes = lucideNodes(parsed.id)
    if (!nodes) return <span className={cls} style={{ width: px, height: px, display: 'inline-block' }} />
    return (
      <svg className={cls} width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {nodes.map(([tag, attrs], i) => {
          const Tag = tag as 'path'
          return <Tag key={i} {...(attrs as Record<string, string>)} />
        })}
      </svg>
    )
  }

  return <span className={cls} style={{ fontFamily: 'var(--emoji), inherit' }}>{parsed.char}</span>
}
