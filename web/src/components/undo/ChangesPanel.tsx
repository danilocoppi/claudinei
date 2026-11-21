import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AttributedFile, ChangedFilesDto, FileDiff, TurnDto } from '../../../../shared/undo'
import { fetchIntervalDiff, fetchIntervalFiles, fetchTurnDiff, fetchTurnFiles } from '../../undo/api'
import { useUndoStore } from '../../undo/undoStore'
import type { DeclaredChange } from '../../undo/declared'
import { DiffView } from '../DiffView'
import { UnifiedDiff } from './UnifiedDiff'
import type { UndoRequest } from './UndoDialog'
import { useDialogKeys } from './useDialogKeys'
import './undo.css'

/** O que o painel abre em foco: um turno, um intervalo fora de turno ou as declarações (sem git). */
export type PanelFocus =
  | { turnId: number }
  | { interval: { from: number; to: number } }
  | { declared: DeclaredChange[] }

/** De onde vêm os arquivos e o diff: um turno ou um intervalo do terminal. */
type Source = { kind: 'turn'; turnId: number } | { kind: 'interval'; from: number; to: number }

const sourceKey = (s: Source) => (s.kind === 'turn' ? `t${s.turnId}` : `i${s.from}-${s.to}`)

/** Sem diff no servidor: o painel diz o que houve sem buscar nada. */
const NO_DIFF = new Set<AttributedFile['status']>(['too_big', 'unsnapshotted', 'submodule'])

type Picked =
  | { kind: 'file'; source: Source; file: AttributedFile }
  | { kind: 'declared'; change: DeclaredChange }

type Loaded<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; message: string }

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}

function fmtTime(iso: string, lng: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try { return d.toLocaleString(lng, { dateStyle: 'short', timeStyle: 'short' }) } catch { return d.toLocaleString() }
}

/** A resposta como a tela espera: o painel mora dentro do chat, e um corpo torto não pode derrubá-lo. */
const normalize = (d: Partial<ChangedFilesDto> | null | undefined): ChangedFilesDto => ({
  files: Array.isArray(d?.files) ? d.files : [],
  hiddenOutside: typeof d?.hiddenOutside === 'number' ? d.hiddenOutside : 0,
  warnings: Array.isArray(d?.warnings) ? d.warnings : [],
})

/** Os arquivos de um turno ou intervalo, buscados ao montar (a seção aberta). */
function useFiles(localId: string, source: Source): Loaded<ChangedFilesDto> {
  const [state, setState] = useState<Loaded<ChangedFilesDto>>({ status: 'loading' })
  const key = sourceKey(source)
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    const req = source.kind === 'turn' ? fetchTurnFiles(source.turnId) : fetchIntervalFiles(localId, source.from, source.to)
    req.then(
      (data) => { if (alive) setState({ status: 'ok', data: normalize(data) }) },
      (e) => { if (alive) setState({ status: 'error', message: errMessage(e) }) },
    )
    return () => { alive = false }
    // `key` resume a origem: um objeto novo com os mesmos ids não busca de novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localId, key])
  return state
}

// ── Árvore de arquivos ──

interface Dir<T> { name: string; path: string; dirs: Dir<T>[]; files: Array<{ name: string; item: T }> }

function buildTree<T extends { path: string }>(items: T[]): Dir<T> {
  const root: Dir<T> = { name: '', path: '', dirs: [], files: [] }
  const byPath = new Map<string, Dir<T>>()
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean)
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = byPath.get(path)
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [] }
        byPath.set(path, next)
        cur.dirs.push(next)
      }
      cur = next
    }
    cur.files.push({ name: parts[parts.length - 1] ?? item.path, item })
  }
  const sortDir = (d: Dir<T>) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name))
    d.files.sort((a, b) => a.name.localeCompare(b.name))
    d.dirs.forEach(sortDir)
  }
  sortDir(root)
  return root
}

