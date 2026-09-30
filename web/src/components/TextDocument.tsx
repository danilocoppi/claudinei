import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileKind } from '../files'
import { fetchTextFile, langOfPath, saveFileContent } from '../files'
import { useStore } from '../store'
import { CodeEditor, type EditorLang } from './CodeEditor'
import { RenderedText } from './RenderedText'
import { HtmlVisualEditor } from './HtmlVisualEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { validHtmlFields } from '../../../shared/html-form'
import { saveHtmlFields } from '../editor/html-form'

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
export function TextDocument({ kind, url, name, path, projectId, onSaved, html }: {
  kind: FileKind; url: string; name: string; path: string; projectId?: number; onSaved?: () => void
  html?: { view: 'page' | 'source'; preview: ReactNode; baseUrl?: string; compact?: boolean
    channel?: string; frame?: RefObject<HTMLIFrameElement> }
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
  const [confirmando, setConfirmando] = useState(false)
  const generation = useRef(0)
  const saving = useRef(false)
  const rascunhoRef = useRef('')
  const formSession = useRef<{ channel: string; hash: string; initial: string } | null>(null)
  const pendingForm = useRef<MessageEvent[]>([])
  rascunhoRef.current = rascunho

  const carregar = () => {
    const request = ++generation.current
    setCarga({ status: 'loading' })
    return fetchTextFile(url).then((r) => {
      if (request !== generation.current) return
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
  useEffect(() => () => { generation.current++; setFileEditDirty(false) }, [setFileEditDirty])
  useEffect(() => {
    if (!sujo) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [sujo])

  const editavel = carga.status === 'ok' && !!projectId && !!base
    && (!html || html.view === 'source' || !!html.baseUrl)

  const mudou = (v: string) => {
    rascunhoRef.current = v
    setRascunho(v)
    const diferente = carga.status === 'ok' && v !== carga.text
    setSujo(diferente)
    setFileEditDirty(diferente)
  }

  useEffect(() => {
    const channel = html?.channel
    if (!channel || !html.frame) return
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (event.source !== html.frame?.current?.contentWindow || event.origin !== 'null'
        || data?.type !== 'claudinei:html-form' || data.channel !== channel
        || !['ready', 'change'].includes(data.kind) || typeof data.hash !== 'string'
        || !validHtmlFields(data.fields)) return
      if (editando) return
      if (carga.status !== 'ok') {
        // Initial source read may finish after the iframe's ready message.
        pendingForm.current = data.kind === 'ready' ? [event]
          : [...pendingForm.current.filter(item => item.data.kind === 'ready'), event]
        return
      }
      if (!projectId || !base) return
      const snapshot = JSON.stringify(data.fields)
      if (formSession.current?.channel !== channel) {
        if (data.hash !== base) { setErro('stale'); return }
        if (data.kind !== 'ready') return
        formSession.current = { channel, hash: data.hash, initial: snapshot }
      }
      if (data.hash !== formSession.current.hash || data.kind !== 'change') return
      const unchanged = snapshot === formSession.current.initial && base === formSession.current.hash
      mudou(unchanged ? carga.text : saveHtmlFields(carga.text, data.fields))
    }
    window.addEventListener('message', receive)
    const pending = pendingForm.current
    pendingForm.current = []
    for (const event of pending) receive(event)
    return () => window.removeEventListener('message', receive)
  }, [html?.channel, html?.frame, carga, base, projectId, editando])

  const salvar = () => {
    if (!projectId || !base || saving.current || carga.status !== 'ok' || rascunhoRef.current === carga.text) return
    saving.current = true
    const request = generation.current
    setSalvando(true)
    setErro(null)
    const enviado = rascunhoRef.current
    saveFileContent({ path, projectId, content: enviado, baseHash: base })
      .then((r) => {
        if (request !== generation.current) return
        setBase(r.hash)
        setCarga({ status: 'ok', text: enviado, hash: r.hash })
        const changedSinceSave = rascunhoRef.current !== enviado
        setSujo(changedSinceSave)
        setFileEditDirty(changedSinceSave)
        if (!changedSinceSave) onSaved?.()
      })
      .catch((e: Error) => { if (request === generation.current) setErro(e.message === 'stale' ? 'stale' : 'outro') })
      .finally(() => { saving.current = false; if (request === generation.current) setSalvando(false) })
  }

  const concluir = () => {
    if (html && sujo) onSaved?.()
    setEditando(false); setRascunho(carga.status === 'ok' ? carga.text : '')
    setSujo(false); setFileEditDirty(false); setErro(null); setConfirmando(false)
  }

  // A página continua legível quando o fonte excede o limite de edição/leitura.
  if (html?.view === 'page' && carga.status !== 'ok') {
    return <div className="text-document text-document--html">
      {carga.status === 'loading' && <div role="status">{t('fileViewer.loading')}</div>}
      {carga.status === 'error' && <div className="text-document__alert" role="alert">
        {t(carga.code === 403 ? 'fileViewer.forbidden' : carga.code === 413 ? 'fileViewer.tooLarge' : 'fileViewer.notFound')}
        <button type="button" className="ghost" onClick={() => { void carregar() }}>{t('fileViewer.reload')}</button>
      </div>}
      <div className="html-view__page">{html.preview}</div>
    </div>
  }
  if (carga.status === 'loading') return <div role="status" style={{ color: 'var(--text-dim)' }}>{t('fileViewer.loading')}</div>
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
    <div className={`text-document${html ? ' text-document--html' : ''}`}>
      <div className="text-document__bar">
        {(editando || sujo) && (
          <>
            {sujo && <span className="text-document__dot" title={t('fileViewer.unsaved')} />}
            <button type="button" className="ghost" disabled={!sujo || salvando} aria-busy={salvando} onClick={salvar}>
              {t('fileViewer.save')}
            </button>
          </>
        )}
        {editando ? (
            <button
              type="button" className="ghost" disabled={salvando}
              onClick={() => { if (sujo) setConfirmando(true); else concluir() }}
            >
              {t('fileViewer.stopEditing')}
            </button>
        ) : (
          editavel && (
            <button type="button" className="ghost" onClick={() => { if (!sujo) setRascunho(carga.text); setEditando(true) }}>
              ✏️ {t('fileViewer.edit')}
            </button>
          )
        )}
      </div>

      {erro === 'stale' && (
        <div className="text-document__alert" role="alert">
          {t('fileViewer.staleFile')}
          <button type="button" className="ghost" onClick={() => { void carregar().then(() => onSaved?.()) }}>{t('fileViewer.reload')}</button>
        </div>
      )}
      {erro === 'outro' && <div className="text-document__alert" role="alert">{t('fileViewer.saveFailed')}</div>}

      {html && <div className="html-view__page" hidden={html.view !== 'page' || editando}>{html.preview}</div>}
      {html?.view === 'page'
        ? editando && <HtmlVisualEditor value={rascunho} baseUrl={html.baseUrl} name={name} compact={html.compact} onChange={mudou} onSave={salvar} />
        : editando
        ? <CodeEditor value={rascunho} lang={editorLang(kind, name)} onChange={mudou} onSave={salvar} />
        : <RenderedText kind={kind} text={html ? rascunho : carga.text} name={name} />}
      {confirmando && <ConfirmDialog title={t('fileViewer.discardTitle')} message={t('fileViewer.discardBody')}
        confirmLabel={t('fileViewer.discard')} onConfirm={concluir} onClose={() => setConfirmando(false)} />}
    </div>
  )
}
