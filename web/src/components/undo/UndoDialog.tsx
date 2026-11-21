import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { FileChange, FileDiff, PreviewFile, RestoreAction, UndoPreview, UndoRunDto } from '../../../../shared/undo'
import {
  applyRedo, applyUndo, changedPreview, fetchTurnDiff, previewRedo, previewUndo, type UndoApiError, type UndoDecision,
} from '../../undo/api'
import { UnifiedDiff } from './UnifiedDiff'
import { useDialogKeys } from './useDialogKeys'
import './undo.css'

/** O que a tela desfaz: turnos de um terminal, ou o Refazer de um desfazer. */
export type UndoRequest = { turnIds: number[] } | { redoRunId: number }

/** As três escolhas de um conflito (`merge` só com `mergeable`). */
type ConflictChoice = Exclude<RestoreAction, 'revert'>

interface CommonProps {
  onClose(): void
  /** Texto do botão final; o padrão é Desfazer (ou Refazer). */
  confirmLabel?: string
}

/**
 * - `apply` (padrão): busca a prévia de `request` ao abrir, confirma na rota
 *   de desfazer/refazer e chama `onDone` com o desfazer gravado.
 * - `select`: sem rede para confirmar. A prévia vem de quem chama (a Task 17,
 *   "voltar a conversa e os arquivos", recebe-a de `rewind/options` ou do 409
 *   do `rewind`), e o botão final devolve `{ token, decisions }` em `onSelect`.
 *   Prévia nova em `preview` refaz as escolhas; `changed` mostra o aviso de
 *   que os arquivos mudaram; `notice` é um aviso de quem chama (o turno já
 *   interrompido, R21); `reload` liga o "Tentar de novo" da espera.
 */
export type UndoDialogProps =
  | (CommonProps & { mode?: 'apply'; request: UndoRequest; onDone(run: UndoRunDto): void })
  | (CommonProps & {
    mode: 'select'
    preview: UndoPreview
    title?: string
    changed?: boolean
    notice?: string
    busy?: boolean
    error?: string | null
    reload?(): Promise<UndoPreview>
    onSelect(decision: UndoDecision): void
  })

interface Selection {
  preview: UndoPreview
  /** A prévia como chegou (no modo de escolha, compara com a de quem chama). */
  given: UndoPreview
  /** Arquivos que voltam limpos (`revert`): marcado = volta. */
  checked: Record<string, boolean>
  /** Conflitos já escolhidos. */
  choice: Record<string, ConflictChoice>
}

type Loaded<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string }

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A prévia como a tela espera: ela mora dentro do chat, e um corpo torto não pode derrubá-la. */
function normalize(d: Partial<UndoPreview> | null | undefined): UndoPreview {
  const o = d !== null && typeof d === 'object' && !Array.isArray(d) ? d : {}
  const obj = <T,>(v: T | null | undefined): T | null => (v !== null && typeof v === 'object' ? v : null)
  return {
    token: typeof o.token === 'string' ? o.token : '',
    turnIds: Array.isArray(o.turnIds) ? o.turnIds : [],
    blockedBy: obj(o.blockedBy),
    branchChanged: obj(o.branchChanged),
    files: Array.isArray(o.files) ? o.files : [],
    notUndoable: Array.isArray(o.notUndoable) ? o.notUndoable : [],
    hiddenOutside: typeof o.hiddenOutside === 'number' ? o.hiddenOutside : 0,
  }
}

function select(given: UndoPreview): Selection {
  const preview = normalize(given)
  const checked: Record<string, boolean> = {}
  for (const f of preview.files) if (f.verdict === 'revert') checked[f.path] = f.checked
  return { preview, given, checked, choice: {} }
}

/**
 * As decisões como o servidor aceita: o que volta limpo vai `revert`
 * (marcado) ou `keep`; o conflito, a escolha; o já desfeito não vai (o
 * servidor o mantém).
 */
