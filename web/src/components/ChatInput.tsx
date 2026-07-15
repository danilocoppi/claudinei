import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WsContext } from '../wsContext'
import { useStore, useEngineFor, useSessionSlashCommands } from '../store'
import { uploadFile } from '../api'
import { SessionControls } from './SessionControls'
import { filterCommands } from '../slash'
import { SlashMenu } from './SlashMenu'
import { MicButton, type MicDeps } from './MicButton'
import { mergeTranscript } from '../speech/insert'
import { lastUserTexts, historyStep } from '../chat/history'

/** Token inline que marca a posição do anexo no texto até o envio. */
const token = (name: string) => `[📎 ${name}]`

export function ChatInput({
  localId,
  disabled,
  micDeps,
}: {
  localId: string
  disabled: boolean
  /** Override de teste para as dependências do MicButton (deps reais por default). */
  micDeps?: MicDeps
}) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const addLocalUserText = useStore((s) => s.addLocalUserText)
  const session = useStore((s) => s.sessions[localId])
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const micBase = useRef<{ before: string; after: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // token → path; apagar o token do texto simplesmente deixa a entrada sem uso
  const attachments = useRef(new Map<string, string>())
  // índice atual no histórico de mensagens do usuário (↑/↓); null = fora do modo histórico
  const histIdxRef = useRef<number | null>(null)

  const editRequest = useStore((s) => s.editRequest)
  useEffect(() => {
    if (!editRequest || editRequest.localId !== localId) return
    setText(editRequest.text)
    histIdxRef.current = null
    requestAnimationFrame(() => {
      const el = areaRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }, [editRequest?.seq])

  // Auto-resize: cresce de 1 até 10 linhas conforme o conteúdo; passou disso, rola.
  const MAX_LINES = 10
  const LINE_H = 24
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = LINE_H * MAX_LINES + 20 // + padding vertical
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text])
  // Fonte da lista dirigida pela engine da sessão: protocolo (Claude), curada
  // (ex.: Codex) ou nenhuma — ver useSessionSlashCommands (store.ts).
  const slashCommands = useSessionSlashCommands(session)
  const engine = useEngineFor(session)
  const [activeIndex, setActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)

  const send = () => {
    let out = text
    for (const [tok, path] of attachments.current) out = out.split(tok).join(path)
    const trimmed = out.trim()
    if (!trimmed || disabled || uploading > 0) return
    ws?.send({ type: 'send_message', localId, text: trimmed })
    addLocalUserText(localId, trimmed)
    setText('')
    histIdxRef.current = null
    setUploadError(null)
    attachments.current.clear()
  }

  const stopTurn = () => { if (session?.status === 'working') ws?.send({ type: 'interrupt', localId }) }

  const attachFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    // posição do cursor no momento do gesto — os tokens entram ali
    let pos = areaRef.current?.selectionStart ?? text.length
    for (const file of list) {
      setUploading((n) => n + 1)
      try {
        // imagem colada do clipboard vem com nome genérico — dá um nome útil
        const isPastedImage = file.name === 'image.png' || file.name === ''
        const name = isPastedImage ? `colado-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png` : undefined
        const saved = await uploadFile(file, name)
        const tok = token(saved.name)
        attachments.current.set(tok, saved.path)
        setText((t) => {
          const at = Math.min(pos, t.length)
          const next = `${t.slice(0, at)}${tok}${t.slice(at)}`
          pos = at + tok.length
          return next
        })
        setUploadError(null)
      } catch (err) {
        setUploadError((err as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1) : null
  const slashMatches = slashQuery !== null ? filterCommands(slashCommands, slashQuery) : []
  const slashOpen = !disabled && !slashDismissed && histIdxRef.current === null && slashMatches.length > 0
  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `)
    setSlashDismissed(true)
    areaRef.current?.focus()
  }

  // captura a base (texto + cursor) a partir do valor VIVO do textarea — evita
  // base stale entre gravações rápidas (o MicButton reabilita antes do onDone
  // anterior) e é usada tanto no início de cada gravação quanto no fallback
  // defensivo de applyTranscript (nunca a partir do `text` do closure, que pode
  // estar desatualizado).
  const captureMicBase = () => {
    const el = areaRef.current
    const val = el?.value ?? text
    const pos = el?.selectionStart ?? val.length
    micBase.current = { before: val.slice(0, pos), after: val.slice(pos) }
  }
  const startMic = () => { captureMicBase(); setMicError(null) }

  // Os trechos transcritos substituem a mesma região da base, crescendo ao vivo.
  // A base normalmente já foi fixada por startMic (onStart); o guard abaixo é só
  // um fallback defensivo caso, por algum motivo, onStart não tenha rodado.
  // endMic zera para a próxima gravação.
  const applyTranscript = (tx: string) => {
    if (!micBase.current) captureMicBase() // fallback defensivo, também do valor vivo
    const { before, after } = micBase.current!
    setText(mergeTranscript(before, after, tx))
    setMicError(null)
  }
  const endMic = () => { micBase.current = null }

  return (
    <div style={{ padding: 16, borderTop: '1px solid var(--glass-border)' }}>
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {slashOpen && (
          <SlashMenu items={slashMatches} activeIndex={Math.min(activeIndex, slashMatches.length - 1)} onPick={pickSlash} />
        )}
        <textarea
          ref={areaRef}
          className={dragOver ? 'drag-over' : undefined}
          style={{ flex: 1, resize: 'none', fontSize: 15, lineHeight: '24px', overflowY: 'hidden' }}
          rows={1}
          placeholder={
            uploading > 0 ? t('chat.placeholderUploading')
            : session?.status === 'working' ? t('chat.placeholderWorking')
            : t('chat.placeholder', { engine: engine?.label ?? 'Claude Code' })
          }
          value={text}
          disabled={disabled}
          onChange={(e) => { setText(e.target.value); setSlashDismissed(false); setActiveIndex(0); histIdxRef.current = null }}
          // clicar fora fecha o menu; a seleção usa onMouseDown+preventDefault,
          // então clicar num item NÃO dispara este blur antes do pick.
          onBlur={() => setSlashDismissed(true)}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % slashMatches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickSlash(slashMatches[Math.min(activeIndex, slashMatches.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
            }
            if (!slashOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              const inHistory = histIdxRef.current !== null
              if ((text === '' && e.key === 'ArrowUp') || inHistory) {
                e.preventDefault()
                const list = lastUserTexts(useStore.getState().chat[localId] ?? [], 5)
                const step = historyStep(list, histIdxRef.current, e.key === 'ArrowUp' ? 'up' : 'down')
                histIdxRef.current = step.index
                setText(step.text)
                return
              }
            }
            if (e.key === 'Escape' && session?.status === 'working') { e.preventDefault(); stopTurn(); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) { e.preventDefault(); void attachFiles(e.clipboardData.files) }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false)
            if (e.dataTransfer?.files?.length) void attachFiles(e.dataTransfer.files)
          }}
        />
        {session?.status === 'working' && (
          <button type="button" className="input-action stop-btn"
                  aria-label={t('chat.stop')} title={t('chat.stop')} onClick={stopTurn}>■</button>
        )}
        <MicButton
          disabled={disabled}
          onText={applyTranscript}
          onDone={endMic}
          onError={setMicError}
          onStart={startMic}
          deps={micDeps}
        />
        {session && <SessionControls session={session} />}
        <button className="chat-send" onClick={send} disabled={disabled || uploading > 0}>{t('common.send')}</button>
      </div>
      {(uploadError || micError) && (
        <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>⚠ {uploadError ?? micError}</div>
      )}
    </div>
  )
}
