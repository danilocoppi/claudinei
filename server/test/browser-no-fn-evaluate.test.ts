import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// O pkg compila o código do Claudinei em bytecode: função passada ao `evaluate`
// perde o texto ("Passed function is not well-serializable"). Nestas pastas, só string.
//
// A chamada: o nome do método, o genérico de TS opcional (até dois níveis de
// aninhamento: `evaluate<Map<string, Array<number>>>(…)`) e o parêntese.
const GENERIC = String.raw`<(?:[^<>()]|<(?:[^<>()]|<[^<>()]*>)*>)*>`
const CALL = String.raw`\.(?:evaluate|evaluateAll|evaluateHandle|\$eval|\$\$eval|waitForFunction|addInitScript)(?:${GENERIC})?\(\s*`
// O começo de uma função: `async`, `function`, parêntese (arrow com parâmetros) ou `x =>`.
const FN = String.raw`(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)`
// Um literal de string inteiro (aspas simples, duplas ou crase), para o primeiro argumento.
const STR = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60)`
/** Função no primeiro argumento: `evaluate(() => …)`, `evaluateAll(els => …)`. */
const FN_FIRST = new RegExp(CALL + FN)
/** Função no segundo argumento, depois de um seletor em string: `$eval('sel', el => …)`. */
const FN_SECOND = new RegExp(CALL + STR + String.raw`\s*,\s*` + FN)
// Um seletor em constante ou membro: `SEL`, `this.sel`, `SELECTORS.title`, `sels[0]`, `a?.b`.
const REF_ARG = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])*`
/** Só no `$eval`/`$$eval` (o 1º argumento é o seletor): `$eval(SEL, (el) => …)`. */
const FN_SECOND_REF = new RegExp(String.raw`\.(?:\$eval|\$\$eval)(?:${GENERIC})?\(\s*` + REF_ARG + String.raw`\s*,\s*` + FN)
const hasFnArg = (code: string): boolean => FN_FIRST.test(code) || FN_SECOND.test(code) || FN_SECOND_REF.test(code)

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
  it('a varredura pega função e deixa string passar (controle)', () => {
    const fn = [
      'page.evaluate(() => 1)',
      'page.evaluate(async () => 1)',
      'page.evaluate(function () { return 1 })',
      'page.$eval(el => el.textContent)',
      'ctx.addInitScript(\n  () => {})',
      'page.evaluate<number>(() => 1)',
      'page.waitForFunction<boolean, string>(async (s) => !!s)',
      // Segundo argumento, depois do seletor.
      "page.$eval('h1', el => el.textContent)",
      'page.$eval("h1", (el) => el.textContent)',
      'page.$$eval(`li`, function (els) { return els.length })',
      "page.$$eval('li', async (els) => els.length)",
      "page.$eval('a[href=\\'x\\']', el => el.href)",
      // evaluateAll e genérico aninhado.
      'loc.evaluateAll(() => 1)',
      "loc.evaluateAll(els => els.map((e) => e.value))",
      'page.evaluate<Array<string>>(() => [])',
      'page.evaluate<Map<string, Array<number>>>(async () => new Map())',
      "loc.evaluateAll<Array<string>>(\n  (els) => [])",
      // Seletor em constante ou membro, função no segundo.
      'page.$eval(SEL, (el) => el.textContent)',
      'page.$$eval(this.sel, els => els.length)',
      'page.$eval(SELECTORS.title, function (el) { return el.id })',
      'page.$$eval(sels[0], async (els) => els.length)',
      'page.$eval<string>(cfg?.sel, (el) => el.id)',
    ]
    for (const c of fn) expect(hasFnArg(c), c).toBe(true)
    const str = [
      "page.evaluate<string>('document.title')",
      "page.evaluate('1')",
      'page.evaluate(`document.title`)',
      "loc.evaluateAll('els => els.map(e => e.value)')",
      'page.evaluate<Array<string>>("Array.from(document.querySelectorAll(\'input[type=password]\'), e => e.value)")',
      "page.$eval('h1', 'el => el.textContent')",
      "page.$$eval('li', `els => els.length`)",
      // Seletor em constante ou membro com a função em string.
      "page.$eval(SEL, 'el => el.textContent')",
      'page.$$eval(this.sel, `els => els.length`)',
      // Vírgula e parêntese dentro da string do primeiro argumento não enganam.
      "frame.evaluate(\"Array.from(document.querySelectorAll('a, b'), (e) => e.value)\")",
      "page.evaluate('f(1), (2)')",
      // Outros métodos com função são permitidos (rodam no Node, não na página).
      "page.waitForURL((u) => u.pathname === '/x')",
      "page.on('console', (m) => push(m))",
    ]
    for (const c of str) expect(hasFnArg(c), c).toBe(false)
  })

  it('server/src/browser e server/src/local-servers não passam função', () => {
    const files = [...walk(join(src, 'browser')), ...walk(join(src, 'local-servers'))]
    expect(files.length).toBeGreaterThan(0)
    const bad = files.filter((f) => hasFnArg(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })
})