function decisionsOf(s: Selection): Record<string, RestoreAction> {
  const out: Record<string, RestoreAction> = {}
  for (const f of s.preview.files) {
    if (f.verdict === 'revert') out[f.path] = s.checked[f.path] ? 'revert' : 'keep'
    else if (f.verdict === 'conflict' && s.choice[f.path]) out[f.path] = s.choice[f.path]
  }
  return out
}

/** O diff de um arquivo nos turnos da prévia: o primeiro turno que o mexeu. */
async function fileDiff(turnIds: number[], path: string): Promise<FileDiff> {
  let last: unknown = new Error(path)
  for (const id of turnIds) {
    try {
      return await fetchTurnDiff(id, path)
    } catch (e) {
      last = e
      if ((e as UndoApiError).code !== 'undo_path_not_in_turn') throw e
    }
  }
  throw last
}

/** Escrito com problema: falhou ou mudou entre a reconferência e a escrita. */
const problemsOf = (run: UndoRunDto) => run.files.filter((f) => f.result === 'failed' || f.result === 'changed_since_preview')

function notUndoableTag(f: FileChange, t: TFunction): string {
  if (f.status === 'too_big') return t('undo.status.too_big')
  if (f.status === 'unsnapshotted') return t('undo.status.unsnapshotted')
  return t('undo.status.submodule')
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="undo-section" data-section={id}>
      <h4 className="undo-section__title">{title}</h4>
      {children}
    </section>
  )
}

/** Um conflito aberto: o que mudou desde o turno e as escolhas. */
function Conflict({ file, index, choice, onChoose }: {
  file: PreviewFile
  index: number
  choice: ConflictChoice | undefined
  onChoose(c: ConflictChoice): void
}) {
  const { t } = useTranslation()
  const options: Array<[ConflictChoice, string]> = [
    ...(file.mergeable ? [['merge', t('undo.dialog.merge')] as [ConflictChoice, string]] : []),
    ['force', t('undo.dialog.force')],
    ['keep', t('undo.dialog.keep')],
  ]
  return (
    <div className="undo-dialog__conflict">
      <p className="undo-dialog__path">{file.path}</p>
      {file.overlapped && <p className="undo-dialog__hint">{t('undo.dialog.overlapped')}</p>}
      {file.sinceTurn !== undefined && (
        <>
          <p className="undo-dialog__hint">{t('undo.dialog.sinceTurn')}</p>
          <UnifiedDiff diff={{ path: file.path, binary: false, text: file.sinceTurn, truncated: !!file.sinceTurnTruncated }} />
        </>
      )}
      <div className="undo-dialog__choices" role="radiogroup" aria-label={file.path}>
        {options.map(([value, label]) => (
          <label key={value}>
            <input type="radio" name={`undo-conflict-${index}`} value={value} checked={choice === value}
                   onChange={() => onChoose(value)} />
            {label}
          </label>
        ))}
      </div>
    </div>
  )
}

/**
 * A tela de desfazer (e de refazer) antes de escrever: o que vai voltar, os
 * incertos (desmarcados, com "ver diff"), os conflitos um de cada vez, o que
 * não dá para desfazer e a contagem de fora do projeto. O botão final só liga
 * sem espera e com todos os conflitos escolhidos. O 409 `undo_changed` troca a
 * prévia pela nova e avisa. Modal simples, sem animação nem desfoque (sem GPU).
 */
