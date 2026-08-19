/**
 * Gera `src/icons/brands.json` a partir do pacote `simple-icons`.
 *
 * O pacote guarda os metadados num JSON e cada desenho num .svg separado — 3.453
 * arquivos. Ler 3.453 arquivos em tempo de execução não é opção, e importar o
 * pacote inteiro traria um módulo por ícone. Então extraímos uma vez o que a UI
 * precisa (slug, título, path) e commitamos o resultado.
 *
 * O arquivo é DADO GERADO: para atualizar os logos, suba o `simple-icons` e rode
 * `node scripts/gen-icons.mjs` de novo.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// O pacote não exporta `package.json`, então `require.resolve` não serve de âncora;
// procuramos o node_modules que o contém (o do workspace ou o local).
const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = [join(here, '..', 'node_modules'), join(here, '..', '..', 'node_modules')]
  .map((dir) => join(dir, 'simple-icons'))
  .find((dir) => existsSync(join(dir, 'data', 'simple-icons.json')))
if (!pkgDir) throw new Error('simple-icons não encontrado — rode npm install antes')
const meta = JSON.parse(readFileSync(join(pkgDir, 'data', 'simple-icons.json'), 'utf8'))

/**
 * Arredonda as coordenadas para 2 casas. O viewBox tem 24 unidades e o ícone é
 * desenhado a ~20px: 0,01 unidade vale 0,008px na tela, o que ninguém enxerga —
 * e a diferença no arquivo é de quase um terço.
 */
const trim = (path) => path.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 100) / 100))

const out = []
for (const icon of meta) {
  try {
    const svg = readFileSync(join(pkgDir, 'icons', `${icon.slug}.svg`), 'utf8')
    const path = svg.match(/ d="([^"]+)"/)?.[1]
    if (path) out.push({ s: icon.slug, t: icon.title, p: trim(path) })
  } catch { /* ícone sem arquivo: ignora */ }
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons', 'brands.json')
writeFileSync(dest, JSON.stringify(out))
console.log(`${out.length} marcas → ${dest}`)
