// Optional Playwright check of the real composer/CSS against a temporary filesystem.
// Does not connect to the running Claudinei service or start an agent session.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Module, { createRequire } from 'node:module'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(repo, 'package.json'))
const esbuild = require('esbuild')
const output = await mkdtemp(join(tmpdir(), 'claudinei-file-mentions-'))
const project = join(output, 'project')
const filename = 'ação "nova" com espaços.tsx'
const longName = `${'nome-muito-longo-'.repeat(10)}.md`
await mkdir(join(project, 'src'), { recursive: true })
await mkdir(join(project, 'empty'))
await mkdir(join(project, 'many'))
await Promise.all([
  writeFile(join(project, 'README'), ''), writeFile(join(project, '.env'), ''),
  writeFile(join(project, 'src', filename), ''), writeFile(join(project, 'src', longName), ''),
  ...Array.from({ length: 105 }, (_, i) => writeFile(join(project, 'many', `file-${i}.txt`), '')),
])
const listingBundle = await esbuild.build({
  entryPoints: [join(repo, 'server/src/files/list.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
})
const listingModule = new Module(join(repo, 'scripts/file-list-fixture.cjs'))
listingModule._compile(listingBundle.outputFiles[0].text, join(repo, 'scripts/file-list-fixture.cjs'))
const { listProjectFiles } = listingModule.exports
const bundle = await esbuild.build({
  stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client'
    import { ChatInput } from './web/src/components/ChatInput'
    import { ViewportPopover } from './web/src/components/ViewportPopover'
    import { WsContext } from './web/src/wsContext'
    import { useStore } from './web/src/store'
    import i18n from './web/src/i18n'
    import { applyAppearance } from './web/src/appearance'
    await i18n.changeLanguage('pt-BR')
    applyAppearance()
    useStore.setState({ projects: [
      { id: 42, name: 'Projeto local', path: '/fixture', color: '#fff', icon: '📁' },
      { id: 43, name: 'Outro terminal', path: '/other', color: '#fff', icon: '📁' }
    ], sessions: { s1: { localId: 's1', projectId: 42, engine: 'codex', status: 'idle', engineSessionId: 'c', updatedAt: 'x' } },
      chat: {}, engines: [{ id: 'codex', label: 'Codex', icon: 'openai', models: [''], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] }] })
    window.sent = []
    window.changeLocale = (locale) => i18n.changeLanguage(locale)
    window.appearance = applyAppearance
    createRoot(document.getElementById('root')).render(
      <WsContext.Provider value={{ send: message => window.sent.push(message) }}>
        <main className="chat"><div className="chat-header"><strong>Projeto local</strong></div>
          <div className="fixture-chat">Referências aos arquivos do projeto</div>
          <ChatInput localId="s1" disabled={false} />
        </main>
      </WsContext.Provider>)
    window.oldPopover = () => createRoot(document.getElementById('legacy')).render(
      <ViewportPopover x={innerWidth - 5} y={innerHeight - 5} minWidth={200}>
        <button type="button">Ação existente</button>
      </ViewportPopover>)
  ` }, bundle: true, jsx: 'automatic', format: 'esm', write: false,
})
const css = await readFile(join(repo, 'web/src/styles.css'), 'utf8')
let failure = false
let delay = 0
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return }
  if (url.pathname === '/api/files/list') {
    res.setHeader('Content-Type', 'application/json')
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (failure) { failure = false; res.statusCode = 503; res.end('{"error":"directory_unavailable"}'); return }
    try {
      const q = url.searchParams
      res.end(JSON.stringify(await listProjectFiles(project, q.get('path') || '', q.get('query') || '', Number(q.get('offset')))))
    } catch { res.statusCode = 404; res.end('{"error":"directory_not_found"}') }
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>
    #root{height:100dvh}.chat{height:100%;display:flex;flex-direction:column}.fixture-chat{flex:1;padding:20px;color:var(--text-dim)}
  </style></head><body><div id="root"></div><div id="legacy"></div><script type="module" src="/bundle.js"></script></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(5000)
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const composer = page.locator('textarea')
  const search = page.locator('.file-mention__search input')
  const dialog = page.getByRole('dialog')
  const file = name => dialog.locator('.file-mention__item').filter({ has: page.getByText(name, { exact: true }) })
  const open = async () => { await composer.fill('veja @!'); await file('README').waitFor() }
  const bounds = async () => {
    const box = await page.locator('.sess-pop').boundingBox()
    const viewport = page.viewportSize()
    assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= viewport.width - 7 && box.y + box.height <= viewport.height - 7, JSON.stringify({ box, viewport }))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
  await open()
  assert.ok(await search.evaluate(el => el === document.activeElement))
  await file('src').click()
  await file(longName).waitFor()
  await search.fill('acao nova')
  await search.press('Enter') // flush debounce without accidentally sending the chat
  await file(filename).waitFor()
  await search.press('ArrowDown')
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  const reference = `veja ${JSON.stringify(`./src/${filename}`)} `
  assert.equal(await composer.inputValue(), reference)
  assert.equal(await page.evaluate(() => window.sent.length), 0)
  await composer.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'send_message', localId: 's1', text: reference.trim() }])

  await open()
  await file('many').click()
  await file('file-99.txt').waitFor()
  await dialog.getByRole('button', { name: 'Carregar mais' }).click()
  await file('file-104.txt').waitFor()
  assert.equal(await dialog.locator('.file-mention__item').count(), 105)
  await file('file-104.txt').click()
  assert.equal(await composer.inputValue(), 'veja "./many/file-104.txt" ')
  await open()
  await search.fill('não-existe')
  await dialog.getByText('Nenhum arquivo ou pasta com esse nome.').waitFor()
  await dialog.getByRole('button', { name: 'Limpar busca' }).click()
  await file('empty').click()
  await dialog.getByText('Esta pasta está vazia.').waitFor()
  await dialog.getByRole('button', { name: 'Voltar à pasta anterior' }).click()
  await file('README').waitFor()
  await search.press('Escape')
  assert.equal(await composer.inputValue(), 'veja @!')
  assert.ok(await composer.evaluate(el => el === document.activeElement))

  failure = true
  await composer.fill('@!')
  await page.getByRole('alert').waitFor()
  await dialog.getByRole('button', { name: 'Tentar novamente' }).click()
  await file('README').waitFor()
  await search.press('Escape')
  delay = 800
  await composer.fill('teste @!')
  await dialog.getByRole('status').waitFor()
  const loadingBox = await page.locator('.sess-pop').boundingBox()
  await file('README').waitFor()
  assert.deepEqual(await page.locator('.sess-pop').boundingBox(), loadingBox, 'Loading moved the search/controls')
  delay = 0
  await search.press('Escape')
  await page.context().setOffline(true)
  await composer.fill('@!')
  await page.getByRole('alert').waitFor()
  await page.context().setOffline(false)
  await dialog.getByRole('button', { name: 'Tentar novamente' }).click()
  await file('README').waitFor()
  await search.press('Escape')

  // Compare the sibling @@ interaction, which still inserts a terminal reference.
  await composer.fill('@@')
  await page.getByTestId('mention-search').fill('Outro')
  await page.getByTestId('mention-search').press('Enter')
  assert.ok((await composer.inputValue()).includes('Outro terminal'))
  await page.waitForFunction(() => document.activeElement === document.querySelector('textarea'))

  for (const viewport of [{ width: 1280, height: 800 }, { width: 393, height: 852 }, { width: 393, height: 360 }, { width: 320, height: 480 }]) {
    await page.setViewportSize(viewport)
    await open(); await file('src').click(); await file(longName).waitFor()
    await bounds()
    await page.screenshot({ path: join(output, `popup-${viewport.width}x${viewport.height}.png`) })
    await file(filename).click()
    assert.equal(await composer.inputValue(), reference)
  }
  await page.setViewportSize({ width: 393, height: 852 })
  await open()
  await page.evaluate(() => { window.appearance({ theme: 'light-fun' }); return window.changeLocale('es') })
  await page.getByRole('dialog', { name: 'Referenciar archivo' }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await bounds()
  await page.screenshot({ path: join(output, 'popup-light-es.png') })
  await search.press('Escape')
  // The shared primitive still clamps existing coordinate-based action menus.
  await page.evaluate(() => window.oldPopover())
  await page.getByRole('button', { name: 'Ação existente' }).waitFor()
  await bounds()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, screenshots: output, viewports: 4, states: ['success', 'pagination', 'empty', 'no-results', 'error/retry', 'loading', 'offline/retry', 'keyboard', '@@', 'light/es', 'reduced-motion', 'legacy-popover'] }, null, 2))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(project, { recursive: true, force: true })
}
