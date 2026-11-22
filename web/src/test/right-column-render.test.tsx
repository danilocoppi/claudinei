import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'

/**
 * O custo de redesenho da coluna da direita (frontend sem GPU): arrastar o
 * puxador muda só a largura, sem redesenhar a vista; e o ChatView, que assina a
 * classe do `.chat-layout`, só redesenha quando a classe muda.
 */

const desenhos = vi.hoisted(() => ({ progress: 0 }))
vi.mock('../components/ProgressColumn', () => ({
  ProgressColumn: () => { desenhos.progress++; return <aside className="progress" /> },
}))

import { RightColumn } from '../browser/RightColumn'
import { useChatLayoutClass, useColumnStore } from '../browser/columnStore'
import { useBrowserStore } from '../browser/browserStore'
import { useSideStore } from '../branch/sideStore'
import type { SideInfo } from '../branch/api'
import { useStore } from '../store'

const lateral: SideInfo = {
  id: 'side-1', projectId: 1, engine: 'claude', status: 'idle', mode: 'native', cutAt: null,
  files: 'no_edit_tools', question: null, openedAt: '2026-11-21T12:00:00Z',
}

beforeEach(() => {
  localStorage.clear()
  desenhos.progress = 0
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null, readAt: {} })
  useBrowserStore.setState({ tabs: {}, failed: {} })
  useColumnStore.setState({ view: 'progress', previous: null, fullscreen: false, marks: {}, widths: {} })
  useStore.setState({
    authStatus: 'ready', progressEpoch: 0, progressOpen: true, view: 'chat', activeLocalId: 'a',
    sessions: { a: { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** O React escuta `pointerdown`/`pointermove` pelo nome; o jsdom não tem PointerEvent. */
const ponteiro = (alvo: EventTarget, tipo: string, clientX: number) =>
  act(() => { alvo.dispatchEvent(new MouseEvent(tipo, { clientX, bubbles: true })) })

describe('redesenho da coluna da direita', () => {
  it('arrastar o puxador muda a largura sem redesenhar a vista', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-layout') ? 1200 : 0
    })
    render(<div className="chat-layout"><RightColumn projectId={1} engine="claude" localId="a" /></div>)
    const coluna = document.querySelector<HTMLElement>('aside.right-column')!
    const antes = desenhos.progress
    expect(antes).toBeGreaterThan(0)
    ponteiro(screen.getByRole('separator'), 'pointerdown', 800)
    ponteiro(window, 'pointermove', 790)
    ponteiro(window, 'pointermove', 780)
    ponteiro(window, 'pointermove', 770)
    expect(coluna.style.width).toBe('370px')
    expect(desenhos.progress).toBe(antes)
    ponteiro(window, 'pointerup', 770)
    expect(desenhos.progress).toBe(antes)
  })

  it('a classe do .chat-layout só redesenha quem a usa quando muda', () => {
    let renders = 0
    const { result } = renderHook(() => { renders++; return useChatLayoutClass(1, 'claude') })
    expect(result.current).toBe('chat-layout')
    const base = renders
    // Trocar de vista, a lateral nascer, a aba abrir, fechar e abrir a coluna: a classe não muda.
    act(() => { useBrowserStore.setState({ tabs: { '1:claude': true } }) })
    act(() => { useColumnStore.getState().selectView('browser') })
    act(() => { useSideStore.setState({ sides: { '1:claude': { info: lateral, items: [] } } }) })
    act(() => { useColumnStore.getState().selectView('side') })
    act(() => { useColumnStore.getState().closeColumn() })
    act(() => { useColumnStore.getState().selectView('progress') })
    act(() => { useStore.setState({ zen: true }) })
    expect(renders).toBe(base)
    expect(result.current).toBe('chat-layout')
    // A tela cheia muda a classe: um redesenho.
    act(() => { useColumnStore.getState().toggleFullscreen() })
    expect(result.current).toBe('chat-layout chat-layout--column-full chat-layout--full-progress')
    expect(renders).toBe(base + 1)
    act(() => { useColumnStore.getState().selectView('browser') })
    expect(result.current).toBe('chat-layout chat-layout--column-full chat-layout--full-browser')
    expect(renders).toBe(base + 2)
  })
})
