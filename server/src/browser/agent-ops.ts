// As operações do agente sobre a aba do terminal: snapshot com referências e
// máscara de senha, act, wait, screenshot, console, close e a linha de estado.
// São criadas a cada chamada; o que precisa durar entre chamadas (a última
// snapshot, as mensagens do console, a última ação) mora na aba.
//
// Três guardas valem para todas:
// - o bastão: as que mudam a página (open com URL, navigate, act, close) ficam
//   entre `beginAgent` e `endAgent`; com o operador no comando, são recusadas;
// - o diálogo pendente: com um `confirm`/`prompt` aberto, o Chromium não avalia
//   nada na página nem captura a tela (ensaio com o 1255: snapshot, screenshot e
//   clique ficam presos até o prazo). Tudo o que tocaria a página responde na hora
//   com DIALOG_PENDING; a snapshot descreve o diálogo sem tocar na página, e o
//   console vem da memória. Um diálogo que abre no meio de uma ação a encerra;
// - a aba que some (ociosidade, despejo, Chromium caído): a operação em curso
//   corre contra o `onClosed` e volta com TabGoneError, sem pendurar;
// - a página ocupada (script em laço): `frame.evaluate` e `locator.count` não têm
//   prazo, e a thread principal presa não dispara o `crash`. Toda operação tem um
//   prazo geral (PAGE_BUSY ao fim dele). Ensaio com o 1255: com a página em laço,
//   `reload` e `goto` estouram o prazo e só fechar o contexto solta a aba.
//
// No código do Claudinei, `evaluate` só com string (o pkg perde o texto das funções).
import type { Locator, Page } from 'playwright-core'
import type { PendingDialog, TerminalTab } from './terminal-tab.js'
import { TEXTS, type ConsoleEntry, type TabCloseReason } from './types.js'

export type ActAction = 'click' | 'type' | 'fill' | 'press' | 'hover' | 'select' | 'scroll' | 'dialog'
export interface ActArgs { action: ActAction; ref?: string; text?: string; key?: string; dx?: number; dy?: number; accept?: boolean }
export type WaitArgs = { text: string } | { textGone: string } | { url: string } | { seconds: number }

/** A referência é de antes da última ação do operador, ou a página mudou desde a snapshot. */
export class StaleRefError extends Error {
  readonly code = 'stale_ref' as const
  constructor() {
    super(TEXTS.STALE_REF)
    this.name = 'StaleRefError'
  }
}

/** Há um `confirm`/`prompt` esperando resposta: só a ação `dialog` e a leitura seguem. */
export class DialogPendingError extends Error {
  readonly code = 'dialog_pending' as const
  constructor() {
    super(TEXTS.DIALOG_PENDING)
    this.name = 'DialogPendingError'
  }
}

/** A aba fechou (antes ou durante a operação). */
export class TabGoneError extends Error {
  readonly code = 'tab_gone' as const
  readonly reason: TabCloseReason
  constructor(reason: TabCloseReason) {
    super(`the browser tab closed (${reason}); call browser_open again`)
    this.name = 'TabGoneError'
    this.reason = reason
  }
}

/** Argumento faltando ou inválido para a operação (a rota responde 400 bad_args). */
export class BadArgsError extends Error {
  readonly code = 'bad_args' as const
  constructor(message: string) {
    super(message)
    this.name = 'BadArgsError'
  }
}

/** A operação em curso: encerrada (resposta já dada ao agente), o resto dela para. */
interface Run {
  /** Lança se a operação já foi encerrada (diálogo, prazo, aba fechada). */
  check(): void
}

export interface AgentOps {
  /** Sem url: leitura. Com url: muda a página (bastão). */
  open(url?: string): Promise<string>
  navigate(a: { url: string } | { action: 'back' | 'forward' | 'reload' }): Promise<string>
  snapshot(depth?: number): Promise<string>
  /** Devolve a descrição: "clicked 'Send'". */
  act(a: ActArgs): Promise<string>
  wait(w: WaitArgs): Promise<string>
  screenshot(fullPage?: boolean): Promise<Buffer>
  /** As últimas 50 mensagens. */
  console(): ConsoleEntry[]
  close(): Promise<void>
}

