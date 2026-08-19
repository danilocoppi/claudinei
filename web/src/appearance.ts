/**
 * Aparência: traduz as CHAVES que o servidor guarda ("light-fun", "compact") nos
 * valores de CSS que a folha entende.
 *
 * A tradução mora aqui, e não no backend, por dois motivos: o servidor não precisa
 * saber nada de CSS (um pacote de tema novo não o obriga a mudar), e nada que veio
 * do banco entra numa regra de estilo sem passar por uma destas tabelas — uma
 * chave desconhecida cai no padrão em vez de virar CSS.
 */

export interface Appearance {
  theme: string
  chatWidth: string
  fontUi: string
  fontCode: string
  density: string
  accent: string
  radius: string
  glass: string
  reducedMotion: boolean
}

/** O padrão é a aparência de hoje: quem nunca abriu o painel não vê diferença. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark-fun',
  chatWidth: 'full',
  // Tudo começa em "do tema": é o PACOTE que decide fonte, densidade, cantos e
  // vidro, e a escolha do painel só existe para discordar dele. Sem esse sentinela
  // o painel escreveria sempre, e nenhum tema conseguiria nascer compacto ou chapado.
  fontUi: 'theme',
  fontCode: 'theme',
  density: 'theme',
  accent: 'theme',
  radius: 'theme',
  glass: 'theme',
  reducedMotion: false,
}

/** Primeira opção de toda lista: quem manda é o pacote. */
const FROM_THEME: Option = { id: 'theme', label: 'appearance.fromTheme' }

export interface Option { id: string; label: string; css?: string; css2?: string }

export const THEMES: Option[] = [
  { id: 'dark-fun', label: 'Dark Fun' },
  { id: 'light-fun', label: 'Light Fun' },
  { id: 'slate-pro', label: 'Slate Pro' },
  { id: 'paper-zen', label: 'Paper Zen' },
  { id: 'nord', label: 'Nord' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'phosphor', label: 'Phosphor' },
  { id: 'sepia', label: 'Sépia' },
  { id: 'high-contrast', label: 'appearance.themeHighContrast' },
  { id: 'midnight-ocean', label: 'Midnight Ocean' },
]

export const CHAT_WIDTHS: Option[] = [
  { id: 'full', label: 'appearance.widthFull', css: 'none' },
  { id: '800', label: '800 px', css: '800px' },
  { id: '1000', label: '1000 px', css: '1000px' },
  { id: '1200', label: '1200 px', css: '1200px' },
]

/**
 * Stacks do SISTEMA, não webfonts: o Claudinei roda local e empacotado — baixar de
 * CDN quebraria o uso offline e vazaria uma requisição a cada carga, e embutir dez
 * arquivos engordaria um binário que já tem 133 MB. Cada stack termina num
 * genérico, então a escolha degrada para algo são em qualquer máquina.
 */
