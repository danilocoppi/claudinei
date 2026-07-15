#!/usr/bin/env node
// Gera o binário único: build do web → esbuild do server (CJS, nativos external) →
// montar assets (native+web) → @yao-pkg/pkg. Plataforma = a máquina atual (linux-x64).
//
// Layout empírico (confirmado RODANDO — não adivinhado; ver .superpowers/sdd/task-3-report.md):
// - esbuild bundla server/src/index.ts → dist-pkg/server.cjs (CJS). Os nativos
//   (better-sqlite3, node-pty, sherpa-onnx-node/-linux-x64) e as deps transitivas
//   de better-sqlite3 (bindings, file-uri-to-path) ficam EXTERNAL — continuam
//   como `require('pkg-bare-name')` no bundle em vez de serem inlineados
//   (o esbuild não consegue — e não deve — bundlar um `.node`).
// - Dentro do binário pkg, esses `require()` de nome nu NÃO resolvem via
//   node_modules normal (o snapshot não tem uma árvore node_modules real).
//   O pkg-runtime.ts (T2) já extrai assets/native do snapshot p/ um cache real em
//   disco (~/.cache/claudinei/native-<v>) ANTES de qualquer require nativo, e o
//   index.ts (T3) seta NODE_PATH=<cache>/native antes do re-exec — cada pacote
//   nativo é filho DIRETO de assets/native/ (não node_modules/ aninhado: é assim
//   que o Node resolve NODE_PATH — cada entrada é testada como
//   <entry>/<nome-do-pacote> diretamente, não <entry>/node_modules/<nome>).
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = (p) => join(root, 'node_modules', p)
const run = (cmd, args, opts) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })

console.log('▶ 1/4 build do web (SPA)')
run('npm', ['run', 'build', '-w', 'web'])

console.log('▶ 2/4 esbuild → dist-pkg/server.cjs')
rmSync(join(root, 'dist-pkg'), { recursive: true, force: true })
mkdirSync(join(root, 'dist-pkg'), { recursive: true })
const outCjs = join(root, 'dist-pkg', 'server.cjs')
// Lista EMPÍRICA (rodou o esbuild, viu o que reclamava de não-resolver, adicionou):
// os 3 nativos + as duas deps transitivas que better-sqlite3 usa para achar o
// .node em runtime (require('bindings') → require('file-uri-to-path')).
const EXTERNAL = [
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'node-pty',
  'sherpa-onnx-node',
  'sherpa-onnx-linux-x64',
]
await build({
  entryPoints: [join(root, 'server', 'src', 'index.ts')],
  outfile: outCjs,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: EXTERNAL,
  logLevel: 'info',
})

console.log('▶ 3/4 montando assets (native + web)')
const assets = join(root, 'dist-pkg', 'assets')
const nativeDir = join(assets, 'native')
mkdirSync(nativeDir, { recursive: true })

// Pacotes nativos — não só o .node: a parte JS de resolução de cada um também
// é necessária (better-sqlite3 faz require('bindings'); node-pty acha o .node
// por caminho relativo dentro do próprio pacote; sherpa-onnx-node's addon.js
// acha o .node num sibling `sherpa-onnx-<plataforma>`). Cada um vira filho
// DIRETO de assets/native/ — layout que pkg-runtime.ts (ensureNativeCache,
// busca do sherpaDir) e o NODE_PATH (index.ts) esperam.
//
// better-sqlite3 e node-pty carregam consigo `deps/`/`src/`/`prebuilds/`
// (fontes C++, prebuilds de OUTRAS plataformas/ABIs) que só servem pra build —
// em runtime só precisam de package.json + lib/ (JS) + o .node já compilado
// desta máquina. Poda empírica: sem isso o binário saiu com 276MB (medido
// rodando `npm run package` sem poda: node-pty sozinho trazia 63MB de
// prebuilds/deps/third_party — ver task-3-report.md).
const PRUNE = {
  'better-sqlite3': ['package.json', 'lib', 'build/Release/better_sqlite3.node'],
  'node-pty': ['package.json', 'lib', 'build/Release/pty.node'],
}
// Prebuilts nativos OBRIGATÓRIOS: sem eles o binário sobe mas quebra em runtime
// só quando algo tenta usar sqlite/pty/voz — um `.node` faltando aqui não pode
// ser pulado em silêncio (era o bug: `if (existsSync(s)) cpSync(...)`, que
// produzia um dist-pkg/release "completo" e quebrado). Falha alto e claro AQUI,
// no build, em vez de num crash tardio na máquina do usuário.
const REQUIRED_NATIVE = {
  'better-sqlite3': 'build/Release/better_sqlite3.node',
  'node-pty': 'build/Release/pty.node',
  'sherpa-onnx-node': 'addon.js',
  'sherpa-onnx-linux-x64': 'sherpa-onnx.node',
}
function failMissingPrebuilt(pkg, detail) {
  console.error(
    `✘ prebuilt nativo ausente: ${pkg}${detail ? ` (${detail})` : ''}.\n` +
    '  Rode `npm install` na raiz (isso baixa/compila os prebuilts nativos) — ' +
    'veja o gotcha do node-pty no README antes de tentar de novo.',
  )
  process.exit(1)
}
for (const pkg of EXTERNAL) {
  const src = nm(pkg)
  const dest = join(nativeDir, pkg)
  const keep = PRUNE[pkg]
  if (!keep) {
    if (REQUIRED_NATIVE[pkg] && !existsSync(join(src, REQUIRED_NATIVE[pkg]))) {
      failMissingPrebuilt(pkg, `esperava node_modules/${pkg}/${REQUIRED_NATIVE[pkg]}`)
    }
    cpSync(src, dest, { recursive: true }) // pacote pequeno (bindings, file-uri-to-path, sherpa-*): copia tudo
    continue
  }
  mkdirSync(dest, { recursive: true })
  for (const item of keep) {
    const s = join(src, item)
    if (existsSync(s)) cpSync(s, join(dest, item), { recursive: true })
  }
  const required = REQUIRED_NATIVE[pkg]
  if (required && !existsSync(join(dest, required))) {
    failMissingPrebuilt(pkg, `esperava node_modules/${pkg}/${required} compilado para esta plataforma`)
  }
}

