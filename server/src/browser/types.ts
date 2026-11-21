// Tipos e textos internos do navegador embutido (projeto 16). O projeto 15 usa
// só o que `host.ts` exporta; estes nomes são da aba do terminal e do dublê.
import type { Browser } from 'playwright-core'

/** Um terminal: o projeto e o motor (cada terminal tem a sua aba). */
export interface TerminalKey { projectId: number; engine: string }

export const keyOf = (k: TerminalKey): string => `${k.projectId}:${k.engine}`

/** A costura do launch: o padrão carrega o playwright-core; os testes passam o dublê. */
export type LaunchFn = (o: { executablePath: string; chromiumSandbox: boolean; env: NodeJS.ProcessEnv }) => Promise<Browser>

/** Uma mensagem do console da página (ou erro dela, com type 'pageerror'). */
export interface ConsoleEntry { type: string; text: string }        // 'log' | 'warning' | 'error' | 'pageerror' …

export type TabCloseReason = 'idle' | 'evicted' | 'closed_by_user' | 'closed_by_agent' | 'browser_closed' | 'shutdown'

/** Textos ao agente (inglês, verbatim das Global Constraints); ao operador vão pelo i18n. */
export const TEXTS = {
  OPERATOR_IN_CONTROL: "The operator is controlling the browser. Do not retry in a loop; read-only tools still work; ask the operator to click 'Return to agent' if you need it",
  STALE_REF: 'the page changed since your last snapshot; take a new browser_snapshot',
  NOT_INSTALLED: 'Browser not installed. On the server, run `npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell`',
  SCHEME_REFUSED: 'only http:, https: and about:blank URLs are allowed',
  TOO_MANY_TABS: 'too many browsers open',
  DIALOG_PENDING: 'a dialog is pending; answer it with browser_act action=dialog accept=true|false',
  SNAPSHOT_CUT: '\n[snapshot cut at 60000 characters; call browser_snapshot with a smaller depth]',
} as const

/** A nona aba com as oito visíveis (nenhuma pode sair para dar lugar). */
export class TooManyTabsError extends Error {
  readonly code = 'too_many_tabs' as const
  constructor() {
    super(TEXTS.TOO_MANY_TABS)
    this.name = 'TooManyTabsError'
  }
}