export const UI_FONTS: Option[] = [
  FROM_THEME,
  { id: 'system', label: 'Sistema', css: 'system-ui, -apple-system, sans-serif' },
  { id: 'inter', label: 'Inter', css: 'Inter, system-ui, sans-serif' },
  { id: 'segoe', label: 'Segoe UI', css: '"Segoe UI", system-ui, sans-serif' },
  { id: 'roboto', label: 'Roboto', css: 'Roboto, system-ui, sans-serif' },
  { id: 'ubuntu', label: 'Ubuntu', css: 'Ubuntu, system-ui, sans-serif' },
  { id: 'helvetica', label: 'Helvetica', css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'condensed', label: 'Condensada', css: '"Roboto Condensed", "Arial Narrow", system-ui, sans-serif' },
  { id: 'rounded', label: 'Arredondada', css: '"SF Pro Rounded", "Varela Round", Quicksand, system-ui, sans-serif' },
  { id: 'serif', label: 'Serifada', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono-ui', label: 'Monoespaçada', css: 'ui-monospace, Menlo, Consolas, monospace' },
]

export const CODE_FONTS: Option[] = [
  FROM_THEME,
  { id: 'mono', label: 'Padrão', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', css: '"JetBrains Mono", ui-monospace, monospace' },
  { id: 'fira', label: 'Fira Code', css: '"Fira Code", ui-monospace, monospace' },
  { id: 'ibm', label: 'IBM Plex Mono', css: '"IBM Plex Mono", ui-monospace, monospace' },
  { id: 'cascadia', label: 'Cascadia Code', css: '"Cascadia Code", "Cascadia Mono", ui-monospace, monospace' },
  { id: 'courier', label: 'Courier', css: '"Courier New", Courier, monospace' },
]

export const DENSITIES: Option[] = [
  FROM_THEME,
  { id: 'comfortable', label: 'appearance.densityComfortable', css: '1' },
  { id: 'compact', label: 'appearance.densityCompact', css: '.8' },
]

/**
 * `theme` significa "a do pacote": cada tema afina o próprio roxo para o contraste
 * do seu fundo, e sobrescrevê-lo por padrão jogaria essa afinação fora.
 */
export const ACCENTS: Option[] = [
  { id: 'theme', label: 'appearance.fromTheme' },
  { id: 'blue', label: 'appearance.accentBlue', css: '#3b82f6', css2: '#60a5fa' },
  { id: 'teal', label: 'appearance.accentTeal', css: '#0e9aa7', css2: '#22c3d0' },
  { id: 'green', label: 'appearance.accentGreen', css: '#16a34a', css2: '#34d07a' },
  { id: 'amber', label: 'appearance.accentAmber', css: '#d97706', css2: '#f0a531' },
  { id: 'pink', label: 'appearance.accentPink', css: '#db2777', css2: '#f0559b' },
]

export const RADII: Option[] = [
  FROM_THEME,
  { id: 'square', label: 'appearance.radiusSquare', css: '4px' },
  { id: 'default', label: 'appearance.radiusDefault', css: '16px' },
  { id: 'round', label: 'appearance.radiusRound', css: '22px' },
]

/** Vidro em três estados pelo mesmo motivo: há pacotes que nascem chapados. */
export const GLASS: Option[] = [
  FROM_THEME,
  { id: 'on', label: 'appearance.glassOn', css: '14px' },
  { id: 'off', label: 'appearance.glassOff', css: '0px' },
]

const find = (list: Option[], id: string, fallback: string): Option =>
  list.find((o) => o.id === id) ?? list.find((o) => o.id === fallback)!

/** Completa com o padrão o que faltar ou não for reconhecido. */
export function normalize(input?: Partial<Appearance> | null): Appearance {
  const a = { ...DEFAULT_APPEARANCE, ...(input ?? {}) }
  return {
    theme: THEMES.some((t) => t.id === a.theme) ? a.theme : DEFAULT_APPEARANCE.theme,
    chatWidth: find(CHAT_WIDTHS, a.chatWidth, 'full').id,
    fontUi: find(UI_FONTS, a.fontUi, 'theme').id,
    fontCode: find(CODE_FONTS, a.fontCode, 'theme').id,
    density: find(DENSITIES, a.density, 'theme').id,
    accent: find(ACCENTS, a.accent, 'theme').id,
    radius: find(RADII, a.radius, 'theme').id,
    // Compatibilidade: antes o vidro era booleano. `false` era um "desligado"
    // explícito e precisa continuar valendo; `true` vira "o que o pacote quiser".
    glass: typeof a.glass === 'boolean' ? (a.glass ? 'theme' : 'off') : find(GLASS, a.glass, 'theme').id,
    reducedMotion: typeof a.reducedMotion === 'boolean' ? a.reducedMotion : false,
  }
}

/**
 * Aplica tudo num lugar só, no `<html>`. Nenhum componente precisa saber de tema:
 * é isso que faz um pacote novo não exigir tocar em componente nenhum.
 */
export function applyAppearance(input?: Partial<Appearance> | null, root: HTMLElement = document.documentElement): Appearance {
  const a = normalize(input)
  const style = root.style

  root.dataset.theme = a.theme
  // A largura vira atributo além da variável: o acabamento de "folha" só faz
  // sentido quando a coluna é limitada, e CSS não sabe perguntar "isto é none?".
  root.dataset.chatWidth = a.chatWidth
  root.dataset.motion = a.reducedMotion ? 'reduced' : 'full'
  style.setProperty('--chat-max', find(CHAT_WIDTHS, a.chatWidth, 'full').css!)

  /**
   * Escreve só quando o usuário DISCORDOU do pacote — e limpa quando ele volta a
   * concordar. Sem a limpeza, a escolha antiga ficaria grudada no estilo inline e
   * o tema nunca mais conseguiria mandar naquele token.
   */
  const override = (token: string, opt: Option) => {
    if (opt.css) style.setProperty(token, opt.css)
    else style.removeProperty(token)
  }
  override('--font-ui', find(UI_FONTS, a.fontUi, 'theme'))
  override('--font-code', find(CODE_FONTS, a.fontCode, 'theme'))
  override('--density', find(DENSITIES, a.density, 'theme'))
  override('--radius', find(RADII, a.radius, 'theme'))
  override('--glass-blur', find(GLASS, a.glass, 'theme'))

  const accent = find(ACCENTS, a.accent, 'theme')
  override('--accent', accent)
  if (accent.css) style.setProperty('--accent-2', accent.css2 ?? accent.css)
  else style.removeProperty('--accent-2')
  return a
}

const CACHE_KEY = 'claudinei:appearance'

/**
 * Cache de PINTURA, não fonte da verdade. A preferência vem do servidor, mas chega
 * depois de um fetch — sem isto o app pinta escuro e pisca para claro. O valor
 * daqui é aplicado antes do React montar e some assim que o servidor responde.
 */
export function cacheAppearance(a: Appearance): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(a)) } catch { /* só não adianta a pintura */ }
}

export function readCachedAppearance(): Appearance | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}
