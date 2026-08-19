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
  glass: boolean
  reducedMotion: boolean
}

/** O padrão é a aparência de hoje: quem nunca abriu o painel não vê diferença. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark-fun',
  chatWidth: 'full',
  fontUi: 'system',
  fontCode: 'mono',
  density: 'comfortable',
  accent: 'theme',
  radius: 'default',
  glass: true,
  reducedMotion: false,
}

export interface Option { id: string; label: string; css?: string; css2?: string }

export const THEMES: Option[] = [
  { id: 'dark-fun', label: 'Dark Fun' },
  { id: 'light-fun', label: 'Light Fun' },
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
  { id: 'mono', label: 'Padrão', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', css: '"JetBrains Mono", ui-monospace, monospace' },
  { id: 'fira', label: 'Fira Code', css: '"Fira Code", ui-monospace, monospace' },
  { id: 'ibm', label: 'IBM Plex Mono', css: '"IBM Plex Mono", ui-monospace, monospace' },
  { id: 'cascadia', label: 'Cascadia Code', css: '"Cascadia Code", "Cascadia Mono", ui-monospace, monospace' },
  { id: 'courier', label: 'Courier', css: '"Courier New", Courier, monospace' },
]

export const DENSITIES: Option[] = [
  { id: 'comfortable', label: 'appearance.densityComfortable', css: '1' },
  { id: 'compact', label: 'appearance.densityCompact', css: '.8' },
]

/**
 * `theme` significa "a do pacote": cada tema afina o próprio roxo para o contraste
 * do seu fundo, e sobrescrevê-lo por padrão jogaria essa afinação fora.
 */
export const ACCENTS: Option[] = [
  { id: 'theme', label: 'appearance.accentTheme' },
  { id: 'blue', label: 'appearance.accentBlue', css: '#3b82f6', css2: '#60a5fa' },
  { id: 'teal', label: 'appearance.accentTeal', css: '#0e9aa7', css2: '#22c3d0' },
  { id: 'green', label: 'appearance.accentGreen', css: '#16a34a', css2: '#34d07a' },
  { id: 'amber', label: 'appearance.accentAmber', css: '#d97706', css2: '#f0a531' },
  { id: 'pink', label: 'appearance.accentPink', css: '#db2777', css2: '#f0559b' },
]

export const RADII: Option[] = [
  { id: 'square', label: 'appearance.radiusSquare', css: '4px' },
  { id: 'default', label: 'appearance.radiusDefault', css: '16px' },
  { id: 'round', label: 'appearance.radiusRound', css: '22px' },
]

const find = (list: Option[], id: string, fallback: string): Option =>
  list.find((o) => o.id === id) ?? list.find((o) => o.id === fallback)!

/** Completa com o padrão o que faltar ou não for reconhecido. */
export function normalize(input?: Partial<Appearance> | null): Appearance {
  const a = { ...DEFAULT_APPEARANCE, ...(input ?? {}) }
  return {
    theme: THEMES.some((t) => t.id === a.theme) ? a.theme : DEFAULT_APPEARANCE.theme,
    chatWidth: find(CHAT_WIDTHS, a.chatWidth, 'full').id,
    fontUi: find(UI_FONTS, a.fontUi, 'system').id,
    fontCode: find(CODE_FONTS, a.fontCode, 'mono').id,
    density: find(DENSITIES, a.density, 'comfortable').id,
    accent: find(ACCENTS, a.accent, 'theme').id,
    radius: find(RADII, a.radius, 'default').id,
    glass: typeof a.glass === 'boolean' ? a.glass : true,
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
  root.dataset.glass = a.glass ? 'on' : 'off'
  root.dataset.motion = a.reducedMotion ? 'reduced' : 'full'

  style.setProperty('--chat-max', find(CHAT_WIDTHS, a.chatWidth, 'full').css!)
  style.setProperty('--font-ui', find(UI_FONTS, a.fontUi, 'system').css!)
  style.setProperty('--font-code', find(CODE_FONTS, a.fontCode, 'mono').css!)
  style.setProperty('--density', find(DENSITIES, a.density, 'comfortable').css!)
  style.setProperty('--radius', find(RADII, a.radius, 'default').css!)

  // 'theme' não escreve nada: deixa valer o roxo que o pacote afinou para o próprio
  // fundo. Por isso a limpeza explícita — trocar de volta precisa devolver o token.
  const accent = find(ACCENTS, a.accent, 'theme')
  if (accent.css) {
    style.setProperty('--accent', accent.css)
    style.setProperty('--accent-2', accent.css2 ?? accent.css)
  } else {
    style.removeProperty('--accent')
    style.removeProperty('--accent-2')
  }
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
