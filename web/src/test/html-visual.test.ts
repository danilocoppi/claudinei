import { describe, expect, it } from 'vitest'
import { visualHtml } from '../editor/html-visual'

const source = `<!DOCTYPE html>
<!-- autoria --><html lang="pt-BR"><head><title>Exemplo</title>
<base href="https://example.com/"><meta http-equiv="refresh" content="5;url=/sair">
<link rel="stylesheet" href="./page.css"><style>h1 { color: red }</style></head>
<body class="pagina"><h1>Olá</h1><img src="../imagem.png">
<script>window.example = '<div>original</div>'</script></body></html>`
const baseUrl = '/api/files/preview/token/projeto/index.html'
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

describe('HTML visual — preservar o arquivo e isolar a edição', () => {
  it('abrir sem alterar preserva o fonte exatamente, inclusive doctype e espaços', () => {
    const model = visualHtml(source, baseUrl)
    expect(model.read(parse(model.srcDoc))).toBe(source)
  })
  it('edita o corpo sem gravar CSP/base do editor ou perder scripts, head e URLs relativas', () => {
    const model = visualHtml(source, baseUrl)
    const doc = parse(model.srcDoc)
    doc.querySelector('h1')!.innerHTML = 'Texto <b>novo</b>'
    const result = model.read(doc)
    const saved = parse(result)
    expect(saved.querySelector('h1')!.innerHTML).toBe('Texto <b>novo</b>')
    expect(saved.head.innerHTML).toBe(parse(source).head.innerHTML)
    expect(saved.querySelector('script')!.textContent).toBe(parse(source).querySelector('script')!.textContent)
    expect(saved.querySelector('img')!.getAttribute('src')).toBe('../imagem.png')
    expect(saved.body.className).toBe('pagina')
    expect(saved.doctype?.name).toBe('html')
    expect(result).toContain('<!-- autoria -->')
    expect(result).not.toContain('/api/files/preview/')
    expect(result).not.toContain('claudinei-editor-')
    expect(result).not.toContain('Content-Security-Policy')
  })
  it('remove navegação automática e restringe recursos à concessão de leitura', () => {
    const doc = parse(visualHtml(source, baseUrl).srcDoc)
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!
    expect(policy).toContain("script-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain('/api/files/preview/token/')
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull()
    expect(doc.querySelector('base')!.getAttribute('href')).toContain(baseUrl)
  })
  it('restaura meta de refresh no corpo ao salvar, sem executá-la no editor', () => {
    const model = visualHtml('<body><p>Texto</p><meta http-equiv="refresh" content="0;url=/fora"></body>', baseUrl)
    const doc = parse(model.srcDoc)
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull()
    doc.querySelector('p')!.textContent = 'Mudou'
    expect(parse(model.read(doc)).body.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')).toBe('0;url=/fora')
  })
})
