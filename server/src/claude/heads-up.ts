/**
 * Avisos do plugin "You should know" do Claude CLI (cc-plugin-you-should-know).
 *
 * No terminal interativo o plugin desenha o aviso acima do campo de digitação.
 * Nos terminais do Claudinei (`claude -p` em stream-json) não há interface, e o
 * plugin só trabalha quando alguma superfície desenha o lugar dele. Por isso o
 * servidor anexa cada terminal do Claude como a superfície `desktop` (o mesmo
 * protocolo do app Desktop, marcado @internal no CLI 2.1.323): `ui_attach`, um
 * `ui_render` do componente AbovePrompt (instância `above-prompt`) a cada
 * `system/ui_invalidate`, e `ui_press` quando a pessoa clica num botão dele.
 *
 * A árvore que volta é dados simples (Box, Text, Button, Markdown, Link, Code…);
 * nós `engine` são o conteúdo do próprio CLI naquele lugar e saem — o que sobra
 * é o cartão do plugin. Sem cartão: null.
 */
export type HeadsUpNode = string | {
  type: string
  props?: Record<string, unknown>
  children?: HeadsUpNode[]
  press?: { plugin: string; handle: number }
  ref?: number
}

export interface HeadsUpPress { plugin: string; handle: number; key?: string }

/** O que a sessão do Claude oferece para isto (control_request com resposta). */
export interface HeadsUpSurface {
  uiAttach(): Promise<unknown>
  uiDetach(): Promise<unknown>
  uiRender(props: Record<string, unknown>): Promise<unknown>
  uiPress(press: HeadsUpPress): Promise<unknown>
}

/** Props do AbovePrompt como a superfície os tem; o plugin lê `isWorking` e `bodyColumns`. */
const ABOVE_PROMPT_PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 24, bodyColumns: 100 }

/** Tira os nós do motor; null quando não sobra nada do plugin. */
export function pluginCard(tree: unknown): HeadsUpNode | null {
  const strip = (node: unknown): HeadsUpNode | null => {
    if (typeof node === 'string') return node
    if (!node || typeof node !== 'object') return null
    const n = node as { type?: unknown; children?: unknown }
    if (typeof n.type !== 'string' || n.type === 'engine') return null
    const children = Array.isArray(n.children)
      ? n.children.map(strip).filter((c): c is HeadsUpNode => c !== null)
      : undefined
    return { ...(node as object), type: n.type, ...(children ? { children } : {}) } as HeadsUpNode
  }
  const card = strip(tree)
  return card !== null && hasContent(card) ? card : null
}

function hasContent(node: HeadsUpNode): boolean {
  if (typeof node === 'string') return node.trim() !== ''
  if (node.type !== 'Box' && node.type !== 'div' && node.type !== 'span') return true
  return (node.children ?? []).some(hasContent)
}

export function createHeadsUp(opts: {
  surface: HeadsUpSurface
  onChange: (card: HeadsUpNode | null) => void
  log?: (message: string) => void
}) {
  let card: HeadsUpNode | null = null
  let shown = 'null'
  let active = false
  let inFlight: Promise<void> | null = null
  let dirty = false

  const set = (next: HeadsUpNode | null) => {
    const key = JSON.stringify(next)
    if (key === shown) return
    shown = key
    card = next
    if (next) opts.log?.('aviso do plugin You should know chegou')
    opts.onChange(next)
  }

  async function render(): Promise<void> {
    do {
      dirty = false
      try {
        const res = await opts.surface.uiRender(ABOVE_PROMPT_PROPS) as { tree?: unknown } | undefined
        if (active) set(pluginCard(res?.tree))
      } catch {
        // Desenho que falhou (timeout, sessão ocupada): fica o aviso que estava.
      }
    } while (dirty && active)
  }

  return {
    async start(): Promise<void> {
      if (active) return
      active = true
      try { await opts.surface.uiAttach() } catch { active = false; return }
      inFlight = render().finally(() => { inFlight = null })
      await inFlight
    },
    /** `system/ui_invalidate`: o plugin mudou o que desenha. Coalesce enquanto há desenho em voo. */
    invalidate(): void {
      if (!active) return
      if (inFlight) { dirty = true; return }
      inFlight = render().finally(() => { inFlight = null })
    },
    async press(press: HeadsUpPress): Promise<void> {
      if (!active) return
      await opts.surface.uiPress(press)
    },
    async stop(): Promise<void> {
      if (!active) return
      active = false
      set(null)
      try { await opts.surface.uiDetach() } catch { /* a sessão pode já ter saído */ }
    },
    current: () => card,
  }
}
