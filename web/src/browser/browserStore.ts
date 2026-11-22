import { useEffect } from 'react'
import { create } from 'zustand'
import { progressKey, useStore } from '../store'
import { fetchBrowserTabs } from './api'
import { activeTerminal, useColumnStore } from './columnStore'

/**
 * Quais terminais (projeto + motor, pela chave do acompanhamento) têm aba do
 * navegador embutido aberta. A aba vive no servidor; aqui só a presença, para
 * a coluna saber se mostra a vista Navegador. `failed`: a última tentativa do
 * operador de abrir a aba deu erro (sem Chromium, por exemplo), e a vista
 * mostra o porquê até a aba existir.
 */
export interface BrowserFailure { message: string; hint?: string }

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
  useBrowserStore.setState((s) => ({ failed: { ...s.failed, [key]: failure } }))
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const { [key]: _gone, ...rest } = rec
  return rest
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
  setBrowserTab(progressKey(msg.projectId, msg.engine), open)
  if (open && msg.by === 'agent') {
    const t = activeTerminal()
    if (t && t.projectId === msg.projectId && t.engine === msg.engine) useColumnStore.getState().agentOpened()
  }
  return true
}

/**
 * Lê as abas abertas ao montar e a cada reconexão (`progressEpoch`): o que o
 * WebSocket mandou durante a queda se perdeu. O que ele mandar durante a
 * leitura vence a resposta.
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
        useBrowserStore.setState({ tabs })
      })
      .catch(() => { /* fica o que já havia: o WebSocket continua atualizando */ })
      .finally(() => { if (touched === mine) touched = null })
    return () => { alive = false; if (touched === mine) touched = null }
  }, [ready, epoch])
}