/** Pastas recolhíveis e um botão por arquivo. */
function FileTree<T extends { path: string }>({ items, selected, onPick, meta }: {
  items: T[]
  selected: string | null
  onPick(item: T): void
  meta(item: T): ReactNode
}) {
  const tree = useMemo(() => buildTree(items), [items])
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (path: string) => setClosed((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const rows: ReactNode[] = []
  const walk = (d: Dir<T>, depth: number) => {
    for (const sub of d.dirs) {
      const open = !closed.has(sub.path)
      rows.push(
        <button key={`d:${sub.path}`} type="button" className="undo-tree__row undo-tree__row--dir"
                style={{ paddingLeft: 12 + depth * 14 }} aria-expanded={open} onClick={() => toggle(sub.path)}>
          <span className="undo-tree__name">{sub.name}/</span>
        </button>,
      )
      if (open) walk(sub, depth + 1)
    }
    for (const f of d.files) {
      rows.push(
        <button key={`f:${f.item.path}`} type="button" title={f.item.path}
                className={`undo-tree__row${selected === f.item.path ? ' undo-tree__row--sel' : ''}`}
                style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onPick(f.item)}>
          <span className="undo-tree__name">{f.name}</span>
          {meta(f.item)}
        </button>,
      )
    }
  }
  walk(tree, 0)
  return <div className="undo-tree">{rows}</div>
}

function statusTag(f: AttributedFile, t: TFunction): string | null {
  switch (f.status) {
    case 'too_big': return t('undo.status.too_big')
    case 'unsnapshotted': return t('undo.status.unsnapshotted')
    case 'submodule': return t('undo.status.submodule')
    case 'added': return t('undo.status.added')
    case 'deleted': return t('undo.status.deleted')
    case 'mode': return t('undo.status.mode')
    default: return null
  }
}

function FileMeta({ file }: { file: AttributedFile }) {
  const { t } = useTranslation()
  const tag = file.binary && !NO_DIFF.has(file.status) ? t('undo.status.binary') : statusTag(file, t)
  return (
    <>
      {tag && <span className="undo-tree__tag">{tag}</span>}
      {!NO_DIFF.has(file.status) && !file.binary && (
        <>
          <span className="undo-tree__add">+{file.added}</span>
          <span className="undo-tree__del">−{file.removed}</span>
        </>
      )}
    </>
  )
}
const fileMeta = (f: AttributedFile) => <FileMeta file={f} />

// ── Seções ──

function Notes({ data }: { data: ChangedFilesDto }) {
  const { t } = useTranslation()
  const notes: ReactNode[] = []
  for (const w of data.warnings) {
    if (w === 'late') notes.push(<span key={w} className="undo-badge">{t('undo.badge.late')}</span>)
    else if (w === 'uncertain_end') notes.push(<span key={w} className="undo-badge">{t('undo.badge.uncertainEnd')}</span>)
    else if (w === 'limited') notes.push(<span key={w} className="undo-badge">{t('undo.badge.limited')}</span>)
  }
  // Fora da pasta do projeto, para quem não é administrador: só a contagem.
  if (data.hiddenOutside > 0) {
    notes.push(<span key="outside" className="undo-badge undo-badge--dim">{t('undo.badge.outside', { count: data.hiddenOutside })}</span>)
  }
  return notes.length > 0 ? <div className="undo-section__notes">{notes}</div> : null
}

/**
 * Os arquivos de uma origem. Com `title` (o foco), os próprios ficam na seção
 * do título e os incertos numa seção à parte, "Pode ser de outro terminal".
 */
function SourceFiles({ localId, source, picked, onPick, title }: {
  localId: string
  source: Source
  picked: Picked | null
  onPick(source: Source, file: AttributedFile): void
  title?: string
}) {
  const { t } = useTranslation()
  const state = useFiles(localId, source)
  const key = sourceKey(source)
  const selected = picked?.kind === 'file' && sourceKey(picked.source) === key ? picked.file.path : null
  const pick = useCallback((f: AttributedFile) => onPick(source, f), [onPick, key]) // eslint-disable-line react-hooks/exhaustive-deps
  const own = useMemo(() => (state.status === 'ok' ? state.data.files.filter((f) => !title || f.class === 'own') : []), [state, title])
  const uncertain = useMemo(() => (state.status === 'ok' && title ? state.data.files.filter((f) => f.class === 'uncertain') : []), [state, title])

  let body: ReactNode
  if (state.status === 'loading') body = <p className="undo-section__msg">{t('undo.panel.loading')}</p>
  else if (state.status === 'error') body = <p className="undo-section__msg">{t('undo.panel.loadFailed', { message: state.message })}</p>
  else {
    const empty = state.data.files.length === 0 && state.data.hiddenOutside === 0
    body = (
      <>
        <Notes data={state.data} />
        {empty && <p className="undo-section__msg">{t('undo.panel.noFiles')}</p>}
        {own.length > 0 && <FileTree items={own} selected={selected} onPick={pick} meta={fileMeta} />}
      </>
    )
  }
  if (!title) return <>{body}</>
  return (
    <>
      <section className="undo-section" data-section="focus">
        <h4 className="undo-section__title">{title}</h4>
        {body}
      </section>
      {uncertain.length > 0 && (
        <section className="undo-section" data-section="uncertain">
          <h4 className="undo-section__title">{t('undo.panel.uncertain')}</h4>
          <FileTree items={uncertain} selected={selected} onPick={pick} meta={fileMeta} />
        </section>
      )}
    </>
  )
}

/** Uma entrada recolhida (turno ou intervalo): os arquivos só são buscados ao abrir. */
function Entry({ label, action, children }: { label: string; action?: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="undo-entry">
      <div className="undo-entry__head">
        <button type="button" className="undo-entry__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {label}
        </button>
        {action}
      </div>
      {open && children()}
    </div>
  )
}

/**
 * Desfazer (ou Refazer, se o último desfazer não foi refeito) de um turno das
 * listas "Fora da conversa atual" e "Feito no terminal interativo", como na
 * linha do turno: só com ponto de restauração e mudança dentro do projeto; o
 * retrato atrasado fica desligado.
 */
function TurnAction({ turn, onUndo }: { turn: TurnDto; onUndo(request: UndoRequest): void }) {
  const { t } = useTranslation()
  const s = turn.summary
  if ((turn.state !== 'ok' && turn.state !== 'late') || !s || s.files + s.uncertain === 0) return null
  if (turn.lastRun && !turn.lastRun.redone) {
    const runId = turn.lastRun.id
    return (
      <button type="button" className="undo-entry__action" onClick={() => onUndo({ redoRunId: runId })}>
        {t('undo.line.redo')}
      </button>
    )
  }
  const late = turn.state === 'late'
  return (
    <button type="button" className="undo-entry__action" disabled={late} title={late ? t('undo.line.lateTitle') : undefined}
            onClick={() => onUndo({ turnIds: [turn.id] })}>
      {t('undo.line.undo')}
    </button>
  )
}

function ListSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="undo-section" data-section={id}>
      <h4 className="undo-section__title">{title}</h4>
      {children}
    </section>
  )
}

