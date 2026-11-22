// A entrada do operador pela tela do navegador: a validação das mensagens da web
// (`BrowserClientMsg`) e o mapeamento para o mouse e o teclado do Playwright.
// Clique, rolagem, tecla, texto, barra de endereço, histórico e diálogo tomam o
// bastão na hora; mover o mouse não toma, e só passa com o bastão de um operador,
// até 20 por segundo por socket. `visible`, `resize` e `freeze` são do socket
// (mexem nos espectadores), não da página: aqui não fazem nada.
import type { BrowserClientMsg } from '../../../shared/browser.js'
import type { Actor, TerminalTab } from './terminal-tab.js'
import { TEXTS } from './types.js'

/** Teto do `text` (colar e composição) e da resposta do `prompt`. */
const TEXT_MAX = 10_000
/** Teto da URL digitada na barra de endereço. */
const URL_MAX = 8_192
/** Teto do `key` e do `code` (o nome mais longo do Playwright tem bem menos). */
const KEY_MAX = 64
/** Coordenadas e deltas: px CSS do viewport (até 1920×1200), com folga para arrastar fora da tela. */
const COORD_MAX = 100_000
/** O `resize` chega em px CSS da coluna; o grampo de 320×240..1920×1200 é dos espectadores. */
const SIZE_MAX = 16_384
/** Movimentos de mouse por segundo, por socket. */
export const MOVES_PER_SECOND = 20
/** Teclas que o Playwright recusa ("Unknown key"): a web as manda na composição e em teclados mortos. */
const REFUSED_KEYS = new Set(['Unidentified', 'Dead', 'Process'])

