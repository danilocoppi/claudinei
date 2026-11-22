import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// O pkg compila o código do Claudinei em bytecode: função passada ao `evaluate`
// perde o texto ("Passed function is not well-serializable"). Nestas pastas, só string.
const FN_ARG = /\.(evaluate|evaluateHandle|\$eval|\$\$eval|waitForFunction|addInitScript)\(\s*(async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/

const src = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  return entries.flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|mts|js|mjs)$/.test(n) ? [p] : []
  })
}

describe('evaluate só com string', () => {
  it('a regex pega função e deixa string passar (controle)', () => {
    expect(FN_ARG.test('page.evaluate(() => 1)')).toBe(true)
    expect(FN_ARG.test('page.evaluate(async () => 1)')).toBe(true)
    expect(FN_ARG.test('page.evaluate(function () { return 1 })')).toBe(true)
    expect(FN_ARG.test('page.$eval(el => el.textContent)')).toBe(true)
    expect(FN_ARG.test('ctx.addInitScript(\n  () => {})')).toBe(true)
    expect(FN_ARG.test("page.evaluate('1')")).toBe(false)
    expect(FN_ARG.test('page.evaluate(`document.title`)')).toBe(false)
  })

  it('server/src/browser e server/src/local-servers não passam função', () => {
    const files = [...walk(join(src, 'browser')), ...walk(join(src, 'local-servers'))]
    expect(files.length).toBeGreaterThan(0)
    const bad = files.filter((f) => FN_ARG.test(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })
})
