import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Uses fileURLToPath(import.meta.url) directly (not `new URL('.', import.meta.url)`)
// because jsdom's test environment overrides the global URL constructor, which
// resolves relative URLs against `window.location` instead of the given base and
// throws "The URL must be of scheme file".
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

describe('fallback de emoji no CSS', () => {
  it('body inclui uma fonte de emoji no font-family', () => {
    expect(css).toMatch(/Noto Color Emoji/)
    expect(css).toMatch(/--emoji/)
  })
})