export function UndoDialog(props: UndoDialogProps) {
  const { t } = useTranslation()
  const isSelect = props.mode === 'select'
  const request = props.mode === 'select' ? null : props.request
  const givenPreview = props.mode === 'select' ? props.preview : null
  const reload = props.mode === 'select' ? props.reload : undefined
  const redo = !!request && 'redoRunId' in request

  const [sel, setSel] = useState<Selection | null>(() => (givenPreview ? select(givenPreview) : null))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!givenPreview)
  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<UndoRunDto | null>(null)
  const [diffs, setDiffs] = useState<Record<string, Loaded<FileDiff> | undefined>>({})

  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const seq = useRef(0)

  const show = useCallback((p: UndoPreview) => {
    setSel(select(p))
    setDiffs({})
    setLoadError(null)
  }, [])

  // Modo de escolha: prévia nova de quem chama refaz as escolhas.
  useEffect(() => {
    if (givenPreview && sel?.given !== givenPreview) show(givenPreview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [givenPreview])

  const reqKey = request ? ('turnIds' in request ? `t${request.turnIds.join(',')}` : `r${request.redoRunId}`) : ''
  const fetchPreview = useCallback(() => {
    const source = request
      ? ('turnIds' in request ? previewUndo(request.turnIds) : previewRedo(request.redoRunId))
      : reload?.()
    if (!source) return
    const n = ++seq.current
    setLoading(true)
    source.then(
      (p) => { if (alive.current && seq.current === n) { setLoading(false); setChanged(false); show(p) } },
      (e) => { if (alive.current && seq.current === n) { setLoading(false); setLoadError(errMessage(e)) } },
    )
    // `reqKey` resume o pedido: um objeto novo com os mesmos ids não busca de novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, reload, show])
  useEffect(() => { if (request) fetchPreview() }, [fetchPreview]) // eslint-disable-line react-hooks/exhaustive-deps

  const onDoneRef = useRef(props.mode === 'select' ? null : props.onDone)
  onDoneRef.current = props.mode === 'select' ? null : props.onDone
  // Depois de escrever com problema, fechar é terminar: quem chama recarrega.
  const close = useCallback(() => {
    if (done) onDoneRef.current?.(done)
    else props.onClose()
  }, [done, props.onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  const dialogRef = useRef<HTMLDivElement>(null)
  const onKeyDown = useDialogKeys(dialogRef, close)

  const toggleDiff = (path: string) => {
    if (diffs[path]) { setDiffs((d) => ({ ...d, [path]: undefined })); return }
    if (!sel) return
    setDiffs((d) => ({ ...d, [path]: { status: 'loading' } }))
    // Fechado no meio, ou prévia nova (que zera os diffs): a resposta não entra.
    fileDiff(sel.preview.turnIds, path).then(
      (data) => { if (alive.current) setDiffs((d) => (d[path] ? { ...d, [path]: { status: 'ok', data } } : d)) },
      (e) => { if (alive.current) setDiffs((d) => (d[path] ? { ...d, [path]: { status: 'error', message: errMessage(e) } } : d)) },
    )
  }

  const files = sel?.preview.files ?? []
  const conflicts = files.filter((f) => f.verdict === 'conflict')
  const willRevert = files.filter((f) => (f.verdict === 'revert' && f.class === 'own') || f.verdict === 'already')
  const uncertain = files.filter((f) => f.verdict === 'revert' && f.class === 'uncertain')
  const allChosen = !!sel && conflicts.every((f) => sel.choice[f.path])
  const hasWork = !!sel && (
    files.some((f) => f.verdict === 'revert' && sel.checked[f.path])
    || conflicts.some((f) => sel.choice[f.path] === 'merge' || sel.choice[f.path] === 'force'))
  const working = busy || (props.mode === 'select' && !!props.busy)
  const canConfirm = !!sel && !sel.preview.blockedBy && allChosen && !working && !loading && (isSelect || hasWork)

  const confirm = () => {
    if (!sel || !canConfirm) return
    const decision: UndoDecision = { token: sel.preview.token, decisions: decisionsOf(sel) }
    if (props.mode === 'select') { props.onSelect(decision); return }
    const req = props.request
    setBusy(true)
    setError(null)
    const write = 'turnIds' in req ? applyUndo(req.turnIds, decision) : applyRedo(req.redoRunId, decision)
    write.then(
      (run) => {
        if (!alive.current) return
        setBusy(false)
        if (problemsOf(run).length > 0) setDone(run)
        else onDoneRef.current?.(run)
      },
      (e) => {
        if (!alive.current) return
        setBusy(false)
        const fresh = changedPreview(e)
        if (fresh) { show(fresh); setChanged(true); return }
        setError(errMessage(e))
      },
    )
  }

  const title = props.mode === 'select' && props.title
    ? props.title
    : t(redo ? 'undo.dialog.titleRedo' : 'undo.dialog.titleUndo')
  const confirmLabel = working
    ? t(redo ? 'undo.dialog.redoing' : 'undo.dialog.undoing')
    : props.confirmLabel ?? t(redo ? 'undo.line.redo' : 'undo.line.undo')
  const shownError = error ?? (props.mode === 'select' ? props.error ?? null : null)

  let body: ReactNode
  if (done) {
    body = (
      <Section id="problems" title={t('undo.dialog.problems')}>
        {problemsOf(done).map((f) => (
          <div key={f.path} className="undo-dialog__row">
            <span className="undo-dialog__path">{f.path}</span>
            <span className="undo-badge undo-badge--err">
              {f.result === 'failed'
                ? (f.error ? t('undo.dialog.failed', { error: f.error }) : t('undo.dialog.failedNoReason'))
                : t('undo.dialog.changedSincePreview')}
            </span>
          </div>
        ))}
      </Section>
    )
  } else if (!sel) {
    body = loadError
      ? (
        <div className="undo-dialog__blocked">
          <span>{t('undo.panel.loadFailed', { message: loadError })}</span>
          <button type="button" className="ghost" onClick={fetchPreview}>{t('undo.dialog.retry')}</button>
        </div>
      )
      : <p className="undo-section__msg">{t('undo.panel.loading')}</p>
  } else {
    const p = sel.preview
    // Um conflito de cada vez: abre até o primeiro sem escolha.
    const firstOpen = conflicts.findIndex((f) => !sel.choice[f.path])
    const shown = firstOpen < 0 ? conflicts : conflicts.slice(0, firstOpen + 1)
    const empty = files.length === 0 && p.notUndoable.length === 0 && p.hiddenOutside === 0
    const setChecked = (path: string, on: boolean) => setSel((s) => (s ? { ...s, checked: { ...s.checked, [path]: on } } : s))
    const choose = (path: string, c: ConflictChoice) => setSel((s) => (s ? { ...s, choice: { ...s.choice, [path]: c } } : s))
    const branchName = (b: string | null) => b ?? t('undo.dialog.noBranch')
    body = (
      <>
        {p.branchChanged && (
          <p className="undo-dialog__warn">
            {t('undo.dialog.branchChanged', { from: branchName(p.branchChanged.from), to: branchName(p.branchChanged.to) })}
          </p>
        )}
        {props.mode === 'select' && props.notice && <p className="undo-dialog__warn">{props.notice}</p>}
        {(changed || (props.mode === 'select' && props.changed)) && (
          <p className="undo-dialog__warn" role="status">{t('undo.dialog.changed')}</p>
        )}
        {p.blockedBy && (
          <div className="undo-dialog__blocked">
            <span>{t('undo.dialog.blocked', { terminal: p.blockedBy.terminal ?? t('undo.dialog.otherTerminal') })}</span>
            {(request || reload) && (
              <button type="button" className="ghost" disabled={loading} onClick={fetchPreview}>{t('undo.dialog.retry')}</button>
            )}
          </div>
        )}
        {loadError && <p className="undo-dialog__err">{t('undo.panel.loadFailed', { message: loadError })}</p>}
        {empty && <p className="undo-section__msg">{t('undo.dialog.nothing')}</p>}
        {willRevert.length > 0 && (
          <Section id="revert" title={t('undo.dialog.willRevert')}>
            {willRevert.map((f) => (f.verdict === 'already'
              ? (
                <div key={f.path} className="undo-dialog__row undo-dialog__row--plain">
                  <span className="undo-dialog__path">{f.path}</span>
                  <span className="undo-tree__tag">{t('undo.dialog.already')}</span>
                </div>
              )
              : (
                <label key={f.path} className="undo-dialog__row">
                  <input type="checkbox" checked={!!sel.checked[f.path]} onChange={(e) => setChecked(f.path, e.target.checked)} />
                  <span className="undo-dialog__path">{f.path}</span>
                </label>
              )))}
          </Section>
        )}
        {uncertain.length > 0 && (
          <Section id="uncertain" title={t('undo.dialog.uncertain')}>
            {uncertain.map((f) => {
              const d = diffs[f.path]
              return (
                <div key={f.path}>
                  <div className="undo-dialog__row">
                    <label className="undo-dialog__check">
                      <input type="checkbox" checked={!!sel.checked[f.path]} onChange={(e) => setChecked(f.path, e.target.checked)} />
                      <span className="undo-dialog__path">{f.path}</span>
                    </label>
                    <button type="button" className="undo-dialog__link" aria-expanded={!!d} onClick={() => toggleDiff(f.path)}>
                      {d ? t('undo.dialog.hideDiff') : t('undo.dialog.viewDiff')}
                    </button>
                  </div>
                  {d && (
                    <div className="undo-dialog__diff">
                      {d.status === 'loading' && <p className="undo-panel__hint">{t('undo.panel.loading')}</p>}
                      {d.status === 'error' && <p className="undo-panel__hint">{t('undo.panel.loadFailed', { message: d.message })}</p>}
                      {d.status === 'ok' && <UnifiedDiff diff={d.data} />}
                    </div>
                  )}
                </div>
              )
            })}
          </Section>
        )}
        {conflicts.length > 0 && (
          <Section id="conflicts" title={t('undo.dialog.conflicts')}>
            {shown.map((f, i) => (
              <Conflict key={f.path} file={f} index={i} choice={sel.choice[f.path]} onChoose={(c) => choose(f.path, c)} />
            ))}
            {conflicts.length > shown.length && (
              <p className="undo-section__msg">{t('undo.dialog.moreConflicts', { count: conflicts.length - shown.length })}</p>
            )}
          </Section>
        )}
        {p.notUndoable.length > 0 && (
          <Section id="not-undoable" title={t('undo.dialog.notUndoable')}>
            {p.notUndoable.map((f) => (
              <div key={f.path} className="undo-dialog__row undo-dialog__row--plain">
                <span className="undo-dialog__path">{f.path}</span>
                <span className="undo-tree__tag">{notUndoableTag(f, t)}</span>
              </div>
            ))}
          </Section>
        )}
        {p.hiddenOutside > 0 && <p className="undo-section__msg">{t('undo.badge.outside', { count: p.hiddenOutside })}</p>}
        {!isSelect && allChosen && !hasWork && files.length > 0 && (
          <p className="undo-section__msg">{t('undo.dialog.nothingChecked')}</p>
        )}
      </>
    )
  }

  return createPortal(
    <div className="undo-panel-backdrop undo-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="undo-dialog" role="dialog" aria-modal="true" aria-label={title}
           ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="undo-panel__head">
          <h3>{title}</h3>
          <button type="button" className="ghost undo-panel__close" aria-label={t('common.close')} onClick={close}>×</button>
        </header>
        <div className="undo-dialog__body">{body}</div>
        {shownError && <p className="undo-dialog__err" role="alert">{shownError}</p>}
        <footer className="undo-dialog__foot">
          {done ? (
            <button type="button" onClick={close}>{t('common.close')}</button>
          ) : (
            <>
              <button type="button" className="ghost" onClick={close}>{t('common.cancel')}</button>
              <button type="button" disabled={!canConfirm} onClick={confirm}>{confirmLabel}</button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
