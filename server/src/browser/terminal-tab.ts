// A aba de um terminal: um contexto isolado com uma página só. Versão mínima
// (contexto, página, uso e fechamento); a Task 4 amplia sem trocar estes nomes.
import type { BrowserContext, Page } from 'playwright-core'
import type { TabCloseReason, TerminalKey } from './types.js'

export interface TerminalTab {
  readonly key: TerminalKey
  readonly context: BrowserContext
  page(): Page
  /** Hora da última ferramenta do agente nesta aba (a varredura de ociosidade lê). */
  lastAgentAt: number
  /** Há coluna aberta e visível desta aba? A Task 9 liga aos espectadores; aqui: false. */
  isVisible(): boolean
  onClosed(fn: (reason: TabCloseReason) => void): () => void
  close(reason: TabCloseReason): Promise<void>
}

export function createTerminalTab(o: { key: TerminalKey; context: BrowserContext; page: Page; now: () => number }): TerminalTab {
  const listeners = new Set<(reason: TabCloseReason) => void>()
  let closed = false
  return {
    key: o.key,
    context: o.context,
    page: () => o.page,
    lastAgentAt: o.now(),
    isVisible: () => false,
    onClosed(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async close(reason) {
      if (closed) return
      closed = true
      // Avisa antes de fechar o contexto: quem tem uma ferramenta em curso nesta
      // aba fica sabendo do motivo antes de a operação do Playwright falhar.
      for (const fn of [...listeners]) {
        try { fn(reason) } catch { /* um ouvinte não impede os outros */ }
      }
      listeners.clear()
      await o.context.close().catch(() => { /* o Chromium já pode ter caído */ })
    },
  }
}
