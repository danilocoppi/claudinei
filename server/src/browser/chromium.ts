// Onde está o Chromium que o host abre. Nada é baixado sozinho: sem o executável,
// o navegador fica "não instalado" e o operador recebe o comando de instalação.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A versão fixada no server/package.json (sem `^`): o protocolo casa com a revisão abaixo. */
export const PLAYWRIGHT_CORE_VERSION = '1.65.1'
/** A revisão do chromium-headless-shell que o playwright-core 1.65.1 espera (browsers.json). Outra não serve. */
export const HEADLESS_SHELL_REVISION = '1255'
/** `--no-remove` preserva as outras revisões do cache, que os MCPs do operador usam. */
export const INSTALL_COMMAND = 'npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell'

export type ChromiumResolution =
  | { ok: true; path: string; source: 'env' | 'cache' }
  | { ok: false; expected: string; reason: 'env_missing' | 'not_installed' }

function isRegularFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/**
 * Na ordem: `CLAUDINEI_CHROMIUM` (caminho de um executável; ausente, não cai no
 * cache: quem pôs a variável quer aquele) e depois `$PLAYWRIGHT_BROWSERS_PATH` ou
 * `~/.cache/ms-playwright`, só na revisão exata.
 */
export function resolveChromium(
  env: NodeJS.ProcessEnv = process.env,
  o: { home?: string; isFile?: (p: string) => boolean } = {},
): ChromiumResolution {
  const isFile = o.isFile ?? isRegularFile
  const custom = env.CLAUDINEI_CHROMIUM
  if (custom) {
    return isFile(custom) ? { ok: true, path: custom, source: 'env' } : { ok: false, expected: custom, reason: 'env_missing' }
  }
  const base = env.PLAYWRIGHT_BROWSERS_PATH || join(o.home ?? homedir(), '.cache', 'ms-playwright')
  const path = join(base, `chromium_headless_shell-${HEADLESS_SHELL_REVISION}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
  return isFile(path) ? { ok: true, path, source: 'cache' } : { ok: false, expected: path, reason: 'not_installed' }
}
