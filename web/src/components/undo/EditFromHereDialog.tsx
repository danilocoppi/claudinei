import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  Availability, RewindMode, RewindOptionsDto, RewindResultDto, RewindTarget, TurnDto, UndoPreview,
} from '../../../../shared/undo'
import type { ChatItem, EngineMeta } from '../../types'
import { useStore } from '../../store'
import { useUndoStore } from '../../undo/undoStore'
import { attachTurns, occurrenceOf } from '../../undo/attachTurns'
import { changedPreview, fetchRewindOptions, rewind, type UndoDecision } from '../../undo/api'
import { localizeServerError } from '../../serverErrors'
import { parseBranchCommand } from '../../branch/commands'
import { UndoDialog } from './UndoDialog'
import { useDialogKeys } from './useDialogKeys'
import './undo.css'

/**
 * A mensagem a editar como o servidor a acha: o turno casado pelo
 * `attachTurns` (com ele, o servidor tira a chave e a ocorrência das linhas
 * de turno, R22), o texto e a ocorrência contada no chat (vale só sem turno,
 * para a mensagem anterior ao recurso). Roda no clique, não no render.
 */
export function editTargetOf(items: ChatItem[], turns: TurnDto[] | undefined, index: number): RewindTarget {
  const it = items[index]
  const text = it && 'text' in it && typeof it.text === 'string' ? it.text : ''
  const { occurrence } = occurrenceOf(items, index)
  const placed = turns && turns.length > 0 ? attachTurns(items, turns).find((p) => p.itemIndex === index) : undefined
  return { ...(placed ? { turnId: placed.turn.id } : {}), text, occurrence }
}

interface Props {
  localId: string
  target: RewindTarget
  /** O texto da mensagem, que abre no campo para editar. */
  initialText: string
  /** O item editado no chat (a `key` vale mais que o índice, que muda com o histórico). */
  itemKey?: string
  itemIndex: number
  onClose(): void
}

type Loaded<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string }

/** A tela de desfazer por cima: a prévia, se mudou desde a anterior, e o aviso da interrupção (R21). */
type FilesStep = { preview: UndoPreview; changed: boolean; notice?: string }

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

type T = TFunction

/**
 * O motivo traduzido de uma opção desligada (null se ligada). `engine` é o
 * motor das opções, para quando o motivo não traz o seu. Fora do componente
 * para o `reloadPreview` usar com as opções novas, sem capturar o render.
 */
function reasonOf(t: T, engines: EngineMeta[], a: Availability, engine: string): string | null {
  if (a.enabled || !a.reason) return null
  if (a.reason === 'engine_unsupported') {
    const id = a.params?.engine ?? engine
    const name = engines.find((e) => e.id === id)?.label ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : '')
    return t('undo.reason.engine_unsupported', { engine: name })
  }
  return t(`undo.reason.${a.reason}` as 'undo.reason.no_git')
}

/**
 * O erro da volta que não deu certo. `rewind_failed` é o motor recusando:
 * o texto dele (cru, na língua do motor) diz mais que o genérico e vai como
 * detalhe, atrás de um prefixo traduzido; os outros códigos têm tradução.
 */
function resultError(t: T, e: RewindResultDto['error']): string {
  if (!e) return ''
  if (e.code === 'rewind_failed' && e.message) return t('undo.edit.engineError', { error: e.message })
  return localizeServerError({ code: e.code, error: e.message })
}

/** O chat local recarrega do histórico (o corte local não vale mais). */
function reloadHistory(localId: string): void {
  useStore.setState((s) => {
    if (!(localId in s.historyLoadedFor)) return s
    const { [localId]: _gone, ...rest } = s.historyLoadedFor
    return { historyLoadedFor: rest }
  })
}

/**
 * Editar a partir daqui: o texto da mensagem num campo e três saídas.
 * **Voltar só a conversa** e **Voltar a conversa e os arquivos** pedem ao
 * servidor (`rewind`), que corta a conversa no motor e manda o texto editado;
 * a segunda passa antes pela tela de desfazer em modo de escolha. **Copiar
 * para o campo** é o editar de antes: o texto vai ao campo do chat, sem envio
 * e sem interromper o agente (R24); só as duas voltas interrompem o turno.
 * As opções que o motor ou o retrato não permitem ficam desligadas com o
 * motivo. Modal simples, sem animação nem desfoque (sem GPU).
 */
