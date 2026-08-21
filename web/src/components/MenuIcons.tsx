/**
 * Os desenhos do enxoval do menu.
 *
 * São ícones de CHROME, não de conteúdo: vêm inline em vez de sair do acervo
 * (`<Icon>`) porque acervo é escolha do usuário e chega pela rede — um menu não
 * pode abrir com buracos que preenchem depois.
 *
 * Todos na mesma anatomia (traço de 2 em caixa de 24, pontas redondas), para que
 * a coluna de ícones do menu leia como uma coluna e não como uma colagem. Antes
 * eram emoji improvisados — um TECLADO para o VS Code, um bloco cheio (▮) para o
 * terminal, uma ETIQUETA para copiar caminho — que nem diziam a ação nem pegavam
 * a cor do tema.
 */
const Glyph = ({ size = 15, children }: { size?: number; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

/** As três bolinhas de "mais opções". Um desenho só para os três lugares que abrem
 *  esse menu — cartão, grupo e setor —, senão eles voltam a divergir. */
export const MoreIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
  </svg>
)

export const EditIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.4 2.6a1.9 1.9 0 0 1 2.7 2.7l-9 9-3.6 1 1-3.6z" />
  </Glyph>
)

export const FolderIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M6 14.5 7.5 11a2 2 0 0 1 1.8-1.1H20a1.5 1.5 0 0 1 1.4 2l-1.6 5.6a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.6.9H18a2 2 0 0 1 2 2v1.9" />
  </Glyph>
)

/** `</>` — o editor de código. Genérico de propósito: o comando cai no `codium`
 *  quando o VS Code não está, e a marca do VS Code ali seria uma meia-verdade. */
export const CodeIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" />
  </Glyph>
)

/** `>_` numa janela: o prompt, e não um bloco cheio que não dizia nada. */
export const TerminalIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="m7 11 2-2-2-2" /><path d="M11.5 13H15" />
  </Glyph>
)

/** Duas folhas sobrepostas: o gesto universal de copiar. */
export const CopyIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </Glyph>
)

export const TrashIcon = ({ size }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" /><path d="M14 11v6" />
  </Glyph>
)