// ── Lado direito ──

function DeclaredView({ change }: { change: DeclaredChange }) {
  const { t } = useTranslation()
  const patch = useMemo<FileDiff | null>(
    () => (change.kind === 'patch' ? { path: change.path, binary: false, text: change.diff ?? '', truncated: false } : null),
    [change],
  )
  if (change.kind === 'edit') return <>{(change.pairs ?? []).map((p, i) => <DiffView key={i} oldText={p.old} newText={p.new} />)}</>
  if (patch) return <UnifiedDiff diff={patch} />
  if (change.kind === 'written') return <p className="undo-diff__note">{t('undo.diff.written')}</p>
  return <p className="undo-diff__note">{t('undo.diff.pathOnly')}</p>
}

function notUndoableText(f: AttributedFile, t: TFunction): string {
  if (f.status === 'too_big') return f.size !== undefined ? t('undo.diff.tooBig', { size: fmtSize(f.size) }) : t('undo.diff.tooBigNoSize')
  if (f.status === 'unsnapshotted') return t('undo.diff.unsnapshotted')
  return t('undo.diff.submodule')
}

/**
 * O painel de mudanças do terminal: à esquerda as seções com a árvore de
 * arquivos, à direita o diff do arquivo clicado, buscado na hora. Modal
 * simples, sem animação nem desfoque (sem GPU). Com `declared` (pasta sem
 * git) não há rede: os trechos das ferramentas vão direto para o diff.
 */
