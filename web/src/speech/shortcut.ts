import { useEffect, useRef } from 'react'
import { inShortcutScope, matchShortcut, shortcutCombo } from '../shortcuts/active'
import { isComboRelease, isMac } from '../shortcuts/combo'
import { isForeignField } from '../keyboard'

/** Segurar o atalho por pelo menos isto vira "segurar para falar"; menos é um toque. */
export const HOLD_MS = 400

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
 * A combinação do microfone (`chat.voice` no registro; padrão Ctrl+Espaço), no
 * modo híbrido: um toque liga e a gravação segue até o próximo atalho; segurar
 * grava só enquanto as teclas estão apertadas. Sem atalho, nada acontece.
 *
 * Quem decide entre os dois é a SOLTURA: o atalho sempre começa a gravar ao
 * descer, e ao subir mede quanto tempo ficou apertado. Soltar a tecla principal
 * ou qualquer modificador da combinação conta igual, e perder o foco da janela
 * também — o navegador não avisa a soltura que acontece fora dela.
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
      if (!o.enabled || !matchShortcut(e, 'chat.voice')) return
      const field = o.field?.() ?? null
      // Num campo de texto alheio, a tecla continua do campo (Ctrl+Espaço é também
      // a troca de idioma do teclado): não liga, não para, não consome.
      if (isForeignField(e.target, field)) return
      // Fora do escopo daqui para baixo só por causa de um modal (no foco ou aberto
      // na página): o atalho não liga o microfone, mas ainda PARA a gravação em
      // curso — ela não fica presa porque um diálogo se abriu por cima.
      const noEscopo = inShortcutScope('chat.voice', e.target, field)
      // A tecla não é digitada (nem o espaço rola a página) — inclusive nas
      // repetições. Num modal também é consumida sem ligar nada: Ctrl+Espaço num
      // botão em foco gera clique, e quem quer o microfone não confirma o diálogo.
      e.preventDefault()
      if (e.repeat || pressedAt !== null) return
      if (o.active()) { o.stop(); return }
      if (!noEscopo) return
      pressedAt = now()
      o.start()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const combo = shortcutCombo('chat.voice')
      if (combo !== null && isComboRelease(e, combo, isMac())) release()
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
