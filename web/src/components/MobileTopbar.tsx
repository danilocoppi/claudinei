import { useTranslation } from 'react-i18next'

/**
 * Barra superior do layout MOBILE (some no desktop via CSS).
 *
 * O botão da esquerda muda de papel conforme onde se está. Numa visão de
 * DETALHE (a conversa de um terminal) ele é um VOLTAR — porque é isso que ele
 * faz: traz de volta a lista de terminais. Nas demais visões continua o ☰, e
 * com a gaveta aberta vira ✕. Antes era sempre ☰: quem abria uma conversa no
 * celular ficava sem nenhum caminho de volta ÓBVIO, e o relato foi exatamente
 * esse — "não tem como voltar para a lista".
 */
export function MobileTopbar({ open, onToggle, title, onBack }: {
  open: boolean
  onToggle: () => void
  title: string
  /** Só nas visões de detalhe. Presente = o ☰ vira "voltar". */
  onBack?: () => void
}) {
  const { t } = useTranslation()
  // Gaveta aberta manda no ícone: ali o que resolve é fechar, não voltar.
  const voltar = !open && !!onBack
  return (
    <div className="mobile-topbar">
      <button
        type="button"
        className="mobile-topbar__menu"
        aria-label={voltar ? t('mobile.back') : t('mobile.menu')}
        aria-expanded={open}
        onClick={voltar ? onBack : onToggle}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {open ? <path d="M18 6 6 18M6 6l12 12" />
            : voltar ? <path d="M15 5l-7 7 7 7" />
            : <path d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>
      <span className="mobile-topbar__title">{title}</span>
    </div>
  )
}
