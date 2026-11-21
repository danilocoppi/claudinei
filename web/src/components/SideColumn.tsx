import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { progressKey, useStore } from '../store'
import { uploadFile } from '../api'
import { dotClassOf } from '../engineSession'
import type { SessionInfo } from '../types'
import { closeSide, interruptSide, openSide, sendSide } from '../branch/api'
import { dropSide, setSideInfo, useSideStore, type SideView } from '../branch/sideStore'
import { bringBack, lastAnswer } from '../branch/bringBack'
import { isSendKey } from '../shortcuts/active'
import { MessageBlock } from './MessageBlock'
import { EngineIcon } from './EngineIcon'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * A conversa lateral (`/side`, `/btw`) do terminal (projeto + motor), na coluna
 * à direita do chat, no lugar da do acompanhamento enquanto ela existe. Uma
 * cópia da conversa principal até o corte, para perguntar sem mexer nela.
 *
 * Sem GPU: nada de rostinho nem de animação; o ponto de status é estático (o
 * CSS tira o pulso do `status-working` dentro da coluna).
 */

const dois = (n: number) => String(n).padStart(2, '0')
/** HH:MM na hora local; vazio se a data não for legível. Também o "cópia até" do ramo no cabeçalho do chat. */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${dois(d.getHours())}:${dois(d.getMinutes())}`
}

/** Token inline do anexo no campo, trocado pelo caminho no envio (como no campo da principal). */
const token = (name: string) => `[📎 ${name}]`
/** Folga, em px, para ainda contar como "no fim" da conversa. */
const BOTTOM_SLACK = 40

type Props = {
  projectId: number
  engine: string
  /** A sessão da conversa principal: links da conversa e o campo que recebe o Trazer de volta. */
  localId: string
}

/** A coluna, só enquanto a lateral do terminal existe no store (assinada aqui, não no ChatView). */
export function SideColumn(props: Props) {
  const side = useSideStore((s) => s.sides[progressKey(props.projectId, props.engine)])
  return side ? <SideColumnView {...props} side={side} /> : null
}

function SideColumnView({ projectId, engine, localId, side }: Props & { side: SideView }) {
  const { t } = useTranslation()
  const { info, items } = side
  const meta = useStore((s) => s.engines.find((e) => e.id === engine))
  const ask = useSideStore((s) => (s.replaceAsk?.projectId === projectId && s.replaceAsk.engine === engine ? s.replaceAsk : null))
  const [text, setText] = useState('')
  const attachments = useRef(new Map<string, string>())
  const [uploading, setUploading] = useState(0)
  const [sending, setSending] = useState(false)
  /** Trazer de volta em curso (o upload da resposta longa): o botão fica desligado até terminar. */
  const [bringing, setBringing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const working = info.status === 'working'
  // Motor sem entrada no meio do turno (Kimi, OpenCode): a lateral não tem fila, o campo espera.
  const fieldDisabled = working && !meta?.midTurnInput
  const answer = useMemo(() => lastAnswer(items), [items])
  const cut = info.cutAt ? hhmm(info.cutAt) : ''

  // A conversa acompanha o fim enquanto o operador não rolou para cima. Sem rolagem suave (sem GPU).
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [items])

  const close = () => {
    setConfirmClose(false)
    closeSide(projectId, engine)
      .then(() => dropSide(projectId, engine, info.id))
      .catch((err: Error & { code?: string }) => {
        // Já não havia lateral no servidor: a coluna só estava atrasada.
        if (err.code === 'side_not_found') dropSide(projectId, engine, info.id)
        else setError(err.message)
      })
  }

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || fieldDisabled || sending || uploading > 0) return
    let out = trimmed
    for (const [tok, path] of attachments.current) out = out.split(tok).join(path)
    setSending(true)
    setError(null)
    try {
      await sendSide(projectId, engine, out)
      setText('')
      attachments.current.clear()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const stop = () => {
    interruptSide(projectId, engine).catch((err: Error & { code?: string }) => {
      if (err.code !== 'side_not_found') setError(err.message)
    })
  }

  const attach = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1)
      try {
        const saved = await uploadFile(file)
        const tok = token(saved.name)
        attachments.current.set(tok, saved.path)
        setText((cur) => (cur && !/\s$/.test(cur) ? `${cur} ${tok}` : `${cur}${tok}`))
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const replace = () => {
    if (!ask) return
    useSideStore.setState({ replaceAsk: null })
    openSide(projectId, engine, ask.text.trim() ? ask.text : undefined, true)
      .then((opened) => {
        // O `side_state` da nova costuma chegar antes da resposta, e é mais novo que ela.
        if (useSideStore.getState().sides[progressKey(projectId, engine)]?.info.id !== opened.id) setSideInfo(opened)
      })
      .catch((err: Error) => setError(err.message))
  }

  return (
    <aside className="side-col" aria-label={t('branch.side.title')}>
      <header className="side-col__head">
        <div className="side-col__row">
          <span className={dotClassOf({ status: info.status } as SessionInfo)} role="img"
                aria-label={t(`status.${info.status}`)} title={t(`status.${info.status}`)} />
          <strong>{t('branch.side.title')}</strong>
          <span className="side-col__engine">
            {meta && <EngineIcon icon={meta.icon} />}
            <span>{meta?.label ?? engine}</span>
          </span>
          <button className="ghost side-col__close" aria-label={t('branch.side.close')} title={t('branch.side.close')}
                  onClick={() => (working ? setConfirmClose(true) : close())}>×</button>
        </div>
        <div className="side-col__meta">
          {info.mode === 'seed'
            ? <span>{t('branch.side.seedMode')}</span>
            : cut && <span>{t('branch.side.copyUntil', { time: cut })}</span>}
          <span className={`side-col__files side-col__files--${info.files}`}>{t(`branch.files.${info.files}`)}</span>
        </div>
      </header>
      <div className="side-col__body" ref={bodyRef}
           onScroll={(e) => {
             const el = e.currentTarget
             atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
           }}>
        {items.length === 0
          ? <p className="side-col__empty">{t('branch.side.empty')}</p>
          : items.map((it, i) => (
              <div className="chat-entry" key={it.key ?? i}>
                <MessageBlock item={it} currentLocalId={localId} editable={false} />
              </div>
            ))}
      </div>
      {error && <p className="side-col__error" role="alert">{error}</p>}
      <footer className="side-col__foot">
        <textarea className="side-col__area" rows={2} value={text}
                  placeholder={t('branch.side.placeholder')} disabled={fieldDisabled}
                  onChange={(e) => setText(e.target.value)}
                  onPaste={(e) => {
                    const files = e.clipboardData?.files
                    if (files && files.length) { e.preventDefault(); void attach(files) }
                  }}
                  onKeyDown={(e) => {
                    // A mesma regra do campo principal: a composição do IME fica com
                    // ela; Enter puro ou a combinação de enviar enviam; Shift+Enter quebra a linha.
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (isSendKey(e)) { e.preventDefault(); void send() }
                  }} />
        <div className="side-col__actions">
          <input ref={fileRef} type="file" multiple hidden data-testid="side-attach-input"
                 onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = '' }} />
          <button className="ghost" aria-label={t('branch.side.attach')} title={t('branch.side.attach')}
                  disabled={fieldDisabled} onClick={() => fileRef.current?.click()}>📎</button>
          {working && <button className="ghost" onClick={stop}>{t('branch.side.stop')}</button>}
          <button className="ghost side-col__bring" title={t('branch.side.bringBackTitle')}
                  disabled={working || !answer || bringing}
                  onClick={() => {
                    if (bringing) return
                    setError(null)
                    setBringing(true)
                    bringBack(localId, items)
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setBringing(false))
                  }}>
            {t('branch.side.bringBack')}
          </button>
          <button className="side-col__send" disabled={fieldDisabled || sending || uploading > 0 || !text.trim()}
                  onClick={() => void send()}>{t('common.send')}</button>
        </div>
      </footer>
      {confirmClose && (
        <ConfirmDialog title={t('branch.side.closeWorkingTitle')} message={t('branch.side.closeWorkingMsg')}
                       confirmLabel={t('branch.side.closeConfirm')} onConfirm={close} onClose={() => setConfirmClose(false)} />
      )}
      {ask && (
        <ConfirmDialog title={t('branch.side.replaceTitle')} message={t('branch.side.replaceMsg')}
                       confirmLabel={t('branch.side.replaceConfirm')} onConfirm={replace}
                       onClose={() => useSideStore.setState({ replaceAsk: null })} />
      )}
    </aside>
  )
}
