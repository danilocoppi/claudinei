import { useTranslation } from 'react-i18next'
import { fileContentUrl } from '../files'
import { useStore } from '../store'
import { FileBody } from './FileViewerModal'

/**
 * Painel de arquivo INLINE: dockado entre o chat e o input, fica visível
 * enquanto o operador continua mandando comandos (diferente do popup, que
 * cobre tudo). Escopado por sessão — trocar de terminal esconde, voltar
 * mostra de novo; o ✕ fecha de vez.
 */
export function InlineFileView({ localId }: { localId: string }) {
  const { t } = useTranslation()
  const inlineFile = useStore((s) => s.inlineFile)
  const closeFileInline = useStore((s) => s.closeFileInline)

  if (!inlineFile || inlineFile.localId !== localId) return null
  const { path, kind, projectId } = inlineFile
  const url = fileContentUrl(path, projectId)
  const name = path.split('/').pop() || path

  return (
    <div className="inline-file" data-testid="inline-file-view">
      <div className="inline-file__header">
        <span className="inline-file__name">{name}</span>
        <span className="inline-file__path">{path}</span>
        <button
          type="button" className="ghost inline-file__close"
          aria-label={t('fileViewer.close')} title={t('fileViewer.close')}
          onClick={closeFileInline}
        >
          ✕
        </button>
      </div>
      <div className="inline-file__body">
        <FileBody kind={kind} url={url} name={name} compact />
      </div>
    </div>
  )
}