const PHASES = new Set(['down', 'up', 'move'])
const BUTTONS = new Set(['left', 'middle', 'right'])
const HISTORY = new Set(['back', 'forward', 'reload'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_MAX
const size = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= SIZE_MAX
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
/** Modificador: ausente conta como solto; presente tem de ser booleano. */
const flag = (v: unknown): boolean | null => (v === undefined ? false : typeof v === 'boolean' ? v : null)

/** A mensagem da web validada (tipos e faixas), só com os campos conhecidos; inválida → null. */
export function parseClientMessage(raw: string): BrowserClientMsg | null {
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (!isObj(m) || typeof m.type !== 'string') return null
  switch (m.type) {
    case 'visible':
      return typeof m.visible === 'boolean' ? { type: 'visible', visible: m.visible } : null
    case 'resize':
      return size(m.width) && size(m.height) ? { type: 'resize', width: m.width, height: m.height } : null
    case 'pointer': {
      if (typeof m.phase !== 'string' || !PHASES.has(m.phase)) return null
      if (!coord(m.x) || !coord(m.y)) return null
      if (typeof m.button !== 'string' || !BUTTONS.has(m.button)) return null
      const out: Extract<BrowserClientMsg, { type: 'pointer' }> = {
        type: 'pointer', phase: m.phase as 'down' | 'up' | 'move', x: m.x, y: m.y, button: m.button as 'left' | 'middle' | 'right',
      }
      if (m.clickCount !== undefined) {
        if (!Number.isInteger(m.clickCount) || (m.clickCount as number) < 1 || (m.clickCount as number) > 4) return null
        out.clickCount = m.clickCount as number
      }
      return out
    }
    case 'wheel':
      return coord(m.x) && coord(m.y) && coord(m.dx) && coord(m.dy) ? { type: 'wheel', x: m.x, y: m.y, dx: m.dx, dy: m.dy } : null
    case 'key': {
      if (m.phase !== 'down' && m.phase !== 'up') return null
      if (!str(m.key, KEY_MAX) || m.key === '' || !str(m.code ?? '', KEY_MAX)) return null
      const alt = flag(m.alt), ctrl = flag(m.ctrl), meta = flag(m.meta), shift = flag(m.shift)
      if (alt === null || ctrl === null || meta === null || shift === null) return null
      return { type: 'key', phase: m.phase, key: m.key, code: (m.code as string | undefined) ?? '', alt, ctrl, meta, shift }
    }
    case 'text':
      return str(m.text, TEXT_MAX) && m.text !== '' ? { type: 'text', text: m.text } : null
    case 'navigate':
      return str(m.url, URL_MAX) && m.url.trim() !== '' ? { type: 'navigate', url: m.url } : null
    case 'history':
      return typeof m.action === 'string' && HISTORY.has(m.action) ? { type: 'history', action: m.action as 'back' | 'forward' | 'reload' } : null
    case 'take':
      return { type: 'take' }
    case 'release':
      return { type: 'release' }
    case 'dialog': {
      if (typeof m.accept !== 'boolean') return null
      if (m.text === undefined) return { type: 'dialog', accept: m.accept }
      return str(m.text, TEXT_MAX) ? { type: 'dialog', accept: m.accept, text: m.text } : null
    }
    case 'freeze':
      return typeof m.on === 'boolean' ? { type: 'freeze', on: m.on } : null
    default:
      return null
  }
}

/**
 * O limite dos movimentos do mouse de um socket: no máximo 20 em qualquer janela
 * de 1 s (aguenta a variação do ritmo da web sem passar do teto). Devolve
 * `true` e conta quando o movimento pode passar.
 */
export function createMoveLimiter(now: () => number = Date.now, perSecond = MOVES_PER_SECOND): () => boolean {
  const stamps: number[] = []
  return () => {
    const t = now()
    while (stamps.length && t - stamps[0] >= 1000) stamps.shift()
    if (stamps.length >= perSecond) return false
    stamps.push(t)
    return true
  }
}

/**
 * Aplica uma mensagem do operador à aba. Pode lançar (página travada ou fechada,
 * tecla que o Playwright não conhece): quem chama (o socket) trata. O esquema
 * recusado na barra de endereço não lança: vira aviso na coluna.
 */
export async function applyInput(tab: TerminalTab, msg: BrowserClientMsg, actor: Actor, o: { canMove: () => boolean }): Promise<void> {
  // O ator do socket é sempre operador; o agente não passa por aqui.
  if (actor.kind !== 'operator') return
  const who = { userId: actor.userId, name: actor.name }
  const take = () => tab.baton.operatorAct(who)
  switch (msg.type) {
    case 'pointer': {
      const page = tab.page()
      if (msg.phase === 'move') {
        // Mover não toma o bastão: só passa com um operador no comando (este ou outro).
        if (tab.baton.state().kind !== 'operator' || !o.canMove()) return
        await page.mouse.move(msg.x, msg.y)
        return
      }
      take()
      await page.mouse.move(msg.x, msg.y)
      const opts = { button: msg.button, clickCount: msg.clickCount ?? 1 }
      if (msg.phase === 'down') await page.mouse.down(opts)
      else await page.mouse.up(opts)
      return
    }
    case 'wheel': {
      take()
      const page = tab.page()
      await page.mouse.move(msg.x, msg.y)
      await page.mouse.wheel(msg.dx, msg.dy)
      return
    }
    case 'key': {
      if (REFUSED_KEYS.has(msg.key)) return
      take()
      if (msg.phase === 'down') await tab.page().keyboard.down(msg.key)
      else await tab.page().keyboard.up(msg.key)
      return
    }
    case 'text':
      take()
      await tab.page().keyboard.insertText(msg.text)
      return
    case 'navigate':
      take()
      try {
        await tab.navigate(msg.url)
      } catch (err) {
        // Recusado pela política: o aviso vai à coluna (não ao agente: foi o operador).
        if (err instanceof Error && err.message === TEXTS.SCHEME_REFUSED) { tab.pushNotice(TEXTS.SCHEME_REFUSED, false); return }
        throw err
      }
      return
    case 'history':
      take()
      await tab.history(msg.action)
      return
    case 'take':
      take()
      return
    case 'release':
      tab.baton.release()
      return
    case 'dialog':
      take()
      tab.answerDialog(msg.accept, msg.text)
      return
    default:
      // visible, resize e freeze: do socket.
      return
  }
}
