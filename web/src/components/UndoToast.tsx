import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { isForeignField } from '../keyboard'
import { undoTriage } from '../triageActions'

/**
 * O aviso da última ação de triagem ("Alpha assentado · Desfazer") e o `Ctrl+Z`
 * (ou `Cmd+Z`) que faz o mesmo que o botão, enquanto a ação é desfazível (5 s;
 * o prazo mora em `triageActions.ts`). No celular, sem teclado, o botão é a porta.
 *
 * O atalho é de quem tem o foco: num campo (o chat, a busca, a textarea do
 * terminal, um modal) o `Ctrl+Z` desfaz o texto, não a triagem. Um listener só,
 * montado com o App, que sem desfazer pendente sai na primeira linha.
 *
 * Estático, sem animação nem transição: a interface precisa andar sem GPU.
 */
export function UndoToast() {
  const { t } = useTranslation()
  const undo = useStore((s) => s.undo)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      const u = useStore.getState().undo
      if (!u || Date.now() >= u.expiresAt || e.defaultPrevented || isForeignField(e.target, null)) return
      e.preventDefault()
      void undoTriage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!undo) return null
  return (
    <div className="undo-toast" role="status" data-testid="undo-toast">
      <span className="undo-toast__label">{undo.label}</span>
      <button type="button" className="undo-toast__btn" onClick={() => void undoTriage()}>{t('triage.undo')}</button>
    </div>
  )
}
