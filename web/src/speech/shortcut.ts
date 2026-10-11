import { useEffect, useRef } from 'react'
import { isForeignField } from '../keyboard'

/** Segurar o atalho por pelo menos isto vira "segurar para falar"; menos é um toque. */
export const HOLD_MS = 400

/** Ctrl+Espaço, sem outro modificador. */
export function isMicShortcut(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.code === 'Space' || e.key === ' ')
}


export interface MicShortcutOptions {
  enabled: boolean
  /** Gravando ou abrindo o microfone agora. */
  active: () => boolean
  start: () => void
  /** Para a gravação — ou cancela a abertura do microfone ainda em curso. */
  stop: () => void
  field?: () => HTMLElement | null
  now?: () => number
}

/**
 * Ctrl+Espaço no microfone, no modo híbrido: um toque liga e a gravação segue
 * até o próximo atalho; segurar grava só enquanto as teclas estão apertadas.
 *
 * Quem decide entre os dois é a SOLTURA: o atalho sempre começa a gravar ao
 * descer, e ao subir mede quanto tempo ficou apertado. Soltar o Ctrl ou o
 * Espaço conta igual, e perder o foco da janela também — o navegador não avisa
 * a soltura que acontece fora dela.
 */
export function useMicShortcut(options: MicShortcutOptions): void {
  const opts = useRef(options)
  opts.current = options

  useEffect(() => {
    let pressedAt: number | null = null
    const now = () => (opts.current.now ?? Date.now)()

    const release = () => {
      if (pressedAt === null) return
      const held = now() - pressedAt
      pressedAt = null
      if (held >= HOLD_MS) opts.current.stop()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const o = opts.current
      if (!isMicShortcut(e) || e.isComposing || !o.enabled) return
      if (isForeignField(e.target, o.field?.() ?? null)) return
      // O espaço não é digitado nem rola a página — inclusive nas repetições.
      e.preventDefault()
      if (e.repeat || pressedAt !== null) return
      if (o.active()) { o.stop(); return }
      pressedAt = now()
      o.start()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Control') release()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
    }
  }, [])
}
