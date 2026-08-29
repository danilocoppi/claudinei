import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { createAction, updateAction, type Action } from '../api'

/**
 * Cadastro de uma ação: um nome e os comandos que ele dispara.
 *
 * Os comandos vêm de um campo de texto, um por linha, e não de uma lista com
 * botão "+ adicionar": quem tem a sequência pronta cola as três linhas de uma vez,
 * e quem está montando digita Enter. Uma lista de campos custaria um clique por
 * comando para não ganhar nada.
 */
export function ActionEditor({ projectId, action, onSaved, onClose }: {
  projectId: number
  /** Ausente = está criando. */
  action?: Action
  onSaved: (a: Action) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(action?.name ?? '')
  const [text, setText] = useState((action?.commands ?? []).join('\n'))
  const [autoClose, setAutoClose] = useState(action?.autoClose ?? false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const commands = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const podeSalvar = !!name.trim() && commands.length > 0 && !saving

  const salvar = async () => {
    if (!podeSalvar) return
    setSaving(true)
    setError('')
    try {
      const input = { name: name.trim(), commands, autoClose }
      onSaved(action ? await updateAction(action.id, input) : await createAction(projectId, input))
    } catch (err) {
      // Mostrado, e não engolido: o servidor recusa nome vazio e comando vazio, e
      // um formulário que fecha sem salvar é pior que um que reclama.
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass acted" data-testid="action-editor" onClick={(e) => e.stopPropagation()}>
        <h3 className="acted__title">{action ? t('actions.editTitle') : t('actions.newTitle')}</h3>

        <label className="acted__label">
          <span>{t('actions.name')}</span>
          <input
            autoFocus
            value={name}
            placeholder={t('actions.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="acted__label">
          <span>{t('actions.commands')}</span>
          <textarea
            rows={5}
            value={text}
            spellCheck={false}
            placeholder={t('actions.commandsPlaceholder')}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {/* Que rodam no MESMO shell e em sequência é o detalhe que faz o exemplo
            que originou esta tela funcionar: `awsVAEXA` só vale para o `npm run
            deploy` da linha seguinte se os dois forem o mesmo processo. */}
        <p className="acted__hint">{t('actions.commandsHint')}</p>

        <label className="acted__check">
          <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} />
          <span>{t('actions.autoClose')}</span>
        </label>
        {error && <p className="acted__err">{error}</p>}

        <div className="acted__foot">
          <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!podeSalvar} onClick={() => void salvar()}>{t('common.save')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
