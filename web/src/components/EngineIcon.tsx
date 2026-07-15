// Token do ícone do Codex: o backend (server codex-engine.ts, servido em /api/engines)
// manda a string 'openai' e o frontend renderiza o logomark oficial como SVG JSX de
// verdade — sem injetar HTML. Fonte da verdade é o backend; esta constante é o mesmo
// token usado no fallback do store enquanto /api/engines não respondeu.
export const OPENAI_ICON = 'openai'

/** Logomark oficial da OpenAI, monocromático (herda currentColor), 1em. */
function OpenAILogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 22.98a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}

// Tokens de logo conhecidos → componente SVG. Qualquer outro `icon` (✳/◇/emoji) é
// renderizado como glyph de texto.
const LOGO_TOKENS: Record<string, () => JSX.Element> = { [OPENAI_ICON]: OpenAILogo }

/** Ícone de uma engine: SVG de um logo conhecido (ex.: OpenAI no Codex) ou glyph de texto. */
export function EngineIcon({ icon, className, title }: { icon?: string; className?: string; title?: string }) {
  if (!icon) return null
  const Logo = LOGO_TOKENS[icon]
  if (Logo) {
    return (
      <span className={`engine-icon${className ? ' ' + className : ''}`} title={title} aria-hidden="true">
        <Logo />
      </span>
    )
  }
  return (
    <span className={className} title={title} aria-hidden="true">
      {icon}
    </span>
  )
}