export function ChangesPanel({ localId, focus, onClose, onUndo }: {
  localId: string
  focus: PanelFocus
  onClose(): void
  /** Desfazer/Refazer dos turnos fora da conversa atual e do terminal interativo. */
  onUndo?(request: UndoRequest): void
}) {
  const { t, i18n } = useTranslation()
  const entry = useUndoStore((s) => s.byLocal[localId])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [diff, setDiff] = useState<Loaded<FileDiff> | null>(null)
  const seq = useRef(0)
  useEffect(() => () => { seq.current++ }, [])

  const dialogRef = useRef<HTMLDivElement>(null)
  const onKeyDown = useDialogKeys(dialogRef, onClose)

  const pickFile = useCallback((source: Source, file: AttributedFile) => {
    setPicked({ kind: 'file', source, file })
    const n = ++seq.current
    if (NO_DIFF.has(file.status)) { setDiff(null); return }
    setDiff({ status: 'loading' })
    const req = source.kind === 'turn'
      ? fetchTurnDiff(source.turnId, file.path)
      : fetchIntervalDiff(localId, source.from, source.to, file.path)
    req.then(
      (data) => { if (seq.current === n) setDiff({ status: 'ok', data }) },
      (e) => { if (seq.current === n) setDiff({ status: 'error', message: errMessage(e) }) },
    )
  }, [localId])
  const pickDeclared = useCallback((change: DeclaredChange) => { seq.current++; setDiff(null); setPicked({ kind: 'declared', change }) }, [])

  const lng = i18n.language
  const turnLabel = (turn: TurnDto) => t('undo.panel.turnEntry', { id: turn.id, at: fmtTime(turn.endedAt ?? turn.startedAt, lng) })
  const turnEntries = (turns: TurnDto[]) => turns.map((turn) => (
    <Entry key={turn.id} label={turnLabel(turn)} action={onUndo && <TurnAction turn={turn} onUndo={onUndo} />}>
      {() => <SourceFiles localId={localId} source={{ kind: 'turn', turnId: turn.id }} picked={picked} onPick={pickFile} />}
    </Entry>
  ))

  let left: ReactNode
  if ('declared' in focus) {
    left = (
      <section className="undo-section" data-section="declared">
        <h4 className="undo-section__title">{t('undo.panel.declared')}</h4>
        <p className="undo-section__msg">{t('undo.line.noGit')}</p>
        <FileTree items={focus.declared} selected={picked?.kind === 'declared' ? picked.change.path : null}
                  onPick={pickDeclared} meta={() => null} />
      </section>
    )
  } else {
    const focusSource: Source = 'turnId' in focus
      ? { kind: 'turn', turnId: focus.turnId }
      : { kind: 'interval', from: focus.interval.from, to: focus.interval.to }
    const focusTurn = 'turnId' in focus ? focus.turnId : null
    const isFocusInterval = (iv: { from: number; to: number }) =>
      'interval' in focus && focus.interval.from === iv.from && focus.interval.to === iv.to
    const outside = (entry?.outside ?? []).filter((x) => x.id !== focusTurn)
    const interactive = (entry?.interactive ?? []).filter((x) => x.id !== focusTurn)
    const intervals = (entry?.intervals ?? []).filter((iv) => !isFocusInterval(iv))
    const between = intervals.filter((iv) => iv.kind === 'between')
    const undone = intervals.filter((iv) => iv.kind === 'undo')
    const intervalEntries = (list: typeof intervals) => list.map((iv) => (
      <Entry key={`${iv.from}-${iv.to}`} label={t('undo.panel.intervalEntry', { at: fmtTime(iv.at, lng) })}>
        {() => <SourceFiles localId={localId} source={{ kind: 'interval', from: iv.from, to: iv.to }} picked={picked} onPick={pickFile} />}
      </Entry>
    ))
    left = (
      <>
        <SourceFiles localId={localId} source={focusSource} picked={picked} onPick={pickFile}
                     title={focusSource.kind === 'turn' ? t('undo.panel.thisTurn') : t('undo.panel.thisInterval')} />
        {outside.length > 0 && <ListSection id="outside" title={t('undo.panel.outsideConversation')}>{turnEntries(outside)}</ListSection>}
        {between.length > 0 && <ListSection id="between" title={t('undo.panel.between')}>{intervalEntries(between)}</ListSection>}
        {undone.length > 0 && <ListSection id="undone" title={t('undo.panel.undone')}>{intervalEntries(undone)}</ListSection>}
        {interactive.length > 0 && <ListSection id="interactive" title={t('undo.panel.interactive')}>{turnEntries(interactive)}</ListSection>}
      </>
    )
  }

  let right: ReactNode
  if (!picked) right = <p className="undo-panel__hint">{t('undo.panel.pickFile')}</p>
  else if (picked.kind === 'declared') {
    right = (
      <>
        <p className="undo-panel__path">{picked.change.path}</p>
        <DeclaredView change={picked.change} />
      </>
    )
  } else {
    const f = picked.file
    let content: ReactNode
    if (NO_DIFF.has(f.status)) content = <p className="undo-diff__note">{notUndoableText(f, t)}</p>
    else if (!diff || diff.status === 'loading') content = <p className="undo-panel__hint">{t('undo.panel.loading')}</p>
    else if (diff.status === 'error') content = <p className="undo-panel__hint">{t('undo.panel.loadFailed', { message: diff.message })}</p>
    else content = <UnifiedDiff diff={diff.data} />
    right = (
      <>
        <p className="undo-panel__path">{f.path}</p>
        {content}
      </>
    )
  }

  return createPortal(
    <div className="undo-panel-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="undo-panel" role="dialog" aria-modal="true" aria-label={t('undo.panel.title')}
           ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="undo-panel__head">
          <h3>{t('undo.panel.title')}</h3>
          <button type="button" className="ghost undo-panel__close" aria-label={t('common.close')} onClick={onClose}>×</button>
        </header>
        <div className="undo-panel__body">
          <nav className="undo-panel__left">{left}</nav>
          <div className="undo-panel__right">{right}</div>
        </div>
        <footer className="undo-panel__help">{t('undo.panel.help')}</footer>
      </div>
    </div>,
    document.body,
  )
}
