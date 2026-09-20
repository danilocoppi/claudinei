import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileKind } from '../files'
import { fetchTextFile, langOfPath, saveFileContent } from '../files'
import { useStore } from '../store'
import { CodeEditor, type EditorLang } from './CodeEditor'
import { RenderedText } from './RenderedText'

type Carga =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'ok'; text: string; hash: string | null }

/** A linguagem do editor a partir da extensão — o resto cai em texto puro. */
function editorLang(kind: FileKind, name: string): EditorLang {
  if (kind === 'markdown') return 'markdown'
  const lang = langOfPath(name)
  if (lang === 'html') return 'html'
  if (lang === 'js' || lang === 'ts' || lang === 'tsx' || lang === 'jsx') return 'javascript'
  return null
}

/**
 * Um documento de texto no visualizador: lê, mostra formatado e — quando é
 * editável — deixa editar e gravar.
 *
 * O lápis exige projeto E hash: sem projeto o servidor recusaria a gravação, e
 * sem o hash não há como provar qual versão foi lida, o que abriria espaço para
 * sobrescrever o agente às cegas. Em vez de oferecer um botão que falha depois,
 * ele não aparece.
 */
export function TextDocument({ kind, url, name, path, projectId, onSaved }: {
  kind: FileKind; url: string; name: string; path: string; projectId?: number; onSaved?: () => void
}) {
  const { t } = useTranslation()
  const setFileEditDirty = useStore((s) => s.setFileEditDirty)
  const [carga, setCarga] = useState<Carga>({ status: 'loading' })
  const [editando, setEditando] = useState(false)
  const [rascunho, setRascunho] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [sujo, setSujo] = useState(false)
  const [erro, setErro] = useState<'stale' | 'outro' | null>(null)
  const [salvando, setSalvando] = useState(false)
  const rascunhoRef = useRef('')
  rascunhoRef.current = rascunho

  const carregar = () => {
    setCarga({ status: 'loading' })
    return fetchTextFile(url).then((r) => {
      if (!r.ok) { setCarga({ status: 'error', code: r.code }); return }
      setCarga({ status: 'ok', text: r.text, hash: r.hash })
      setBase(r.hash)
      setRascunho(r.text)
      setSujo(false)
      setFileEditDirty(false)
      setErro(null)
    })
  }

  useEffect(() => { void carregar() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [url])
  // Sair da tela com edição pendente não pode deixar o aviso preso no store.
  useEffect(() => () => setFileEditDirty(false), [setFileEditDirty])

  const editavel = carga.status === 'ok' && !!projectId && !!base

  const mudou = (v: string) => {
    setRascunho(v)
    const diferente = carga.status === 'ok' && v !== carga.text
    setSujo(diferente)
    setFileEditDirty(diferente)
  }

  const salvar = () => {
    if (!projectId || !base || salvando) return
    setSalvando(true)
    setErro(null)
    const enviado = rascunhoRef.current
    saveFileContent({ path, projectId, content: enviado, baseHash: base })
      .then((r) => {
        setBase(r.hash)
        setCarga({ status: 'ok', text: enviado, hash: r.hash })
        setSujo(false)
        setFileEditDirty(false)
        onSaved?.()
      })
      .catch((e: Error) => setErro(e.message === 'stale' ? 'stale' : 'outro'))
      .finally(() => setSalvando(false))
  }

  if (carga.status === 'loading') return <div style={{ color: 'var(--text-dim)' }}>{t('fileViewer.loading')}</div>
  if (carga.status === 'error') {
    if (carga.code === 403) return <div style={{ color: 'var(--err)' }}>{t('fileViewer.forbidden')}</div>
    if (carga.code === 413) {
      return (
        <div style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
          <p>{t('fileViewer.tooLarge')}</p>
          <a href={url} download style={{ color: 'var(--accent)' }}>{t('fileViewer.download')}</a>
        </div>
      )
    }
    return <div style={{ color: 'var(--err)' }}>{t('fileViewer.notFound')}</div>
  }

  return (
    <div className="text-document">
      <div className="text-document__bar">
        {editando ? (
          <>
            {sujo && <span className="text-document__dot" title={t('fileViewer.unsaved')} />}
            <button type="button" className="ghost" disabled={!sujo || salvando} onClick={salvar}>
              {t('fileViewer.save')}
            </button>
            <button
              type="button" className="ghost"
              onClick={() => { setEditando(false); setRascunho(carga.text); setSujo(false); setFileEditDirty(false); setErro(null) }}
            >
              {t('fileViewer.stopEditing')}
            </button>
          </>
        ) : (
          editavel && (
            <button type="button" className="ghost" onClick={() => { setRascunho(carga.text); setEditando(true) }}>
              ✏️ {t('fileViewer.edit')}
            </button>
          )
        )}
      </div>

      {erro === 'stale' && (
        <div className="text-document__alert">
          {t('fileViewer.staleFile')}
          <button type="button" className="ghost" onClick={() => { void carregar() }}>{t('fileViewer.reload')}</button>
        </div>
      )}
      {erro === 'outro' && <div className="text-document__alert">{t('fileViewer.saveFailed')}</div>}

      {editando
        ? <CodeEditor value={rascunho} lang={editorLang(kind, name)} onChange={mudou} onSave={salvar} />
        : <RenderedText kind={kind} text={carga.text} name={name} />}
    </div>
  )
}
