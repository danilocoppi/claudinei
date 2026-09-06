// Production assets + captured GET responses, entirely offline. No live service
// commands, injected store, Vite, or JS sampling profiler in the timed window.
import { parseArgs } from 'node:util'
import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const { values } = parseArgs({ options: {
  assets: { type: 'string' }, fixtures: { type: 'string' }, output: { type: 'string' },
  session: { type: 'string' }, modes: { type: 'string', default: 'waiting,stream,reduced-motion,glass-off' },
  seconds: { type: 'string', default: '6' }, samples: { type: 'string', default: '1' },
} })
if (!values.assets || !values.fixtures || !values.output) {
  throw new Error('Required: --assets DIR --fixtures GET_RESPONSES.json --output METRICS.json')
}
const seconds = Number(values.seconds), samples = Number(values.samples)
if (!(seconds >= 1 && seconds <= 60 && Number.isInteger(samples) && samples >= 1 && samples <= 10)) {
  throw new Error('seconds: 1..60; samples: integer 1..10')
}
const modes = values.modes.split(',')
if (modes.some(m => !['waiting', 'stream', 'reduced-motion', 'glass-off'].includes(m))) throw new Error('Unknown mode')
const assets = resolve(values.assets)
const fixtures = JSON.parse(await readFile(values.fixtures, 'utf8'))
const sessions = fixtures['/api/sessions']
const active = sessions.find(s => values.session ? s.localId === values.session : s.engine === 'codex' && s.status === 'working')
if (!active) throw new Error('Fixture needs the active session (--session can select it)')
const project = fixtures['/api/projects'].find(p => p.id === active.projectId)
const history = fixtures[`/api/sessions/${active.localId}/history`]
if (!project || !Array.isArray(history) || !history.length) throw new Error('Missing project/history fixture')

// Optional profiling dependency; production installation does not need it.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
})
let streamTimer
try {
  const browserCdp = await browser.newBrowserCDPSession()
  const { gpu } = await browserCdp.send('SystemInfo.getInfo')
  const results = { gpu, scenario: {
    projects: fixtures['/api/projects'].length, sessions: sessions.length,
    working: sessions.filter(s => s.status === 'working').length,
    historyEvents: history.length, historyBytes: Buffer.byteLength(JSON.stringify(history)),
    viewport: { width: 1610, height: 1036 },
  }, samples: [] }
  const processes = async () => Object.fromEntries((await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.map(p => [p.id, p]))
  for (const mode of modes) for (let sample = 1; sample <= samples; sample++) {
    const ctx = await browser.newContext({ viewport: results.scenario.viewport, deviceScaleFactor: 1, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    const errors = [], unknownApis = new Set()
    let wire, sent = 0
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(ids => {
      localStorage.setItem('claudinei:collapsedCards', JSON.stringify(ids))
      localStorage.setItem('claudinei:sidebarWidth', '292')
      localStorage.setItem('claudinei.usageAdvanced', '1')
      window.profileCalls = { scroll: 0, mutations: 0 }
      const original = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (...args) {
        window.profileCalls.scroll++
        return original.apply(this, args)
      }
      new MutationObserver(ms => window.profileCalls.mutations += ms.length)
        .observe(document, { subtree: true, childList: true, characterData: true })
    }, fixtures['/api/projects'].map(p => p.id))
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/')) {
        if (Object.hasOwn(fixtures, path)) return route.fulfill({ json: fixtures[path] })
        if (path === '/api/local-apps/terminals') return route.fulfill({ json: { options: [], chosen: null } })
        unknownApis.add(path)
        return route.fulfill({ json: [] })
      }
      const file = resolve(assets, path === '/' ? 'index.html' : '.' + path)
      if (file.startsWith(assets + sep)) {
        try { await access(file); return route.fulfill({ path: file }) } catch { /* absent asset */ }
      }
      return route.fulfill({ status: 404, body: '' })
    })
    await page.routeWebSocket('**/ws', ws => {
      wire = ws
      ws.send(JSON.stringify({ type: 'sessions_snapshot', sessions }))
    })
    await page.goto('http://profile.invalid/')
    await page.locator('.term-card').filter({ has: page.getByText(project.name, { exact: true }) }).click()
    await page.waitForSelector('.chat-scroll .markdown')
    await page.waitForTimeout(1500)
    if (mode === 'reduced-motion') await page.evaluate(() => document.documentElement.dataset.motion = 'reduced')
    if (mode === 'glass-off') await page.evaluate(() => document.documentElement.dataset.glass = 'off')
    await page.locator('.chat-scroll').evaluate(e => e.scrollTop = e.scrollHeight)
    if (mode === 'stream') streamTimer = setInterval(() => {
      sent++
      wire.send(JSON.stringify({ type: 'session_event', localId: active.localId, event: { kind: 'stream', text: ' texto', raw: {} } }))
    }, 20)
    await page.waitForTimeout(1000)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const beforeProcesses = await processes(), before = await metrics()
    const beforeCalls = await page.evaluate(() => ({ ...window.profileCalls }))
    await page.waitForTimeout(seconds * 1000)
    const after = await metrics(), afterProcesses = await processes()
    const afterCalls = await page.evaluate(() => ({ ...window.profileCalls }))
    clearInterval(streamTimer)
    await page.waitForTimeout(350)
    const animations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)
    if (mode === 'stream') {
      const text = await page.locator('.chat-scroll .markdown').last().textContent()
      if (text !== ' texto'.repeat(sent)) throw new Error(`Lost deltas: ${text?.length} / ${sent * 6}`)
    }
    if (mode === 'reduced-motion' && animations) throw new Error('Reduced motion left active animations')
    if (mode === 'glass-off' && await page.evaluate(() => [...document.querySelectorAll('*')].some(e => getComputedStyle(e).backdropFilter !== 'none'))) {
      throw new Error('Glass off left backdrop filters')
    }
    const row = {
      mode, sample, seconds: after.Timestamp - before.Timestamp,
      mainThreadMs: 1000 * (after.TaskDuration - before.TaskDuration),
      scriptMs: 1000 * (after.ScriptDuration - before.ScriptDuration),
      layoutMs: 1000 * (after.LayoutDuration - before.LayoutDuration),
      styleMs: 1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration),
      processes: Object.values(afterProcesses).map(p => ({ type: p.type, cpuMs: 1000 * (p.cpuTime - (beforeProcesses[p.id]?.cpuTime ?? p.cpuTime)) })),
      scrolls: afterCalls.scroll - beforeCalls.scroll, mutations: afterCalls.mutations - beforeCalls.mutations,
      animations, sentDeltas: sent, errors, unknownApis: [...unknownApis],
    }
    results.samples.push(row)
    console.log(JSON.stringify(row))
    await writeFile(values.output, JSON.stringify(results, null, 2), { mode: 0o600 })
    if (errors.length) throw new Error('Frontend errors; see output')
    await ctx.close()
  }
} finally {
  clearInterval(streamTimer)
  await browser.close()
}