// Números da spec.
const SNAPSHOT_MAX = 60_000
const CONSOLE_LIMIT = 50
const WAIT_MAX_MS = 30_000
// Prazos do Playwright: sem eles, uma ação presa (elemento coberto, página parada)
// seguraria a ferramenta pelo padrão de 30 s, ou para sempre na snapshot.
const ACT_TIMEOUT_MS = 10_000
const SNAPSHOT_TIMEOUT_MS = 10_000
const SCREENSHOT_TIMEOUT_MS = 20_000
/** Prazo geral de uma operação: acima do teto de 30 s do wait e dos prazos do Playwright. */
const GUARD_TIMEOUT_MS = 35_000
/** Prazo de cada leitura dos valores de senha: a do quadro principal sem resposta recusa a snapshot. */
const PASSWORD_READ_TIMEOUT_MS = 5_000

const MASK = '••••'
const CRASHED = 'page crashed; use browser_navigate action=reload'
/** A página não respondeu no prazo (o reload também não a solta: só uma aba nova). */
export const PAGE_BUSY = 'the page is not responding (busy?); call browser_close, then browser_open'
/**
 * Os valores dos campos de senha de um quadro: expressão em string, nunca função.
 * Desce pelas shadow roots abertas, que a snapshot ARIA também mostra (as
 * fechadas ficam fora das duas).
 */
const PASSWORD_VALUES = "(() => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll('*')) { if (e.matches('input[type=password]')) out.push(e.value); if (e.shadowRoot) walk(e.shadowRoot) } }; walk(document); return out })()"
/** A referência da snapshot (`e6`, `f1e3` num iframe): nada além disso entra no seletor. */
const REF = /^[A-Za-z0-9]+$/

/**
 * Os marcadores que o Playwright 1.65 põe depois do papel e do nome
 * (`[ref=e6]`, `[level=1]`, `[cursor=pointer]`…): a máscara não entra neles,
 * senão a senha "6" estragaria a ref `e6`.
 */
const ARIA_MARK = / \[(?:checked(?:=mixed)?|disabled|expanded|active|invalid(?:=grammar|=spelling)?|level=\d+|pressed(?:=mixed)?|selected|aria-hidden|ref=[A-Za-z0-9]+|cursor=pointer|box=[-\d.,]+)\]/g

/**
 * Cada valor não vazio vira '••••' em toda a snapshot (redução de dano: sobra
 * mascarado a mais, nunca a menos), menos dentro dos marcadores ARIA. Vale também
 * a forma escapada que o YAML da snapshot usa para valores com aspas ou barra.
 */
