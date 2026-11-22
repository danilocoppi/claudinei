import { useEffect } from 'react'
import { create } from 'zustand'
import { progressKey, useStore } from '../store'
import { fetchBrowserTabs } from './api'
import { activeTerminal, availFor, columnState, useColumnStore } from './columnStore'
import { effectiveView } from './columnModel'

/**
 * Quais terminais (projeto + motor, pela chave do acompanhamento) têm aba do
 * navegador embutido aberta. A aba vive no servidor; aqui só a presença, para
 * a coluna saber se mostra a vista Navegador. `failed`: a última tentativa do
 * operador de abrir a aba deu erro (sem Chromium, por exemplo), e a vista
 * mostra o porquê até a aba existir, o operador sair da vista (ou fechar a
 * coluna), tentar de novo ou o WebSocket reconectar.
 */
export interface BrowserFailure {
  /** O código do servidor (`browser_not_installed`, `launch_failed`, `too_many_tabs`…), quando veio. */
  code?: string
  /** O texto do servidor: o detalhe, que a vista mostra sob a mensagem do i18n. */
  message: string
  /** O comando de instalação (ou a correção da variável), quando há. */
  hint?: string
}

interface BrowserState {
  tabs: Record<string, true>
  failed: Record<string, BrowserFailure>
}

export const useBrowserStore = create<BrowserState>(() => ({ tabs: {}, failed: {} }))

/** Chaves que o WebSocket mudou enquanto uma leitura de `/api/browser/tabs` estava a caminho: o WebSocket é mais novo. */
let touched: Set<string> | null = null

export function setBrowserTab(key: string, open: boolean): void {
  touched?.add(key)
  useBrowserStore.setState((s) => {
    const has = !!s.tabs[key]
    const failed = open && s.failed[key] ? withoutKey(s.failed, key) : s.failed
    if (has === open && failed === s.failed) return s
    return { tabs: open ? { ...s.tabs, [key]: true } : withoutKey(s.tabs, key), failed }
  })
}

export function setBrowserFailure(key: string, failure: BrowserFailure): void {
  touched?.add(key)
  useBrowserStore.setState((s) => ({ failed: { ...s.failed, [key]: failure } }))
}

export function clearBrowserFailure(key: string): void {
  useBrowserStore.setState((s) => (key in s.failed ? { failed: withoutKey(s.failed, key) } : s))
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const { [key]: _gone, ...rest } = rec
  return rest
}

/**
 * Os códigos de "falha" que não vêm de uma abertura recusada, e sim da aba que
 * fechou com a vista à mostra: `browser_closed` (o socket da tela disse que o
 * Chromium caiu) e `tab_closed` (o `browser_tab` chegou antes do motivo). Eles
 * seguram a vista Navegador até o operador reabrir ou sair dela.
 */
export const BROWSER_CLOSED = 'browser_closed'
export const TAB_CLOSED = 'tab_closed'
export const isClosedFailure = (f: BrowserFailure | undefined): boolean =>
  f?.code === BROWSER_CLOSED || f?.code === TAB_CLOSED

/** A vista Navegador do terminal `key` está à mostra (ele é o do chat à vista, com a coluna nela). */
function showingBrowser(key: string): boolean {
  const t = activeTerminal()
  if (!t || progressKey(t.projectId, t.engine) !== key) return false
  return effectiveView(columnState(key), availFor(key)) === 'browser'
}

/**
 * O `browser_tab` do WebSocket principal: a aba do terminal abriu ou fechou.
 * Aberta pelo agente no terminal à vista, a coluna vai ao Navegador (ou a aba
 * ganha a marca, com a Lateral à vista). Devolve true quando a mensagem era
 * dele (consumida), para o App não passá-la adiante.
 */
export function applyBrowserMessage(msg: any): boolean {
  if (!msg || typeof msg !== 'object' || msg.type !== 'browser_tab') return false
  if (typeof msg.projectId !== 'number' || typeof msg.engine !== 'string') return true
  const open = msg.open === true
  const key = progressKey(msg.projectId, msg.engine)
  // Fechada pelo sistema (o Chromium caiu, ociosidade, despejo) com a vista à
  // mostra: ela fica, à espera do último `state` do socket da tela, que diz o
  // motivo. Com `browser_closed` vira "O navegador fechou — Reabrir"; com outro
  // motivo a vista sai (BrowserColumn). Os dois sockets não têm ordem entre si.
  if (!open && msg.by === 'system' && !useBrowserStore.getState().failed[key] && showingBrowser(key)) {
    setBrowserFailure(key, { code: TAB_CLOSED, message: '' })
  }
  setBrowserTab(key, open)
  // A aba fechou: a marca dela, naquele terminal, vai junto.
  if (!open) useColumnStore.getState().unmark(key, 'browser')
  if (open && msg.by === 'agent') {
    const t = activeTerminal()
    if (t && t.projectId === msg.projectId && t.engine === msg.engine) useColumnStore.getState().agentOpened()
  }
  return true
}

/**
 * Lê as abas abertas ao montar e a cada reconexão (`progressEpoch`): o que o
 * WebSocket mandou durante a queda se perdeu. O que ele mandar durante a
 * leitura vence a resposta. Os erros de abertura antigos saem (o servidor pode
 * ter voltado com o Chromium), menos os que chegaram durante a leitura.
 */
export function useBrowserTabsSync(): void {
  const ready = useStore((s) => s.authStatus === 'ready')
  const epoch = useStore((s) => s.progressEpoch)
  useEffect(() => {
    if (!ready) return
    let alive = true
    const mine = new Set<string>()
    touched = mine
    fetchBrowserTabs()
      .then((r) => {
        if (!alive || !Array.isArray(r?.tabs)) return
        const cur = useBrowserStore.getState().tabs
        const tabs: Record<string, true> = {}
        for (const t of r.tabs) {
          if (typeof t?.projectId === 'number' && typeof t.engine === 'string') tabs[progressKey(t.projectId, t.engine)] = true
        }
        for (const key of mine) {
          if (cur[key]) tabs[key] = true
          else delete tabs[key]
        }
        const failed: Record<string, BrowserFailure> = {}
        for (const [key, f] of Object.entries(useBrowserStore.getState().failed)) if (mine.has(key)) failed[key] = f
        useBrowserStore.setState({ tabs, failed })
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
      .finally(() => { if (touched === mine) touched = null })
    return () => { alive = false; if (touched === mine) touched = null }
  }, [ready, epoch])
}