export function EditFromHereDialog({ localId, target, initialText, itemKey, itemIndex, onClose }: Props) {
  const { t } = useTranslation()
  const engines = useStore((s) => s.engines)
  const working = useStore((s) => s.sessions[localId]?.status === 'working')
  const [text, setText] = useState(initialText)
  const [opts, setOpts] = useState<Loaded<RewindOptionsDto>>({ status: 'loading' })
  /** A volta em curso (o botão que a pediu mostra "Voltando…"). */
  const [sending, setSending] = useState<RewindMode | null>(null)
  const busy = sending !== null
  const [error, setError] = useState<string | null>(null)
  /** O aviso final (a conversa não voltou, ou o texto não saiu): só resta fechar. */
  const [finished, setFinished] = useState<string | null>(null)
  const [files, setFiles] = useState<FilesStep | null>(null)
  /**
   * `/side`, `/btw` e `/fork` são do Claudinei e só o campo de mensagem os
   * trata: aqui eles iriam ao motor como texto. O reconhecimento é o mesmo do
   * campo (texto aparado). Tentar voltar com um deles marca o aviso, que só
   * aparece enquanto o texto continuar sendo comando.
   */
  const isCommand = parseBranchCommand(text.trim()) !== null
  const [commandTried, setCommandTried] = useState(false)
  /** Barra a volta quando o texto é comando e liga o aviso. */
  const blockCommand = () => {
    if (!isCommand) return false
    setCommandTried(true)
    return true
  }

  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const dialogRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  // `close` é recriada a cada render; o hook guarda a última.
  const onKeyDown = useDialogKeys(dialogRef, () => close())
  // Depois do foco do diálogo: o cursor no fim do texto.
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    fetchRewindOptions(localId, target).then(
      (data) => { if (alive.current) setOpts({ status: 'ok', data }) },
      (e) => { if (alive.current) setOpts({ status: 'error', message: errMessage(e) }) },
    )
  }, [localId, target])

  const reasonText = (a: Availability) => reasonOf(t, engines, a, opts.status === 'ok' ? opts.data.engine : '')

  /** O chat local está cortado por uma volta que ainda não deu certo. */
  const cutRef = useRef(false)
  /** Desiste do corte: o histórico recarrega e traz de volta o que foi tirado. */
  const restoreChat = () => {
    if (!cutRef.current) return
    cutRef.current = false
    reloadHistory(localId)
  }
  const close = () => { restoreChat(); onClose() }

  /** Corta o chat local a partir do item editado: o eco do texto chega pelo WS durante o pedido. */
  const cutChat = () => {
    const st = useStore.getState()
    const items = st.chat[localId] ?? []
    let at = itemKey ? items.findIndex((x) => x.key === itemKey) : -1
    // Sem a chave (o histórico recarregou e trocou as chaves ao vivo): o mesmo índice, se ainda é a mesma mensagem.
    if (at < 0) {
      const it = items[itemIndex]
      at = it && it.kind === 'user_text' && it.text === target.text ? itemIndex : -1
    }
    if (at >= 0) { st.truncateFrom(localId, at); cutRef.current = true }
  }

  const finish = (res: RewindResultDto, edited: string) => {
    // Nenhuma mensagem do WS tira os turnos do trecho da conversa atual: recarrega.
    useUndoStore.getState().load(localId).catch((e) => console.warn('[undo] turnos não carregaram', e))
    if (!res.conversationRewound) {
      restoreChat()
      useStore.getState().requestEdit(localId, edited)
      const msg = t(res.run ? 'undo.edit.failed' : 'undo.edit.failedNoFiles', { error: resultError(t, res.error) })
      if (alive.current) { setFiles(null); setFinished(msg); setSending(null) }
      return
    }
    // A conversa voltou: o corte vale.
    cutRef.current = false
    if (res.error) {
      // A conversa voltou, mas o texto não saiu: ele vai ao campo.
      useStore.getState().requestEdit(localId, edited)
      if (alive.current) { setFiles(null); setFinished(t('undo.edit.notSent', { error: resultError(t, res.error) })); setSending(null) }
      return
    }
    // Arquivo que falhou ou mudou durante a escrita: a volta seguiu, mas o operador precisa saber.
    const problems = (res.run?.files ?? []).filter((f) => f.result === 'failed' || f.result === 'changed_since_preview')
    if (problems.length > 0) {
      if (alive.current) { setFiles(null); setFinished(`${t('undo.dialog.problems')}: ${problems.map((f) => f.path).join(', ')}`); setSending(null) }
      return
    }
    if (alive.current) onClose()
  }

  /**
   * Manda a volta. "Conversa e arquivos" sem a escolha da tela de desfazer
   * (agente trabalhando: as opções vêm sem prévia) é só uma sondagem: o
   * servidor interrompe o turno e devolve a prévia no 409, sem tocar em nada.
   */
  const send = async (mode: RewindMode, decision?: UndoDecision) => {
    if (blockCommand()) return
    const edited = text
    const probe = mode === 'conversation_and_files' && !decision
    const interrupting = working
    if (!probe) cutChat()
    setSending(mode)
    setError(null)
    try {
      const res = await rewind(localId, { target, mode, editedText: edited, ...(decision ?? {}) })
      finish(res, edited)
    } catch (e) {
      const fresh = changedPreview(e)
      // Prévia nova dos arquivos: a tela de desfazer volta, e o corte fica para a confirmação seguinte.
      const again = !!fresh && mode === 'conversation_and_files' && alive.current
      if (!again) restoreChat()
      if (!alive.current) return
      setSending(null)
      if (fresh && again) {
        // Os arquivos não foram escritos nem a conversa voltou; a interrupção, se houve, ficou (R21).
        setFiles((prev) => ({
          preview: fresh,
          changed: !probe,
          notice: interrupting || prev?.notice ? t('undo.edit.interrupted') : undefined,
        }))
        return
      }
      setFiles(null)
      setError(errMessage(e))
    }
  }

  const reloadPreview = useCallback(
    () => fetchRewindOptions(localId, target).then((o) => {
      if (o.files.preview) return o.files.preview
      // Os motores lidos na hora: o motivo vem das opções novas, não das do render.
      const why = reasonOf(t, useStore.getState().engines, o.conversation.enabled ? o.files : o.conversation, o.engine)
      throw new Error(why ?? t('serverErrors.rewind_unavailable'))
    }),
    [localId, target, t],
  )

  // Só o texto vai ao campo: copiar não exige parar o turno (R24).
  const copy = () => {
    useStore.getState().requestEdit(localId, text)
    close()
  }

  const onFiles = () => {
    if (opts.status !== 'ok' || blockCommand()) return
    const preview = opts.data.files.preview
    if (preview) setFiles({ preview, changed: false })
    else void send('conversation_and_files')
  }

  const data = opts.status === 'ok' ? opts.data : null
  const hasText = text.trim() !== ''
  const idle = !busy && finished === null
  const canConversation = idle && hasText && !!data?.conversation.enabled
  const canFiles = canConversation && !!data?.files.enabled
  // O aviso é das duas voltas (só elas interrompem): some quando o motor não deixa nenhuma.
  const warnId = useId()
  const showWarn = working && !(data && !data.conversation.enabled)

  // Um motivo por opção desligada; o mesmo motivo para as duas aparece uma vez.
  const reasons: Array<[string, string]> = []
  if (data) {
    const conv = reasonText(data.conversation)
    if (conv) reasons.push(['conversation', conv])
    const fil = reasonText(data.files)
    if (fil && fil !== conv) reasons.push(['files', fil])
  }

  const title = t('undo.edit.title')
  return (
    <>
      {createPortal(
        <div className="undo-panel-backdrop undo-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
          <div className="undo-dialog undo-edit" role="dialog" aria-modal="true" aria-label={title}
               ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
            <header className="undo-panel__head">
              <h3>{title}</h3>
              <button type="button" className="ghost undo-panel__close" aria-label={t('common.close')} onClick={close}>×</button>
            </header>
            <div className="undo-dialog__body">
              <textarea ref={textRef} className="undo-edit__text" aria-label={t('undo.edit.text')} rows={5}
                        value={text} readOnly={!idle} onChange={(e) => setText(e.target.value)} />
              {opts.status === 'loading' && <p className="undo-section__msg">{t('undo.panel.loading')}</p>}
              {opts.status === 'error' && <p className="undo-dialog__err">{t('undo.panel.loadFailed', { message: opts.message })}</p>}
              {reasons.map(([id, r]) => <p key={id} className="undo-edit__reason" data-option={id}>{r}</p>)}
              {finished !== null && <p className="undo-dialog__warn" role="alert">{finished}</p>}
              {commandTried && isCommand && finished === null && (
                <p className="undo-dialog__err undo-edit__command" role="alert">{t('editFromHere.commandNotAllowed')}</p>
              )}
            </div>
            {error && <p className="undo-dialog__err" role="alert">{error}</p>}
            {showWarn && finished === null && (
              <p id={warnId} className="undo-dialog__warn undo-edit__warn">{t('chat.editWorkingMsg')}</p>
            )}
            <footer className="undo-dialog__foot undo-edit__foot">
              {finished !== null ? (
                <button type="button" onClick={close}>{t('common.close')}</button>
              ) : (
                <>
                  <button type="button" className="ghost" onClick={close}>{t('common.cancel')}</button>
                  <button type="button" className="ghost" disabled={!idle} onClick={copy}>{t('undo.edit.copy')}</button>
                  <button type="button" disabled={!canConversation} aria-describedby={showWarn ? warnId : undefined}
                          onClick={() => { void send('conversation') }}>
                    {sending === 'conversation' ? t('undo.edit.sending') : t('undo.edit.conversation')}
                  </button>
                  <button type="button" disabled={!canFiles} aria-describedby={showWarn ? warnId : undefined} onClick={onFiles}>
                    {sending === 'conversation_and_files' && !files ? t('undo.edit.sending') : t('undo.edit.conversationAndFiles')}
                  </button>
                </>
              )}
            </footer>
          </div>
        </div>,
        document.body,
      )}
      {files && (
        <UndoDialog mode="select" preview={files.preview} title={t('undo.edit.conversationAndFiles')}
                    confirmLabel={t('undo.edit.conversationAndFiles')} changed={files.changed} notice={files.notice}
                    busy={busy} reload={reloadPreview}
                    onSelect={(d) => { void send('conversation_and_files', d) }} onClose={() => { setFiles(null); restoreChat() }} />
      )}
    </>
  )
}
