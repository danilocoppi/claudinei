import { parseIcon, useIconBody } from '../icons'

/**
 * Desenha o ícone de um terminal, grupo ou setor — emoji ou qualquer um dos ~250
 * mil desenhos do acervo. Um lugar só: sem isto, cada tela que mostra `{p.icon}`
 * precisaria saber dos formatos, e um formato novo seria uma varredura.
 *
 * O miolo do SVG vem do servidor já com `currentColor`. Cor de marca (o azul do
 * Docker) é mais reconhecível, mas some no tema que por acaso tiver o mesmo fundo
 * — e o cartão do terminal já carrega a cor dele no trilho da esquerda.
 */
export function Icon({ value, size, className }: { value?: string | null; size?: number; className?: string }) {
  const parsed = parseIcon(value)
  const icon = useIconBody(parsed.kind === 'iconify' ? parsed.token : null)
  const cls = ['icon', className].filter(Boolean).join(' ')
  const px = size ?? 16

  if (parsed.kind === 'emoji') {
    return <span className={cls} style={{ fontFamily: 'var(--emoji), inherit' }}>{parsed.char}</span>
  }

  // Enquanto o desenho não chegou (ou o token não existe mais), o espaço é
  // reservado em vez de a linha "pular" quando ele aparecer.
  if (!icon) return <span className={cls} style={{ width: px, height: px, display: 'inline-block' }} />

  return (
    <svg className={cls} width={px} height={px} viewBox={`0 0 ${icon.width} ${icon.height}`}
         aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon.body }} />
  )
}
