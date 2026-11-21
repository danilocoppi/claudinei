import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { embedLocalResources } from '../src/pages/embed.js'

/**
 * A página publicada vai para um arquivo único e é servida de outra origem: o
 * que ela puxa por caminho relativo não existe lá. Então imagem, CSS, JS e
 * fonte locais entram no próprio documento — mas só o que está, de verdade,
 * dentro do projeto. O resto fica como está e vira aviso.
 */

let root: string
let proj: string
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const WOFF2 = Buffer.from('wOF2fake')
const b64 = (b: Buffer) => b.toString('base64')
const pngUrl = `data:image/png;base64,${b64(PNG)}`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pages-embed-'))
  proj = join(root, 'proj')
  for (const d of ['img', 'css', 'js', 'fonts', 'sub']) mkdirSync(join(proj, d), { recursive: true })
  mkdirSync(join(root, 'fora'))
  writeFileSync(join(proj, 'img/a.png'), PNG)
  writeFileSync(join(proj, 'img/com espaco.png'), PNG)
  writeFileSync(join(proj, 'img/coisa.xyz'), 'x')
  writeFileSync(join(proj, 'css/s.css'), 'body{background:url(../img/a.png)}\n.f{src:url("../fonts/f.woff2")}')
  writeFileSync(join(proj, 'js/app.js'), 'console.log(1)')
  writeFileSync(join(proj, 'js/fecha.js'), 'const s = "</script><b>fora</b>"; const t = \'</SCRIPT >\'')
  writeFileSync(join(proj, 'fonts/f.woff2'), WOFF2)
  writeFileSync(join(proj, 'sub/a.png'), Buffer.from('outro png'))
  writeFileSync(join(root, 'fora/b.png'), PNG)
  symlinkSync(join(root, 'fora/b.png'), join(proj, 'img/link.png'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const embed = (html: string, baseDir = proj) => embedLocalResources(html, { baseDir, projectRoot: proj })

describe('embedLocalResources', () => {
  it('img local vira data:image/png;base64 e entra em embedded com os bytes', () => {
    const r = embed('<p><img alt="x" src="img/a.png" width=3></p>')
    expect(r.html).toBe(`<p><img alt="x" src="${pngUrl}" width=3></p>`)
    expect(r.embedded).toEqual([{ ref: 'img/a.png', bytes: Buffer.byteLength(pngUrl) }])
    expect(r.missing).toEqual([])
  })

  it('img com aspas simples, sem aspas e atributo parecido (data-src) não confunde', () => {
    const r = embed(`<img src='img/a.png'><img src=img/a.png><img data-src="nada.png">`)
    expect(r.html).toBe(`<img src='${pngUrl}'><img src="${pngUrl}"><img data-src="nada.png">`)
    expect(r.missing).toEqual([])
  })

  it('link stylesheet vira <style> e o url() de dentro resolve a partir da pasta do CSS', () => {
    const r = embed('<head><link href="css/s.css" rel="stylesheet"></head>')
    const font = `data:font/woff2;base64,${b64(WOFF2)}`
    const css = `body{background:url(${pngUrl})}\n.f{src:url("${font}")}`
    expect(r.html).toBe(`<head><style>${css}</style></head>`)
    expect(r.embedded.map((e) => e.ref).sort()).toEqual(['../fonts/f.woff2', '../img/a.png', 'css/s.css'])
    expect(r.embedded.find((e) => e.ref === 'css/s.css')!.bytes).toBe(Buffer.byteLength(css))
    expect(r.missing).toEqual([])
  })

  it('link que não é stylesheet fica como está', () => {
    const html = '<link rel="icon" href="img/a.png"><link rel=preload href="css/s.css">'
    expect(embed(html)).toEqual({ html, embedded: [], missing: [] })
  })

  it('script src vira script inline e mantém type="module"', () => {
    const r = embed('<script type="module" src="js/app.js"></script>')
    expect(r.html).toBe('<script type="module">console.log(1)</script>')
    expect(r.embedded).toEqual([{ ref: 'js/app.js', bytes: Buffer.byteLength('console.log(1)') }])
  })

  it('url() em <style> e em style= com e sem aspas', () => {
    const r = embed(
      `<style>.a{background:url(img/a.png)} .b{background:url('img/a.png')} .c{background:url( "img/a.png" )}</style>` +
      `<div style="background-image:url('img/a.png')"></div><div style='background:url(img/a.png)'></div>` +
      `<div style=background:url(img/a.png)></div>`,
    )
    expect(r.html).toBe(
      `<style>.a{background:url(${pngUrl})} .b{background:url('${pngUrl}')} .c{background:url("${pngUrl}")}</style>` +
      `<div style="background-image:url('${pngUrl}')"></div><div style='background:url(${pngUrl})'></div>` +
      `<div style="background:url(${pngUrl})"></div>`,
    )
    expect(r.missing).toEqual([])
  })

  it('fonte woff2 vira data:font/woff2', () => {
    const r = embed(`<style>@font-face{font-family:F;src:url(fonts/f.woff2) format("woff2")}</style>`)
    expect(r.html).toContain(`url(data:font/woff2;base64,${b64(WOFF2)}) format("woff2")`)
  })

  it('http:, https:, //cdn, data: e #âncora ficam como estão e sem aviso', () => {
    const html =
      '<img src="http://x.com/a.png"><img src="https://x.com/a.png"><script src="//cdn.x/a.js"></script>' +
      '<link rel="stylesheet" href="https://cdn.x/s.css"><img src="data:image/png;base64,AAAA">' +
      '<a href="#topo">x</a><style>.a{filter:url(#f);background:url(blob:abc)}</style><img src="mailto:a@b">'
    expect(embed(html)).toEqual({ html, embedded: [], missing: [] })
  })

  it('../fora/b.png e symlink para fora: ficam como estão e entram em missing', () => {
    const html = '<img src="../fora/b.png"><img src="img/link.png"><style>.a{background:url(../fora/b.png)}</style>'
    const r = embed(html)
    expect(r.html).toBe(html)
    expect(r.missing).toEqual(['../fora/b.png', 'img/link.png'])
    expect(r.embedded).toEqual([])
  })

  it('arquivo ausente, diretório e extensão sem MIME entram em missing', () => {
    const html = '<img src="img/nao.png"><img src="img/coisa.xyz"><img src="img"><script src="js/nao.js"></script>' +
      '<link rel="stylesheet" href="css/nao.css">'
    const r = embed(html)
    expect(r.html).toBe(html)
    expect(r.missing).toEqual(['img/nao.png', 'img/coisa.xyz', 'img', 'js/nao.js', 'css/nao.css'])
  })

  it('url() de um CSS embutido que aponta para arquivo ausente entra em missing com o texto do CSS', () => {
    writeFileSync(join(proj, 'css/quebrado.css'), '.x{background:url(../img/sumiu.png)}')
    const r = embed('<link rel="stylesheet" href="css/quebrado.css">')
    expect(r.html).toBe('<style>.x{background:url(../img/sumiu.png)}</style>')
    expect(r.missing).toEqual(['../img/sumiu.png'])
  })

  it('a.png?v=2#x e "img/com%20espaco.png" resolvem o arquivo', () => {
    const r = embed('<img src="img/a.png?v=2#x"><img src="img/com%20espaco.png"><img src="img/com espaco.png">')
    expect(r.html).toBe(`<img src="${pngUrl}"><img src="${pngUrl}"><img src="${pngUrl}">`)
    expect(r.missing).toEqual([])
  })

  it('%-escape inválido usa o texto cru', () => {
    writeFileSync(join(proj, 'img/100%.png'), PNG)
    const r = embed('<img src="img/100%.png">')
    expect(r.html).toBe(`<img src="${pngUrl}">`)
  })

  it('JS com "</script>" no meio não fecha a tag', () => {
    const r = embed('<script src="js/fecha.js"></script><script src="js/app.js" defer></script>')
    expect(r.html.match(/<\/script/gi)).toHaveLength(2)
    expect(r.html).toContain('"<\\/script><b>fora</b>"')
    expect(r.html).toContain("'<\\/SCRIPT >'")
    expect(r.html).toContain('<script defer>console.log(1)</script>')
  })

  it('script inline com <img src> no texto não é mexido', () => {
    const html = '<script>const s = \'<img src="img/a.png">\'</script>'
    expect(embed(html)).toEqual({ html, embedded: [], missing: [] })
  })

  it('a mesma referência repetida entra uma vez em embedded e em missing', () => {
    const r = embed('<img src="img/a.png"><img src="img/a.png"><img src="x.png"><img src="x.png">')
    expect(r.html).toBe(`<img src="${pngUrl}"><img src="${pngUrl}"><img src="x.png"><img src="x.png">`)
    expect(r.embedded).toHaveLength(1)
    expect(r.missing).toEqual(['x.png'])
  })

  it('com html, a base é a raiz do projeto; com path, a pasta do .html', () => {
    const html = '<img src="a.png"><img src="../img/a.png">'
    const daRaiz = embed(html, proj)
    expect(daRaiz.missing).toEqual(['a.png', '../img/a.png'])
    const daSub = embed(html, join(proj, 'sub'))
    expect(daSub.html).toBe(`<img src="data:image/png;base64,${b64(Buffer.from('outro png'))}"><img src="${pngUrl}">`)
    expect(daSub.missing).toEqual([])
  })
})

describe('embedLocalResources — atributos', () => {
  it('&amp; no atributo é decodificado para resolver, e o aviso guarda o texto escrito', () => {
    writeFileSync(join(proj, 'img/a&b.png'), PNG)
    const r = embed('<img src="img/a&amp;b.png"><img src="img/x&amp;y.png">')
    expect(r.html).toBe(`<img src="${pngUrl}"><img src="img/x&amp;y.png">`)
    expect(r.missing).toEqual(['img/x&amp;y.png'])
  })

  it('link stylesheet com media mantém o media; alternate stylesheet fica como está', () => {
    const r = embed('<link rel="stylesheet" media="print" href="css/s.css"><link rel="alternate stylesheet" href="css/s.css">')
    expect(r.html.startsWith('<style media="print">body{')).toBe(true)
    expect(r.html.endsWith('<link rel="alternate stylesheet" href="css/s.css">')).toBe(true)
  })

  it('valor com ">" entre aspas não corta a tag', () => {
    const r = embed('<img title="a > b" src="img/a.png">')
    expect(r.html).toBe(`<img title="a > b" src="${pngUrl}">`)
  })
})

describe('embedLocalResources — tipo do arquivo', () => {
  it('<script src> e <link stylesheet> só embutem JS e CSS: .env e .txt ficam como estão e entram em missing', () => {
    writeFileSync(join(proj, '.env'), 'TOKEN=s3cr3t')
    writeFileSync(join(proj, 'notas.txt'), 'segredo')
    const html = '<script src=".env"></script><link rel=stylesheet href=".env"><img src=".env">' +
      '<script src="notas.txt"></script><link rel="stylesheet" href="notas.txt">' +
      '<script src="css/s.css"></script><link rel="stylesheet" href="js/app.js">'
    const r = embed(html)
    expect(r.html).toBe(html)
    expect(r.html).not.toContain('s3cr3t')
    expect(r.embedded).toEqual([])
    expect(r.missing).toEqual(['.env', 'notas.txt', 'css/s.css', 'js/app.js'])
  })

  it('.mjs entra como script', () => {
    writeFileSync(join(proj, 'js/m.mjs'), 'export const a = 1')
    expect(embed('<script type="module" src="js/m.mjs"></script>').html).toBe('<script type="module">export const a = 1</script>')
  })

  it('BOM no começo do CSS e do JS não entra no documento', () => {
    writeFileSync(join(proj, 'css/bom.css'), '\uFEFF.a{color:red}')
    writeFileSync(join(proj, 'js/bom.js'), '\uFEFFconsole.log(2)')
    const r = embed('<link rel="stylesheet" href="css/bom.css"><script src="js/bom.js"></script>')
    expect(r.html).toBe('<style>.a{color:red}</style><script>console.log(2)</script>')
    expect(r.embedded).toEqual([
      { ref: 'css/bom.css', bytes: Buffer.byteLength('.a{color:red}') },
      { ref: 'js/bom.js', bytes: Buffer.byteLength('console.log(2)') },
    ])
  })
})

describe('embedLocalResources — teto por arquivo', () => {
  const LIMITE = 524_288

  it('arquivo acima do teto da página não é lido: fica como está e entra em missing', () => {
    writeFileSync(join(proj, 'img/grande.png'), Buffer.alloc(LIMITE + 1, 1))
    writeFileSync(join(proj, 'css/grande.css'), 'a'.repeat(LIMITE + 1))
    writeFileSync(join(proj, 'js/grande.js'), 'a'.repeat(LIMITE + 1))
    const html = '<img src="img/grande.png"><link rel="stylesheet" href="css/grande.css"><script src="js/grande.js"></script>' +
      '<style>.a{background:url(img/grande.png)}</style>'
    const r = embed(html)
    // Comparação por tamanho: o diff de um data: URL de 700 KB não cabe no relatório.
    expect(r.html.length).toBe(html.length)
    expect(r.embedded).toEqual([])
    expect(r.missing).toEqual(['img/grande.png', 'css/grande.css', 'js/grande.js'])
  })

  it('arquivo com exatamente o teto ainda entra', () => {
    writeFileSync(join(proj, 'img/no-limite.png'), Buffer.alloc(LIMITE, 1))
    const r = embed('<img src="img/no-limite.png">')
    expect(r.missing).toEqual([])
    expect(r.embedded).toHaveLength(1)
  })
})

describe('embedLocalResources — tags', () => {
  it('<style-box> e <script-x> são elementos comuns, não blocos de CSS e JS', () => {
    const r = embed('<style-box><img src="img/a.png"></style-box><style>.a{}</style>' +
      '<script-x><img src="img/a.png"></script-x><script>1</script>')
    expect(r.html).toBe(`<style-box><img src="${pngUrl}"></style-box><style>.a{}</style>` +
      `<script-x><img src="${pngUrl}"></script-x><script>1</script>`)
  })

  it('"<" fora de aspas encerra uma tag que não fechou', () => {
    const r = embed('<a <img src="img/a.png">')
    expect(r.html).toBe(`<a <img src="${pngUrl}">`)
  })

  it('comentário é pulado inteiro e ">" entre aspas não corta a tag', () => {
    const r = embed('<p title="x>y"><img src="img/a.png"><!-- <img src="img/a.png"> --><img src="img/a.png">')
    expect(r.html).toBe(`<p title="x>y"><img src="${pngUrl}"><!-- <img src="img/a.png"> --><img src="${pngUrl}">`)
  })
})

/**
 * Entrada hostil não pode travar o laço de eventos: tudo que não fecha
 * (comentário, bloco, tag, aspas, url()) é visto uma vez só, não a cada `<`.
 * Antes, 512 KB de `<a b` levavam ~40 s.
 */
describe('embedLocalResources — tempo em entrada hostil', () => {
  const TAM = 512 * 1024
  const rep = (s: string) => s.repeat(Math.ceil(TAM / s.length)).slice(0, TAM)
  const casos: Array<[string, string]> = [
    ['<style> sem fechamento', rep('<style>')],
    ['<script> sem fechamento', rep('<script>')],
    ['<!-- sem fechamento', rep('<!--')],
    ['<a " repetido', rep('<a "')],
    ['<a b sem >', rep('<a b')],
    ['<a seguido de espaços', '<a' + ' '.repeat(TAM - 3) + '>'],
    ['url( seguido de espaços em <style>', '<style>a{b:url(' + ' '.repeat(TAM - 30) + '</style>'],
    ['url( seguido de espaços em style=', '<a style="url(' + ' '.repeat(TAM - 30) + '">'],
    ["<a ' e <a \" alternados", rep(`<a '<a "`)],
    ['url(" repetido em <style>', '<style>' + rep('a{b:url("') + '</style>'],
  ]
  it.each(casos)('%s: 512 KB em menos de 1 s', (_nome, html) => {
    const t = performance.now()
    const r = embed(html)
    const ms = performance.now() - t
    console.log(`[tempo] ${_nome}: ${ms.toFixed(1)} ms`)
    expect(r.html).toBe(html)
    expect(ms).toBeLessThan(1000)
  })
})