// NOTA: server/src/speech/worker.mjs (o processo filho de transcrição em dev)
// NÃO precisa virar asset aqui. Empírico: um binário pkg, spawnado com o
// caminho de um arquivo REAL fora do snapshot, ignora esse argumento e
// reexecuta o próprio entry bundlado em vez de rodar o arquivo (ver
// server/src/speech/run-worker.ts). Por isso o worker empacotado roda como
// modo `--speech-worker` do PRÓPRIO server.cjs (mesma solução do --hermes) —
// já embutido no bundle esbuild, sem precisar de asset separado.

// libstdc++ portátil: reusa o que o setup-speech baixa (o spike do design já
// baixou em ~/.claudinei/speech/stdcxx). Se não existir, avisa e segue sem —
// a voz vai falhar em glibc antiga, mas o resto do binário funciona.
const stdcxxSrc = join(process.env.HOME ?? '', '.claudinei', 'speech', 'stdcxx')
if (existsSync(stdcxxSrc)) {
  cpSync(stdcxxSrc, join(nativeDir, 'stdcxx'), { recursive: true })
} else {
  console.warn(
    '⚠ ~/.claudinei/speech/stdcxx não encontrado — rode `npm run setup:speech -w server` antes.\n' +
    '  O binário sai sem libstdc++ portátil (a transcrição de voz pode falhar em glibc antiga).',
  )
}

cpSync(join(root, 'web', 'dist'), join(assets, 'web'), { recursive: true })

// Chave de invalidação do cache de extração (pkg-runtime.ts ensureNativeCache):
// sem ela, um rebuild sem bump de versão reusaria a extração antiga em disco
// (extractTree pula existentes) e a UI nunca atualizaria — index.html velho
// apontando pro bundle antigo (bug real, visto em produção local).
const sha = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
  catch { return 'nogit' }
})()
writeFileSync(join(assets, 'build-id'), `${sha}-${Date.now()}`)

console.log('▶ 4/4 @yao-pkg/pkg')
mkdirSync(join(root, 'release'), { recursive: true })
// O jeito robusto de passar pkg.assets/targets: um --config próprio (em vez de
// depender do campo "pkg" no package.json raiz). Caminhos relativos ao dir do
// config (dist-pkg/), que é onde server.cjs e assets/ vivem.
const pkgConfigPath = join(root, 'dist-pkg', 'pkg.json')
writeFileSync(pkgConfigPath, JSON.stringify({
  pkg: {
    assets: ['assets/**/*'],
    // EMPÍRICO (T3): dist-pkg/ mora dentro do repo, então dist-pkg/server.cjs
    // tem a node_modules/ da raiz do repo como ancestral — o walker do pkg
    // SEGUE os require('better-sqlite3')/require('node-pty')/etc "external"
    // (deixados como require() nu pelo esbuild) até lá e embute uma cópia
    // NÃO-PODADA (sem o .node prebuilt certo) no snapshot, que teria
    // PRIORIDADE sobre o NODE_PATH em runtime (a resolução normal do Node
    // acha o node_modules do snapshot ANTES de consultar NODE_PATH) — quebrando
    // com "Cannot find module .../prebuilds/linux-x64/pty.node" (visto rodando
    // o binário — ver task-3-report.md). `ignore` faz o walker pular essas
    // pastas: os require() ficam de fato dinâmicos/não resolvidos no build
    // (warning esperado do pkg), e em runtime só existe UMA fonte: o
    // NODE_PATH apontando pro cache extraído (pkg-runtime.ts).
    ignore: EXTERNAL.flatMap((pkg) => [`../node_modules/${pkg}/**`, `node_modules/${pkg}/**`, `**/node_modules/${pkg}/**`]),
    targets: ['node24-linux-x64'],
  },
}, null, 2))
const output = join(root, 'release', 'claudinei-linux-x64')
run('npx', ['pkg', outCjs, '--config', pkgConfigPath, '--output', output])

const { size } = statSync(output)
console.log(`✔ binário em ${output} (${(size / 1024 / 1024).toFixed(1)} MB)`)
