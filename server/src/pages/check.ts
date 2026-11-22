import type { BrowserHost } from '../browser/host.js'
import { CHECK_CONSOLE_MAX, CHECK_MAX_HEIGHT, cropPngHeight, orderConsole, type createCheckShots } from './check-parts.js'

/**
 * O `check_page`: renderiza o documento numa página isolada do navegador do
 * projeto 16 e devolve imagem, altura e console. Nada é publicado; a fila e o
 * prazo da página são do host (sem semáforo próprio aqui).
 */

export const CHECK_WIDTH_DEFAULT = 1024
export const CHECK_WIDTH_MIN = 360
export const CHECK_WIDTH_MAX = 1920
/** Depois do `load`, o tempo para scripts e fontes da CDN assentarem. */
export const CHECK_SETTLE_MS = 1500

const VIEWPORT_HEIGHT = 800
/** Altura mínima da imagem da página baixa. */
const CHECK_MIN_HEIGHT = 120
const PAGE_TIMEOUT_MS = 20_000
const QUEUE_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 10_000

export interface CheckResult {
  png: string /* base64 */; height: number; cropped: boolean; loaded: boolean; console: string[]
  /** Caminho da cópia do PNG; vazio quando ela não pôde ser gravada (motivo em fileError). */
  file: string
  fileError?: string
}

export async function runCheck(
  host: Pick<BrowserHost, 'withIsolatedPage'>,
  doc: string,
  width: number,
  shots: ReturnType<typeof createCheckShots>,
  opts: { settleMs?: number } = {},
): Promise<CheckResult> {
  const settleMs = opts.settleMs ?? CHECK_SETTLE_MS
  const shot = await host.withIsolatedPage(
    { viewport: { width, height: VIEWPORT_HEIGHT }, offline: false, timeoutMs: PAGE_TIMEOUT_MS, queueTimeoutMs: QUEUE_TIMEOUT_MS },
    async (page) => {
      const { loaded } = await page.setContent(doc, { loadTimeoutMs: LOAD_TIMEOUT_MS })
      // Com o `load` estourado, captura já: o prazo da página corre.
      if (loaded && settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
      const height = await page.contentHeight()
      const png = await page.screenshot({ fullPage: true })
      return { loaded, height, png, console: orderConsole(page.consoleMessages(), CHECK_CONSOLE_MAX) }
    },
  )
  // O corte e a cópia depois de fechar a página: a vaga do host fica livre antes.
  // O fullPage nunca fica abaixo do viewport: a imagem vai até a altura do
  // conteúdo (no mínimo CHECK_MIN_HEIGHT, para o body vazio não virar uma
  // tira), e no máximo CHECK_MAX_HEIGHT. `cropped` diz só se o conteúdo passou do teto.
  const cut = cropPngHeight(shot.png, Math.min(CHECK_MAX_HEIGHT, Math.max(CHECK_MIN_HEIGHT, Math.ceil(shot.height))))
  // Sem a cópia, a imagem ainda serve: a conferência não falha por isso.
  let file = ''
  let fileError: string | undefined
  try { file = shots.save(cut.png) } catch (err) { fileError = (err as Error).message }
  return {
    png: cut.png.toString('base64'), height: shot.height, cropped: shot.height > CHECK_MAX_HEIGHT,
    loaded: shot.loaded, console: shot.console, file, ...(fileError ? { fileError } : {}),
  }
}

/**
 * A falha do host como resposta HTTP. Reconhece pelo `code` (e `message ===
 * 'timeout'`), não pela classe: o erro pode vir de outra cópia do módulo.
 * Desconhecida, devolve undefined.
 */
export function checkFailure(err: unknown): { status: number; code: string; error: string } | undefined {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; hint?: unknown }
  const message = typeof e.message === 'string' ? e.message : ''
  if (e.code === 'browser_busy') return { status: 503, code: 'browser_busy', error: 'busy, try again' }
  if (e.code === 'browser_not_installed' || e.code === 'launch_failed') {
    const hint = typeof e.hint === 'string' ? e.hint : ''
    // Não instalado: a mensagem já traz o comando de instalação, que é o hint.
    const error = e.code === 'browser_not_installed' || !hint ? message : `${message}. ${hint}`
    return { status: 503, code: e.code, error }
  }
  if (message === 'timeout') {
    return { status: 504, code: 'check_timeout', error: `the page stayed open longer than ${PAGE_TIMEOUT_MS / 1000} s` }
  }
  return undefined
}
