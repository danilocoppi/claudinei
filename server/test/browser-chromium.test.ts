import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { HEADLESS_SHELL_REVISION, INSTALL_COMMAND, PLAYWRIGHT_CORE_VERSION, resolveChromium } from '../src/browser/chromium.js'

const shellIn = (base: string, rev: string) =>
  join(base, `chromium_headless_shell-${rev}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell')

describe('resolveChromium', () => {
  it('CLAUDINEI_CHROMIUM aponta arquivo existente → source env', () => {
    const r = resolveChromium({ CLAUDINEI_CHROMIUM: '/opt/chrome' }, { home: '/h', isFile: (p) => p === '/opt/chrome' })
    expect(r).toEqual({ ok: true, path: '/opt/chrome', source: 'env' })
  })

  it('CLAUDINEI_CHROMIUM aponta arquivo ausente → ok false, env_missing, sem cair no cache', () => {
    const cache = shellIn('/h/.cache/ms-playwright', HEADLESS_SHELL_REVISION)
    const r = resolveChromium({ CLAUDINEI_CHROMIUM: '/opt/nada' }, { home: '/h', isFile: (p) => p === cache })
    expect(r).toEqual({ ok: false, expected: '/opt/nada', reason: 'env_missing' })
  })

  it('PLAYWRIGHT_BROWSERS_PATH com a revisão 1255 → o caminho do chrome-headless-shell', () => {
    const want = '/pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell'
    const r = resolveChromium({ PLAYWRIGHT_BROWSERS_PATH: '/pw' }, { home: '/h', isFile: (p) => p === want })
    expect(r).toEqual({ ok: true, path: want, source: 'cache' })
  })

  it('sem variável, procura em ~/.cache/ms-playwright', () => {
    const want = shellIn('/h/.cache/ms-playwright', '1255')
    const r = resolveChromium({}, { home: '/h', isFile: (p) => p === want })
    expect(r).toEqual({ ok: true, path: want, source: 'cache' })
  })

  it('só outra revisão no cache (1248) → not_installed', () => {
    const other = shellIn('/h/.cache/ms-playwright', '1248')
    const r = resolveChromium({}, { home: '/h', isFile: (p) => p === other })
    expect(r).toEqual({ ok: false, expected: shellIn('/h/.cache/ms-playwright', '1255'), reason: 'not_installed' })
  })

  it('HEADLESS_SHELL_REVISION casa com node_modules/playwright-core/browsers.json', () => {
    const require = createRequire(import.meta.url)
    const pkgDir = dirname(require.resolve('playwright-core/package.json'))
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }
    const browsers = JSON.parse(readFileSync(join(pkgDir, 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; revision: string }> }
    const shell = browsers.browsers.find((b) => b.name === 'chromium-headless-shell')
    expect(shell?.revision).toBe(HEADLESS_SHELL_REVISION)
    expect(pkg.version).toBe(PLAYWRIGHT_CORE_VERSION)
    expect(INSTALL_COMMAND).toBe('npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell')
  })
})
