// Real browser coverage, isolated from the running service and user files.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(repo, 'package.json'))
const output = await mkdtemp(join(tmpdir(), 'claudinei-html-visual-'))
const formBundle = await require('esbuild').build({ entryPoints: [join(repo, 'shared/html-form.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false, minify: true })
const { formBridgeScript } = await import(`data:text/javascript;base64,${Buffer.from(formBundle.outputFiles[0].text).toString('base64')}`)
const bundle = await require('esbuild').build({
  stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { FileViewerModal } from './web/src/components/FileViewerModal'
    import { InlineFileView } from './web/src/components/InlineFileView'
    import { useStore } from './web/src/store'
    import i18n from './web/src/i18n'
    import { applyAppearance } from './web/src/appearance'
    await i18n.changeLanguage('pt-BR')
    applyAppearance()
    window.locale = locale => i18n.changeLanguage(locale)
    window.appearance = applyAppearance
    window.dirty = () => useStore.getState().fileEditDirty
    window.openMode = (inline = false) => useStore.setState({ fileViewer: inline ? null : { path:'/fixture/index.html',kind:'code',projectId:7 },
      inlineFile: inline ? { path:'/fixture/index.html',kind:'code',projectId:7,localId:'s1' } : null })
    window.openMode()
    createRoot(document.getElementById('root')).render(<><FileViewerModal /><main className="fixture-chat"><div>Conversa</div><InlineFileView localId="s1" /><div>Mensagem</div></main></>)
  ` }, bundle: true, jsx: 'automatic', format: 'esm', write: false, minify: true, outfile: join(output, 'bundle.js'),
})
const script = `<script>try { parent.editorEscaped = true } catch {} document.body.dataset.ran = 'yes'</script>`
let content = `<!doctype html><html lang="pt-BR"><head><title>Documento</title><style>body{font:18px system-ui;padding:20px;color:#233547;background:#fff}h1{font-size:28px}p{line-height:1.6}</style><link rel="stylesheet" href="./page.css"></head><body><h1>Olá mundo</h1><p>Texto do documento</p><img src="./pixel.svg" alt="Marca" width="36" height="36">${script}</body></html>`
const original = content
const fields = `<form><label><input id="done" type="checkbox"> Revisado</label><br>
<label>Nome <input id="person" name="person"></label><br><label>Observações <textarea id="notes"></textarea></label><br>
<label>Status <select id="status"><option value="draft">Rascunho</option><option value="approved">Aprovado</option></select></label><br>
<label><input name="priority" type="radio" value="low" checked> Normal</label><label><input name="priority" type="radio" value="high"> Alta</label>
<div id="dynamic"></div><div id="editable" contenteditable="true">Anotações</div></form>
<script>document.getElementById('dynamic').innerHTML='<label>Campo gerado <input id="generated" value="inicial"></label>';
document.getElementById('done').addEventListener('change', event => document.body.dataset.checked=String(event.target.checked));</script>`
const hash = () => createHash('sha256').update(content).digest('hex')
const css = await readFile(join(repo, 'web/src/styles.css'), 'utf8')
let preview = 0
let failure = false
let writes = 0
let delay = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles.find(f => f.path.endsWith('.js')).text); return }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css + (bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text || '')); return }
  if (url.pathname === '/api/files/content') {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    res.setHeader('X-Content-Hash', hash()); res.end(content); return
  }
  if (url.pathname === '/api/files/preview') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({url:`/api/files/preview/t${++preview}/fixture/index.html`, channel:`channel${preview}`})); return }
  if (url.pathname === '/standalone.html') { res.setHeader('Content-Type', 'text/html'); res.end(content); return }
  if (url.pathname === '/api/files/write') {
    let body = ''; for await (const part of req) body += part
    const data = JSON.parse(body)
    res.setHeader('Content-Type', 'application/json')
    if (failure) { failure = false; res.statusCode = 503; res.end('{"error":"unavailable"}'); return }
    if (data.baseHash !== hash()) { res.statusCode = 409; res.end('{"error":"stale"}'); return }
    assert.equal(data.projectId, 7); assert.equal(data.path, '/fixture/index.html')
    content = data.content; writes++; res.end(JSON.stringify({hash:hash()})); return
  }
  if (url.pathname.startsWith('/api/files/preview/')) {
    if (url.pathname.endsWith('.css')) { res.setHeader('Content-Type', 'text/css'); res.end('p{border-left:3px solid #8198a8;padding-left:12px}'); return }
    if (url.pathname.endsWith('.svg')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="18" cy="18" r="16" fill="#8198a8"/></svg>'); return }
    const token = url.pathname.match(/\/t(\d+)\//)[1]
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Security-Policy', 'sandbox allow-scripts')
    res.end(content + `<script id="claudinei-preview-form-bridge">${formBridgeScript(`channel${token}`,hash())}</script>`); return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>.fixture-chat{height:100dvh;display:flex;flex-direction:column}.fixture-chat>div:first-child{flex:1}.fixture-chat>div:last-child{padding:20px}</style><div id="root"></div><script type="module" src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({headless:true})
try {
  const page = await browser.newPage({viewport:{width:1280,height:850}})
  page.setDefaultTimeout(5000)
  content = original.replace('</body>', fields + '</body>')
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const button = name => page.getByRole('button', {name, exact:true})
  const report = () => page.frameLocator('iframe[title="index.html"]')
  await report().locator('#generated').waitFor()
  assert.equal(await button('Salvar').count(), 0)
  await report().locator('#done').check()
  await button('Salvar').waitFor()
  await report().locator('#done').uncheck()
  await button('Salvar').waitFor({state:'hidden'})
  await report().locator('#done').check()
  await report().locator('#person').fill('Ana Coppi')
  await report().locator('#notes').fill('Relatório preenchido\nSegunda linha')
  await report().locator('#status').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await report().locator('input[value="high"]').check()
  await report().locator('#generated').fill('Valor gerado preenchido')
  await report().locator('#editable').fill('Observação editável')
  await button('Fonte').click()
  assert.match(await page.locator('.code-preview').innerText(), /Ana Coppi/)
  await button('Página').click()
  assert.equal(await report().locator('#person').inputValue(), 'Ana Coppi')
  assert.equal(await page.locator('.html-editor').count(), 0, 'Filling must not require Edit')
  assert.equal(writes, 0, 'No automatic writes')
  await button('Salvar').click()
  await page.waitForFunction(() => !window.dirty())
  await report().locator('#generated').waitFor()
  assert.equal(await report().locator('#person').inputValue(), 'Ana Coppi')
  assert.equal(await report().locator('#done').isChecked(), true)
  assert.equal(await report().locator('body').getAttribute('data-checked'), 'true')
  assert.equal(await report().locator('#status').inputValue(), 'approved')
  assert.equal(await report().locator('input[value="high"]').isChecked(), true)
  assert.equal(await report().locator('#generated').inputValue(), 'Valor gerado preenchido')
  assert.equal(await report().locator('#editable').innerText(), 'Observação editável')
  await button('Fechar').click(); await page.evaluate(() => window.openMode())
  await report().locator('#generated').waitFor()
  assert.equal(await report().locator('#notes').inputValue(), 'Relatório preenchido\nSegunda linha')
  assert.equal(await report().locator('#generated').inputValue(), 'Valor gerado preenchido')
  const standalone = await browser.newPage()
  await standalone.goto(`http://127.0.0.1:${server.address().port}/standalone.html`)
  assert.equal(await standalone.locator('#generated').inputValue(), 'Valor gerado preenchido')
  assert.equal(await standalone.locator('#done').isChecked(), true)
  await standalone.close()
  await report().locator('#person').fill('Sem salvar')
  await button('Salvar').waitFor()
  await button('Fechar').click(); await button('Cancelar').click()
  assert.equal(await report().locator('#person').inputValue(), 'Sem salvar')
  content += '<!-- alteração no disco -->'
  await button('Salvar').click()
  await page.getByRole('alert').filter({hasText:'mudou no disco'}).waitFor()
  assert.equal(await report().locator('#person').inputValue(), 'Sem salvar')
  await button('Recarregar').click()
  await report().locator('#person').waitFor()
  assert.equal(await report().locator('#person').inputValue(), 'Ana Coppi')
  assert.equal(writes, 1)
  await page.screenshot({path:join(output,'filled-report.png')})
  await page.setViewportSize({width:393,height:852})
  await page.evaluate(() => window.openMode(true))
  await report().locator('#person').fill('Preenchido no celular')
  await button('Salvar').waitFor()
  const mobileSave = await button('Salvar').boundingBox()
  assert.ok(mobileSave.x >= 0 && mobileSave.x + mobileSave.width <= 393)
  await page.screenshot({path:join(output,'fill-inline-393.png')})
  await button('Salvar').click()
  await page.waitForFunction(() => !window.dirty())
  await report().locator('#person').waitFor()
  assert.equal(await report().locator('#person').inputValue(),'Preenchido no celular')
  assert.equal(writes, 2)
  content = original; writes = 0
  await page.setViewportSize({width:1280,height:850})
  await page.reload()
  const editor = () => page.frameLocator('iframe[title^="Edição visual"]')
  const select = async selector => editor().locator(selector).evaluate(el => {
    const range = el.ownerDocument.createRange(); range.selectNodeContents(el)
    const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    el.ownerDocument.defaultView.focus()
  })
  const replaceHeading = async text => { await select('h1'); await page.keyboard.insertText(text) }
  await button('✏️ Editar').click()
  await editor().locator('h1').waitFor()
  assert.equal(await editor().locator('body').evaluate(el => el.ownerDocument.designMode), 'on')
  assert.equal(await page.evaluate(() => !!window.editorEscaped), false)
  assert.equal(await editor().locator('body').getAttribute('data-ran'), null)
  assert.equal(await editor().locator('p').evaluate(el => getComputedStyle(el).borderLeftWidth), '3px')
  await replaceHeading('Título editado')
  await select('p'); await button('Negrito').focus(); await page.keyboard.press('Enter')
  assert.match(await editor().locator('p').innerHTML(), /<(b|strong)>/)
  await button('Desfazer').click()
  assert.doesNotMatch(await editor().locator('p').innerHTML(), /<(b|strong)>/)
  await button('Refazer').click()
  await page.screenshot({path:join(output, 'popup-desktop.png')})
  await button('Fonte').click()
  assert.match(await page.locator('.cm-content').innerText(), /Título editado/)
  await page.locator('.cm-content').press('Control+End')
  await page.keyboard.insertText('\n<!-- alterado no fonte -->')
  await button('Página').click()
  assert.equal(await editor().locator('h1').innerText(), 'Título editado')
  assert.equal(await page.evaluate(() => window.dirty()), true)
  await button('Concluir').click(); await button('Cancelar').click()
  assert.equal(await editor().locator('h1').innerText(), 'Título editado')
  await button('Salvar').click()
  await page.waitForFunction(() => !window.dirty())
  assert.equal(writes, 1)
  assert.ok(content.includes(script)); assert.ok(content.includes('src="./pixel.svg"'))
  assert.ok(content.includes('<!-- alterado no fonte -->'))
  assert.ok(!content.includes('Content-Security-Policy') && !content.includes('claudinei-editor-'))
  await replaceHeading('Conflito local')
  content = content.replace('Título editado', 'Alterado no disco')
  await button('Salvar').click()
  await page.getByRole('alert').filter({hasText:'mudou no disco'}).waitFor()
  assert.equal(await editor().locator('h1').innerText(), 'Conflito local')
  await button('Recarregar').click()
  await editor().getByText('Alterado no disco', {exact:true}).waitFor()
  await replaceHeading('Recuperado')
  failure = true
  await button('Salvar').click()
  await page.getByRole('alert').filter({hasText:'Não foi possível salvar'}).waitFor()
  assert.equal(await editor().locator('h1').innerText(), 'Recuperado')
  await select('h1'); await page.keyboard.press('Control+s')
  await page.waitForFunction(() => !window.dirty())
  await button('Concluir').click()
  await button('✏️ Editar').waitFor()
  delay = 500
  await page.evaluate(() => window.openMode(true))
  await page.getByText('Carregando…').first().waitFor()
  await button('✏️ Editar').click()
  delay = 0
  for (const width of [393, 320]) {
    await page.setViewportSize({width,height:852})
    await editor().locator('h1').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const bounds = await page.locator('.html-editor iframe').boundingBox()
    assert.ok(bounds.height > 90, JSON.stringify(bounds))
    const save = await button('Salvar').boundingBox()
    assert.ok(save.x >= 0 && save.x + save.width <= width)
    await page.screenshot({path:join(output, `inline-${width}.png`)})
  }
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.evaluate(() => { window.locale('es'); window.appearance({theme:'light-fun'}) })
  await page.getByRole('button', {name:'Negrita',exact:true}).waitFor()
  await page.screenshot({path:join(output, 'inline-es.png')})
  console.log(JSON.stringify({passed:true, writes, fillWithoutEdit:true, reopen:true, standalone:true, sandbox:true, sourceRoundTrip:true, conflict:true, retry:true, widths:[393,320], screenshots:output}))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