export function maskPasswords(snapshot: string, values: string[]): string {
  const forms = new Set<string>()
  for (const v of values) {
    if (!v) continue
    forms.add(v)
    forms.add(JSON.stringify(v).slice(1, -1))
    forms.add(v.replace(/'/g, "''"))
  }
  if (forms.size === 0) return snapshot
  // Onde estão os marcadores: uma ocorrência inteira dentro de um deles fica.
  const markEnd = new Int32Array(snapshot.length).fill(-1)
  for (const m of snapshot.matchAll(ARIA_MARK)) {
    for (let i = m.index; i < m.index + m[0].length; i++) markEnd[i] = m.index + m[0].length
  }
  // Marca cada caractere coberto por alguma ocorrência (sobrepostas também): a
  // união sai como uma máscara só, sem sobra entre dois valores que se cruzam.
  const covered = new Uint8Array(snapshot.length)
  for (const f of forms) {
    for (let at = snapshot.indexOf(f); at !== -1; at = snapshot.indexOf(f, at + 1)) {
      const end = at + f.length
      if (markEnd[at] !== -1 && end <= markEnd[at]) continue
      covered.fill(1, at, end)
    }
  }
  let out = ''
  for (let i = 0; i < snapshot.length;) {
    if (!covered[i]) { out += snapshot[i++]; continue }
    while (i < snapshot.length && covered[i]) i++
    out += MASK
  }
  return out
}

/** A primeira linha (URL, título, comando) e um `Notice:` por aviso novo ao agente. */
export function statusLine(tab: TerminalTab): string {
  const s = tab.state()
  const b = tab.baton.state()
  const control = b.kind === 'operator' ? `operator (${b.name})` : b.kind
  return [`Browser: ${s.url} | ${s.title} | control: ${control}`, ...tab.takeAgentNotices().map((n) => `Notice: ${n}`)].join('\n')
}

/** O nome acessível da linha `[ref=eN]` da snapshot; sem nome, o papel; sem linha, a ref. */
function nameOf(snapshot: string, ref: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(`[ref=${ref}]`))
  if (!line) return ref
  // `- button "Enviar" [ref=e6]`; com caractere especial o YAML põe a linha toda
  // entre aspas simples (`- 'button "a: b" [ref=e5]'`, com '' para cada ').
  const m = /^\s*-\s+('?)([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line)
  if (!m) return ref
  if (m[3] === undefined) return m[2]
  const name = m[3].replace(/\\(.)/g, '$1')
  return m[1] ? name.replace(/''/g, "'") : name
}

/** Erro do Playwright sai só com a primeira linha (sem o "Call log"); os nossos passam como estão. */
function legible(err: unknown): unknown {
  if (!(err instanceof Error) || 'code' in err) return err
  const first = err.message.split('\n')[0].trim()
  if (first === err.message) return err
  const out = new Error(first)
  out.name = err.name
  return out
}

const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError'

/** A descrição que vai à coluna e ao agente; `selected` leva o texto escolhido. */
function describe(a: ActArgs, name: string): string {
  switch (a.action) {
    case 'click': return `clicked '${name}'`
    case 'type': return `typed into '${name}'`
    case 'fill': return `filled '${name}'`
    case 'press': return `pressed ${a.key}`
    case 'hover': return `hovered '${name}'`
    case 'select': return `selected '${a.text}' in '${name}'`
    case 'scroll': return `scrolled ${a.dx ?? 0},${a.dy ?? 0}`
    case 'dialog': return `answered dialog: ${a.accept ? 'accept' : 'dismiss'}`
  }
}

const NEEDS_REF = new Set<ActAction>(['click', 'type', 'fill', 'hover', 'select'])
const NEEDS_TEXT = new Set<ActAction>(['type', 'fill', 'select'])

/** Confere os argumentos antes de tocar no bastão ou na página. */
function checkAct(a: ActArgs): void {
  const actions: ActAction[] = ['click', 'type', 'fill', 'press', 'hover', 'select', 'scroll', 'dialog']
  if (!a || !actions.includes(a.action)) throw new BadArgsError(`action must be one of ${actions.join(', ')}`)
  if (NEEDS_REF.has(a.action) && !a.ref) throw new BadArgsError(`action=${a.action} needs a ref from browser_snapshot`)
  if (a.ref !== undefined && !REF.test(a.ref)) throw new BadArgsError(`invalid ref '${a.ref}'; use a ref like e6 from browser_snapshot`)
  if (NEEDS_TEXT.has(a.action) && typeof a.text !== 'string') throw new BadArgsError(`action=${a.action} needs text`)
  if (a.action === 'press' && !a.key) throw new BadArgsError('action=press needs key (e.g. Enter, Control+A)')
  if (a.action === 'dialog' && typeof a.accept !== 'boolean') throw new BadArgsError('action=dialog needs accept=true|false')
  if (a.action === 'scroll') {
    for (const v of [a.dx, a.dy]) {
      if (v !== undefined && !Number.isFinite(v)) throw new BadArgsError('dx and dy must be numbers')
    }
  }
}

/** O diálogo como a snapshot o mostra: a página fica inacessível até a resposta. */
function dialogText(d: PendingDialog): string {
  const dflt = d.type === 'prompt' ? ` (default "${d.defaultValue ?? ''}")` : ''
  return `- dialog (pending): ${d.type} "${d.message}"${dflt}\n` +
    '[the page is blocked until the dialog is answered: browser_act action=dialog accept=true|false (text answers a prompt)]'
}

/** `p` com prazo: estourado, rejeita com `onTimeout()` (a promessa que sobra é descartada). */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (err: unknown) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Os valores de senha de todos os quadros, cada leitura com prazo curto. Quadro
 * filho que sumiu ou falhou não impede os outros; o quadro principal que não
 * responde recusa a snapshot (falha fechada: seguir sem os valores vazaria a senha).
 */
async function passwordValues(page: Page): Promise<string[]> {
  const main = page.mainFrame()
  const all = await Promise.all(page.frames().map((f) => {
    const read = withDeadline(f.evaluate(PASSWORD_VALUES), PASSWORD_READ_TIMEOUT_MS, () => new Error(PAGE_BUSY))
      .then((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []))
    return f === main ? read : read.catch(() => [] as string[])
  }))
  return all.flat()
}

export function agentOps(
  tab: TerminalTab,
  o: {
    /** Fecha a aba pelo host (que a tira do mapa); a `close` passa sempre 'closed_by_agent'. */
    closeTab: (reason: 'closed_by_agent') => Promise<void>
    /** O relógio do `lastAgentAt` (o do host; padrão Date.now). */
    now?: () => number
  },
): AgentOps {
  const now = o.now ?? Date.now

  /** Toda operação conta como uso (a varredura de ociosidade lê) e falha com a aba fechada. */
  function begin(): void {
    tab.lastAgentAt = now()
    const reason = tab.closedReason()
    if (reason) throw new TabGoneError(reason)
  }

  const assertNoDialog = () => { if (tab.state().dialog) throw new DialogPendingError() }
  const assertAlive = () => { if (tab.state().crashed) throw new Error(CRASHED) }

  /**
   * Corre `work` contra o fechamento da aba, contra o prazo geral e, com
   * `onDialog`, contra um diálogo que abre no meio (o Playwright ficaria preso
   * atrás dele): o que `onDialog` devolve (ou lança) vira o resultado. A promessa
   * do Playwright que sobra é descartada; ela termina quando o diálogo for
   * respondido ou a aba fechar. Encerrada a operação, `run.check()` lança entre
   * os awaits de `work`: o que sobrou não segue fora do bastão.
   */
  function guarded<T>(work: (run: Run) => Promise<T>, onDialog?: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const offs: Array<() => void> = []
      let settled = false
      const run: Run = {
        check() { if (settled) throw new Error('operation abandoned') },
      }
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        for (const off of offs) off()
        fn()
      }
      offs.push(tab.onClosed((reason) => finish(() => reject(new TabGoneError(reason)))))
      if (settled) return
      const timer = setTimeout(() => finish(() => reject(new Error(PAGE_BUSY))), GUARD_TIMEOUT_MS)
      offs.push(() => clearTimeout(timer))
      if (onDialog) {
        offs.push(tab.onState(() => {
          if (!tab.state().dialog) return
          finish(() => {
            try { resolve(onDialog()) } catch (err) { reject(err) }
          })
        }))
      }
      let p: Promise<T>
      try { p = work(run) } catch (err) { finish(() => reject(legible(err))); return }
      p.then((v) => finish(() => resolve(v)), (err) => finish(() => reject(legible(err))))
    })
  }

  /** Operação que muda a página: bastão do agente durante ela; diálogo pendente recusa, exceto `dialog`. */
  async function mutate<T>(work: (run: Run) => Promise<T>, onDialog?: () => T, allowDialog = false): Promise<T> {
    begin()
    tab.baton.beginAgent()
    try {
      if (!allowDialog) assertNoDialog()
      return await guarded(work, onDialog)
    } finally {
      tab.baton.endAgent()
    }
  }

  /** A referência vale contra a última snapshot e o epoch do bastão de quando foi tirada. */
  async function resolveRef(ref: string, run: Run): Promise<{ locator: Locator; name: string }> {
    const snap = tab.agentSnapshot
    if (!snap || snap.epoch !== tab.baton.epoch()) throw new StaleRefError()
    const locator = tab.page().locator(`aria-ref=${ref}`)
    // Página que navegou ou recriou o documento: a ref não acha nada (e o
    // Playwright esperaria o prazo inteiro por ela), ou o quadro dela já não
    // existe ("Invalid frame in aria-ref selector", visto no 1255 após reload).
    const found = await locator.count().catch((err: unknown) => {
      if (err instanceof Error && err.message.includes('aria-ref')) return 0
      throw err
    })
    run.check()
    if (found === 0) throw new StaleRefError()
    return { locator, name: nameOf(snap.text, ref) }
  }

  const navText = (verb: string) => () => `${verb} ${tab.state().url}`

  return {
    async open(url) {
      if (url === undefined) {
        begin()
        return `browser open at ${tab.state().url}`
      }
      const text = navText('opened')
      return mutate(async () => { await tab.navigate(url); return text() }, text)
    },

    async navigate(a) {
      if (a && 'url' in a && typeof a.url === 'string') {
        const text = navText('navigated to')
        return mutate(async () => { await tab.navigate(a.url); return text() }, text)
      }
      const action = a && 'action' in a ? a.action : undefined
      const verbs = { back: 'went back to', forward: 'went forward to', reload: 'reloaded' } as const
      if (action !== 'back' && action !== 'forward' && action !== 'reload') {
        throw new BadArgsError("navigate needs url or action ('back' | 'forward' | 'reload')")
      }
      const text = navText(verbs[action])
      return mutate(async () => { await tab.history(action); return text() }, text)
    },

    async snapshot(depth) {
      if (depth !== undefined && !(Number.isInteger(depth) && depth > 0)) throw new BadArgsError('depth must be a positive integer')
      begin()
      const pending = tab.state().dialog
      if (pending) return dialogText(pending)
      assertAlive()
      return guarded(async (run) => {
        const page = tab.page()
        // O epoch antes da leitura: uma ação do operador no meio deixa a snapshot velha.
        const epoch = tab.baton.epoch()
        // Os valores antes e depois: o campo editado no meio também sai mascarado.
        const before = await passwordValues(page)
        run.check()
        const raw = await page.ariaSnapshot({ mode: 'ai', ...(depth !== undefined ? { depth } : {}), timeout: SNAPSHOT_TIMEOUT_MS })
        run.check()
        const after = await passwordValues(page)
        // Abandonada (diálogo, prazo): o agente não viu esta snapshot, e as refs dele são da anterior.
        run.check()
        let text = maskPasswords(raw, [...before, ...after])
        if (text.length > SNAPSHOT_MAX) text = text.slice(0, SNAPSHOT_MAX) + TEXTS.SNAPSHOT_CUT
        tab.agentSnapshot = { epoch, text }
        return text
      }, () => dialogText(tab.state().dialog!))
    },

    async act(a) {
      checkAct(a)
      if (a.action === 'dialog') {
        return mutate(async () => {
          if (!tab.state().dialog) throw new Error('no dialog is pending')
          tab.answerDialog(a.accept!, a.text)
          const text = describe(a, '')
          tab.setLastAction(text)
          return text
        }, undefined, true)
      }
      let text = ''
      let point: { x: number; y: number } | undefined
      let reported = false
      // Ligada logo antes de chamar a ação do Playwright: só daí em diante um
      // diálogo pode ter sido aberto por ela.
      let dispatched = false
      // O diálogo aberto pela própria ação (um `confirm` no clique) encerra a
      // ação com sucesso: ela aconteceu, e o aviso vai na linha de estado. A
      // promessa do Playwright só termina depois da resposta ao diálogo: aí não
      // grava de novo (passaria por cima de "answered dialog").
      const done = () => {
        if (!reported) {
          reported = true
          tab.setLastAction(text, point)
        }
        return text
      }
      return mutate(async (run) => {
        assertAlive()
        const page = tab.page()
        let target: { locator: Locator; name: string } | undefined
        if (a.ref) target = await resolveRef(a.ref, run)
        text = describe(a, target?.name ?? '')
        const timeout = ACT_TIMEOUT_MS
        // Daqui em diante, nada de await antes da ação: `dispatched` vale a partir da chamada.
        const go = () => { run.check(); dispatched = true }
        switch (a.action) {
          case 'click': {
            const box = await target!.locator.boundingBox({ timeout })
            if (box) point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
            go()
            await target!.locator.click({ timeout })
            break
          }
          case 'type': go(); await target!.locator.pressSequentially(a.text!, { timeout }); break
          case 'fill': go(); await target!.locator.fill(a.text!, { timeout }); break
          case 'press':
            go()
            if (target) await target.locator.press(a.key!, { timeout })
            else await page.keyboard.press(a.key!)
            break
          case 'hover': go(); await target!.locator.hover({ timeout }); break
          case 'select': go(); await target!.locator.selectOption(a.text!, { timeout }); break
          case 'scroll': go(); await page.mouse.wheel(a.dx ?? 0, a.dy ?? 0); break
        }
        return done()
      }, () => {
        // Diálogo antes de a ação ser disparada (resolvendo a ref, medindo a caixa):
        // não houve ação, e o resto dela é abandonado (o `run.check()` a para).
        if (!dispatched) throw new DialogPendingError()
        return done()
      })
    },

    async wait(w) {
      const keys = w && typeof w === 'object' ? Object.keys(w).filter((k) => (w as Record<string, unknown>)[k] !== undefined) : []
      if (keys.length !== 1) throw new BadArgsError('wait needs exactly one of text, textGone, url or seconds')
      if (!('seconds' in w)) {
        const v = 'text' in w ? w.text : 'textGone' in w ? w.textGone : 'url' in w ? w.url : undefined
        if (typeof v !== 'string' || !v) throw new BadArgsError(`${keys[0]} must be a non-empty string`)
      }
      begin()
      assertNoDialog()
      if ('seconds' in w) {
        if (!Number.isFinite(w.seconds)) throw new BadArgsError('seconds must be a number')
        const ms = Math.min(WAIT_MAX_MS, Math.max(0, w.seconds * 1000))
        return guarded(() => new Promise<string>((resolve) => {
          setTimeout(() => resolve(`waited ${ms / 1000} s`), ms)
        }))
      }
      assertAlive()
      const page = tab.page()
      let what: string
      let work: () => Promise<string>
      if ('text' in w) {
        what = `text '${w.text}'`
        work = () => page.getByText(w.text).first().waitFor({ state: 'visible', timeout: WAIT_MAX_MS }).then(() => `${what} appeared`)
      } else if ('textGone' in w) {
        what = `text '${w.textGone}' to disappear`
        work = () => page.getByText(w.textGone).first().waitFor({ state: 'hidden', timeout: WAIT_MAX_MS }).then(() => `text '${w.textGone}' is gone`)
      } else {
        what = `url '${w.url}'`
        work = () => page.waitForURL(w.url, { timeout: WAIT_MAX_MS }).then(() => `url matched '${w.url}'`)
      }
      try {
        return await guarded(work, () => { throw new DialogPendingError() })
      } catch (err) {
        if (isTimeout(err)) throw new Error(`timed out after ${WAIT_MAX_MS / 1000} s waiting for ${what}`)
        throw err
      }
    },

    async screenshot(fullPage) {
      begin()
      assertNoDialog()
      assertAlive()
      return guarded(
        () => tab.page().screenshot({ type: 'png', fullPage: !!fullPage, timeout: SCREENSHOT_TIMEOUT_MS }),
        () => { throw new DialogPendingError() },
      )
    },

    console() {
      begin()
      return tab.consoleMessages().slice(-CONSOLE_LIMIT)
    },

    async close() {
      // Fechar uma aba já fechada é no-op; com diálogo pendente fecha também
      // (fechar o contexto não fica preso atrás do diálogo).
      tab.lastAgentAt = now()
      if (tab.closedReason()) return
      tab.baton.beginAgent()
      try {
        await o.closeTab('closed_by_agent')
      } finally {
        tab.baton.endAgent()
      }
    },
  }
}
