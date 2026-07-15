import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project, SessionInfo } from '../types'
import { createGroup, deleteGroup, deleteProject, fetchGroups, fetchProjects, putSidebarOrder, setProjectGroup, updateGroup, type Group } from '../api'
import { useStore } from '../store'
import { primarySessionOf, startOrReviveEngine, unreadOf } from '../engineSession'
import { NewProjectModal } from './NewProjectModal'
import { StartSessionModal } from './StartSessionModal'
import { ConfirmDialog } from './ConfirmDialog'
import { EngineIcon } from './EngineIcon'
import { EnginePickerMenu } from './EnginePickerMenu'
import { LanguageSwitcher } from './LanguageSwitcher'
import { UsageCard } from './UsageCard'
import { InteractionInfo } from './InteractionInfo'
import { UserMenu } from './UserMenu'
import { InstallAppButton } from './InstallAppButton'
import { EmojiPicker } from './EmojiPicker'
import { ColorField } from './ColorField'

// Grupos colapsados (estado de VISÃO): por navegador, sobrevive ao reload.
const COLLAPSED_KEY = 'claudinei:collapsedGroups'
const loadCollapsed = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch { return [] }
}

// A sidebar é uma lista de ENTRADAS num espaço único de posições: um grupo (com os
// filhos na ordem) ou um terminal solto — é o que permite arrastar um GRUPO para
// qualquer lugar entre os terminais.
type Entry =
  | { kind: 'group'; g: Group; items: Project[] }
  | { kind: 'project'; p: Project }

const entryKey = (e: Entry): string => (e.kind === 'group' ? `g-${e.g.id}` : `p-${e.p.id}`)
const entryOrder = (e: Entry): number => (e.kind === 'group' ? (e.g.sortOrder ?? 0) : (e.p.sortOrder ?? 0))

// O que está sendo arrastado (card de terminal ou cabeçalho de grupo).
type Drag = { kind: 'project'; id: number } | { kind: 'group'; id: number }

export function Sidebar() {
  const { t } = useTranslation()
  const { projects, sessions, unread, activeLocalId, view, engines, groups, openSession, openDashboard, openBoard, openTasks, setProjects, setGroups } = useStore()
  // Ícone da engine da sessão (badge ao lado do status) — distingue 1 Claude + 1
  // Codex no mesmo projeto. Não é um hook: `engines` já veio do useStore() acima
  // (subscrito), então isto é só uma busca simples, segura dentro do .map de cards.
  const engineOf = (s: SessionInfo | undefined) =>
    (s ? engines.find((e) => e.id === s.engine) : undefined) ?? engines.find((e) => e.id === 'claude') ?? engines[0]
  const openTerminal = useStore((s) => s.openTerminal)
  const me = useStore((s) => s.me)
  // Conveniência de UI: sem auth (me nulo) libera tudo. A autorização real
  // acontece no backend — isto NÃO é uma fronteira de segurança.
  const isAdmin = !me || me.isAdmin !== false
  const [showNew, setShowNew] = useState(false)
  const [startFor, setStartFor] = useState<Project | null>(null)
  const [editFor, setEditFor] = useState<Project | null>(null)
  const [deleteFor, setDeleteFor] = useState<Project | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [menuFor, setMenuFor] = useState<{ p: Project; x: number; y: number } | null>(null)
  const [reviveFor, setReviveFor] = useState<{ s: SessionInfo; x: number; y: number } | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null) // entrada/card alvo (inserir ANTES)
  const [dragOverGroup, setDragOverGroup] = useState<number | 'root' | null>(null)
  const [collapsed, setCollapsed] = useState<number[]>(loadCollapsed)
  const [groupMenuFor, setGroupMenuFor] = useState<{ id: number; name: string; x: number; y: number } | null>(null)
  const [groupRename, setGroupRename] = useState('')
  const [groupIcon, setGroupIcon] = useState('🗂️')
  const [groupColor, setGroupColor] = useState('#7c5cff')
  const [showGroupEmoji, setShowGroupEmoji] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')

  // A sessão "cara do projeto" no card: prioridade de status (needs_attention >
  // working > starting > in_terminal > idle > paradas); empate → mais recente.
  const sessionOf = (projectId: number): SessionInfo | undefined => primarySessionOf(projectId, sessions)

  // Entradas na ordem visual: grupos e soltos intercalados pelo sortOrder unificado.
  // Empate (dados de antes da ordenação unificada): grupos primeiro, depois por id.
  const entries: Entry[] = [
    ...groups.map((g): Entry => ({ kind: 'group', g, items: projects.filter((p) => p.groupId === g.id) })),
    ...projects
      .filter((p) => p.groupId == null || !groups.some((g) => g.id === p.groupId))
      .map((p): Entry => ({ kind: 'project', p })),
  ].sort((a, b) => {
    const d = entryOrder(a) - entryOrder(b)
    if (d !== 0) return d
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1
    return 0
  })

  const toggleGroup = (id: number) => {
    setCollapsed((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)) } catch { /* só não persiste */ }
      return next
    })
  }

  const refetchAll = async () => {
    setProjects(await fetchProjects())
    setGroups(await fetchGroups())
  }

  const clearDrag = () => { setDrag(null); setOverKey(null); setDragOverGroup(null) }

  // Persiste a nova ordem/estrutura completa e sincroniza o store com a resposta.
  const applyOrder = async (next: Entry[]) => {
    try {
      const res = await putSidebarOrder(next.map((e) =>
        e.kind === 'group'
          ? { kind: 'group' as const, id: e.g.id, children: e.items.map((p) => p.id) }
          : { kind: 'project' as const, id: e.p.id },
      ))
      setProjects(res.projects)
      setGroups(res.groups)
    } catch { await refetchAll() }
  }

  // Remove o item arrastado da estrutura (de onde estiver) e devolve [estrutura, item].
  const detach = (d: Drag): { rest: Entry[]; grabbed: Entry | null; project?: Project } => {
    if (d.kind === 'group') {
      const grabbed = entries.find((e) => e.kind === 'group' && e.g.id === d.id) ?? null
      return { rest: entries.filter((e) => e !== grabbed), grabbed }
    }
    const project = projects.find((p) => p.id === d.id)
    if (!project) return { rest: entries, grabbed: null }
    const rest = entries
      .filter((e) => !(e.kind === 'project' && e.p.id === d.id))
      .map((e) => (e.kind === 'group' ? { ...e, items: e.items.filter((p) => p.id !== d.id) } : e))
    return { rest, grabbed: { kind: 'project', p: project }, project }
  }

  // Solta o arrastado na posição do alvo. Vindo de CIMA insere DEPOIS do alvo,
  // vindo de baixo insere ANTES — é o que faz "soltar no vizinho" trocar de lugar
  // (inserir sempre-antes tornaria o gesto mais comum um no-op). Se o alvo é um
  // card DENTRO de um grupo e o arrastado é um terminal, ele entra no grupo ali.
  const dropBefore = async (targetKey: string | null) => {
    const d = drag
    clearDrag()
    if (!d) return
    const dKey = d.kind === 'group' ? `g-${d.id}` : `p-${d.id}`
    if (dKey === targetKey) return
    const { rest, grabbed, project } = detach(d)
    if (!grabbed) return

    // alvo dentro de um grupo? (card de terminal agrupado)
    if (d.kind === 'project' && project && targetKey?.startsWith('p-')) {
      const targetId = Number(targetKey.slice(2))
      const holder = rest.find((e): e is Entry & { kind: 'group' } => e.kind === 'group' && e.items.some((p) => p.id === targetId))
      if (holder) {
        const origHolder = entries.find((e): e is Entry & { kind: 'group' } => e.kind === 'group' && e.g.id === holder.g.id)
        const origFrom = origHolder?.items.findIndex((p) => p.id === d.id) ?? -1
        const origTo = origHolder?.items.findIndex((p) => p.id === targetId) ?? -1
        const idx = holder.items.findIndex((p) => p.id === targetId)
        const at = origFrom !== -1 && origFrom < origTo ? idx + 1 : idx
        const next = rest.map((e) => (e === holder ? { ...holder, items: [...holder.items.slice(0, at), project, ...holder.items.slice(at)] } : e))
        await applyOrder(next)
        return
      }
    }

    if (targetKey === null) { await applyOrder([...rest, grabbed]); return }
    const origFrom = entries.findIndex((e) => entryKey(e) === dKey)
    const origTo = entries.findIndex((e) => entryKey(e) === targetKey)
    const idx = rest.findIndex((e) => entryKey(e) === targetKey)
    const at = idx === -1 ? rest.length : origFrom !== -1 && origFrom < origTo ? idx + 1 : idx
    await applyOrder([...rest.slice(0, at), grabbed, ...rest.slice(at)])
  }

  // Solta um TERMINAL dentro de um grupo (área/cabeçalho do grupo) → entra no fim dele.
  // Um GRUPO solto sobre outro grupo → reposiciona ANTES dele.
  const dropOnGroup = async (groupId: number) => {
    const d = drag
    if (!d) { clearDrag(); return }
    if (d.kind === 'group') {
      if (d.id === groupId) { clearDrag(); return }
      await dropBefore(`g-${groupId}`)
      return
    }
    clearDrag()
    const { rest, project } = detach(d)
    if (!project) return
    const next = rest.map((e) => (e.kind === 'group' && e.g.id === groupId ? { ...e, items: [...e.items, project] } : e))
    await applyOrder(next)
  }

  // Soltar no cabeçalho "Terminais": terminal sai do grupo / grupo vai pro topo.
  const dropOnRoot = async () => {
    await dropBefore(entries.length ? entryKey(entries[0]) : null)
  }

  const onDelete = async () => {
    if (!deleteFor) return
    try {
      await deleteProject(deleteFor.id)
      setProjects(await fetchProjects())
      setDeleteFor(null)
    } catch (err) {
      setDeleteError((err as Error).message)
    }
  }

  const moveToGroup = async (p: Project, groupId: number | null) => {
    try { await setProjectGroup(p.id, groupId); await refetchAll() } catch { /* mantém como está */ }
  }

  const createGroupAndMove = async (p: Project) => {
    const name = newGroupName.trim()
    if (!name) return
    setMenuFor(null); setNewGroupName('')
    try {
      const g = await createGroup(name)
      await setProjectGroup(p.id, g.id)
      await refetchAll()
    } catch { /* mantém como está */ }
  }

  const renderCard = (p: Project) => {
    const s = sessionOf(p.id)
    const active = !!s && s.localId === activeLocalId && (view === 'chat' || view === 'terminal')
    const canOpen = !!s && s.status !== 'stopped' && s.status !== 'dead'
    const revivable = !!s && (s.status === 'stopped' || s.status === 'dead')
    const badge = unreadOf(p.id, sessions, unread)
    const key = `p-${p.id}`
    return (
      <div
        key={p.id}
        data-testid="term-card"
        className={[
          'term-card',
          active ? 'active' : '',
          drag?.kind === 'project' && drag.id === p.id ? 'dragging' : '',
          overKey === key && drag !== null && !(drag.kind === 'project' && drag.id === p.id) ? 'drop-target' : '',
        ].filter(Boolean).join(' ')}
        style={{ ['--term-color' as string]: p.color }}
        draggable={isAdmin}
        onDragStart={() => setDrag({ kind: 'project', id: p.id })}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOverKey(key) }}
        onDragEnd={clearDrag}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropBefore(key) }}
        onClick={() => {
          if (!s || !canOpen) return
          if (s.status === 'in_terminal') openTerminal(s.localId)
          else openSession(s.localId)
        }}
      >
        <div className="term-card__title">
          <span className="term-card__icon">{p.icon}</span>
          <span className="term-card__name">{p.name}</span>
          {badge > 0 && <span className="badge">{badge}</span>}
          {isAdmin && (
            <button className="term-card__action term-card__action--reveal" title={t('sidebar.options')}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setNewGroupName('')
                      setMenuFor({
                        p,
                        x: Math.max(8, Math.min(r.left, window.innerWidth - 210)),
                        y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 360)),
                      })
                    }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /></svg>
            </button>
          )}
        </div>
        <div className="term-card__status">
          {s ? (
            <>
              <span className={`status-dot status-${s.status}`} />
              {engineOf(s) && (
                <EngineIcon className="engine-badge" title={engineOf(s)!.label} icon={engineOf(s)!.icon} />
              )}
              <span>{t(`status.${s.status}` as const)}</span>
            </>
          ) : (
            <><span className="status-dot status-none" /><span>{t('sidebar.noSession')}</span></>
          )}
          {revivable && (
            <button className="term-card__action term-card__action--play" title={t('sidebar.revive')}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setReviveFor({ s: s!, x: r.left, y: r.bottom + 4 })
                    }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5Z" /></svg>
            </button>
          )}
          {!s && (
            <button className="term-card__action term-card__action--play" title={t('sidebar.startSession')}
                    onClick={(e) => { e.stopPropagation(); setStartFor(p) }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5Z" /></svg>
            </button>
          )}
        </div>
      </div>
    )
  }

  const renderGroup = (g: Group, items: Project[]) => {
    // Grupo vazio só aparece pra admin (é quem pode arrastar algo pra dentro).
    if (items.length === 0 && !isAdmin) return null
    const isCollapsed = collapsed.includes(g.id)
    const badgeSum = items.reduce((acc, p) => acc + unreadOf(p.id, sessions, unread), 0)
    const key = `g-${g.id}`
    return (
      <div
        key={key}
        data-testid="term-group"
        style={{ ['--group-color' as string]: g.color ?? 'var(--glass-border)' }}
        className={[
          'term-group',
          drag?.kind === 'group' && drag.id === g.id ? 'dragging' : '',
          (dragOverGroup === g.id || overKey === key) && drag !== null && !(drag.kind === 'group' && drag.id === g.id) ? 'drop-target' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setDragOverGroup(g.id) } }}
        onDragLeave={() => setDragOverGroup((cur) => (cur === g.id ? null : cur))}
        onDrop={(e) => { e.preventDefault(); void dropOnGroup(g.id) }}
      >
        <div
          className="term-group__header"
          draggable={isAdmin}
          onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'group', id: g.id }) }}
          onDragEnd={clearDrag}
          onClick={() => toggleGroup(g.id)}
        >
          <svg className={`term-group__caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <span className="term-group__icon">{g.icon ?? '🗂️'}</span>
          <span className="term-group__name">{g.name}</span>
          <span className="term-group__count">{items.length}</span>
          {badgeSum > 0 && <span className="badge">{badgeSum}</span>}
          {isCollapsed && (
            <span className="term-group__dots">
              {items.slice(0, 6).map((p) => {
                const s = sessionOf(p.id)
                return <span key={p.id} className={`status-dot status-${s?.status ?? 'none'}`} title={p.name} />
              })}
            </span>
          )}
          {isAdmin && (
            <button className="term-group__gear" title={t('sidebar.options')}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setGroupRename(g.name)
                      setGroupIcon(g.icon ?? '🗂️')
                      setGroupColor(g.color ?? '#7c5cff')
                      // clamp: o editor tem ~300px de altura e 235 de largura — não pode
                      // nascer estourando a borda de baixo/direita da janela
                      setGroupMenuFor({
                        id: g.id, name: g.name,
                        x: Math.max(8, Math.min(r.left, window.innerWidth - 250)),
                        y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 320)),
                      })
                    }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
            </button>
          )}
        </div>
        {!isCollapsed && (
          <div className="term-group__body">
            {items.map(renderCard)}
            {items.length === 0 && <div className="term-group__empty">{t('sidebar.groupEmpty')}</div>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar__top">
        <div className="sidebar__logo" onClick={openDashboard} title={t('sidebar.overview')}>
          <span className="sidebar__logo-star">✳</span> Claudinei
        </div>
        <div className="sidebar__top-actions">
          <InstallAppButton />
          <UserMenu />
          <LanguageSwitcher />
        </div>
      </div>

      {/* O cabeçalho "Terminais" é a zona de drop do TOPO: terminal sai do grupo,
          grupo vai pra primeira posição. */}
      <div
        className={`term-header ${dragOverGroup === 'root' && drag !== null ? 'drop-target' : ''}`}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setDragOverGroup('root') } }}
        onDragLeave={() => setDragOverGroup((cur) => (cur === 'root' ? null : cur))}
        onDrop={(e) => { e.preventDefault(); void dropOnRoot() }}
      >
        <span className="eyebrow">{t('sidebar.terminals')}</span>
        {isAdmin && <button className="ghost term-header__add" onClick={() => setShowNew(true)}>{t('sidebar.addTerminal')}</button>}
      </div>

      <div className="term-list">
        {entries.map((e) => (e.kind === 'group' ? renderGroup(e.g, e.items) : renderCard(e.p)))}
        {projects.length === 0 && (
          <div className="term-list__empty">{t('sidebar.empty')}</div>
        )}
        {/* zona de drop do FIM da lista (mandar pro final) */}
        {drag !== null && (
          <div
            className={`term-list__endzone ${overKey === 'end' ? 'drop-target' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOverKey('end') }}
            onDragLeave={() => setOverKey((cur) => (cur === 'end' ? null : cur))}
            onDrop={(e) => { e.preventDefault(); void dropBefore(null) }}
          />
        )}
      </div>

      {/* wrapper ancora o grupo no rodapé mesmo quando o UsageCard não renderiza */}
      <div className="sidebar__bottom">
        {isAdmin && <UsageCard />}
        <div className="sidebar__footer">
          <div className="sidebar__footer-head">
            <span className="eyebrow sidebar__footer-title">{t('sidebar.interaction')}</span>
            <button className="sidebar__info-btn" title={t('interactionInfo.title')}
                    aria-label={t('interactionInfo.title')} onClick={() => setShowInfo(true)}>
              ⓘ
            </button>
          </div>
          <div className="sidebar__footer-rows">
            <div className={`sidebar__footer-row ${view === 'board' ? 'active' : ''}`} onClick={openBoard}>
              <span>📌</span><span>{t('sidebar.board')}</span>
            </div>
            <div className={`sidebar__footer-row ${view === 'tasks' ? 'active' : ''}`} onClick={openTasks}>
              <span>🗂️</span><span>{t('sidebar.tasks')}</span>
            </div>
          </div>
        </div>
      </div>

      {menuFor && createPortal(
        <div className="sess-pop__overlay" onClick={() => setMenuFor(null)}>
          <div className="sess-pop glass" style={{ left: menuFor.x, top: menuFor.y, minWidth: 190 }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__item" onClick={() => { setEditFor(menuFor.p); setMenuFor(null) }}>
              <span>✏️</span><span>{t('sidebar.editTerminal')}</span>
            </div>
            <div className="sess-pop__item" onClick={() => { setDeleteError(''); setDeleteFor(menuFor.p); setMenuFor(null) }}>
              <span>🗑</span><span>{t('sidebar.deleteTerminal')}</span>
            </div>
            <div className="sess-pop__eyebrow">{t('sidebar.group')}</div>
            {groups.map((g) => (
              <div key={g.id} className="sess-pop__item" onClick={() => { const p = menuFor.p; setMenuFor(null); void moveToGroup(p, g.id) }}>
                <span>▣</span><span>{g.name}</span>
                {menuFor.p.groupId === g.id && <span className="sess-pop__check">✓</span>}
              </div>
            ))}
            {menuFor.p.groupId != null && (
              <div className="sess-pop__item" onClick={() => { const p = menuFor.p; setMenuFor(null); void moveToGroup(p, null) }}>
                <span>▢</span><span>{t('sidebar.noGroup')}</span>
              </div>
            )}
            <div className="sess-pop__newgroup">
              <input
                value={newGroupName}
                placeholder={t('sidebar.newGroupPlaceholder')}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createGroupAndMove(menuFor.p) }}
              />
              <button title={t('sidebar.newGroup')} disabled={!newGroupName.trim()} onClick={() => void createGroupAndMove(menuFor.p)}>＋</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {groupMenuFor && createPortal(
        <div className="sess-pop__overlay" onClick={() => setGroupMenuFor(null)}>
          <div className="sess-pop glass" style={{ left: groupMenuFor.x, top: groupMenuFor.y, minWidth: 235 }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__eyebrow">{t('sidebar.editGroup')}</div>
            <div className="sess-pop__newgroup">
              <button type="button" className="ghost group-edit__icon" title={t('sidebar.groupIcon')}
                      onClick={() => setShowGroupEmoji(true)}>{groupIcon}</button>
              <input
                value={groupRename}
                onChange={(e) => setGroupRename(e.target.value)}
              />
            </div>
            <div className="group-edit__color">
              <ColorField value={groupColor} onChange={setGroupColor} />
            </div>
            <div className="sess-pop__newgroup">
              <button style={{ flex: 1 }} disabled={!groupRename.trim()} onClick={() => {
                const { id } = groupMenuFor
                setGroupMenuFor(null)
                void updateGroup(id, { name: groupRename.trim(), icon: groupIcon, color: groupColor }).then(refetchAll).catch(() => {})
              }}>{t('common.save')}</button>
            </div>
            <div className="sess-pop__item" onClick={() => {
              const { id } = groupMenuFor
              setGroupMenuFor(null)
              void deleteGroup(id).then(refetchAll).catch(() => {})
            }}>
              <span>🗑</span><span>{t('sidebar.deleteGroup')}</span>
            </div>
            <div className="sess-pop__hint">{t('sidebar.deleteGroupHint')}</div>
          </div>
        </div>,
        document.body,
      )}

      {reviveFor && (
        <EnginePickerMenu
          engines={engines}
          x={reviveFor.x}
          y={reviveFor.y}
          onClose={() => setReviveFor(null)}
          onPick={(engineId) => {
            const { s } = reviveFor
            setReviveFor(null)
            void startOrReviveEngine(s.projectId, engineId, useStore.getState().sessions)
              .then((localId) => openSession(localId))
              .catch(() => {})
          }}
        />
      )}

      {showGroupEmoji && createPortal(
        // .overlay-above-popover: o editor do grupo vive num .sess-pop__overlay (z-60);
        // sem elevar o picker (z-50) acima dele, o backdrop invisível do popover
        // intercepta todo clique no emoji e fecha o editor.
        <div className="overlay-above-popover">
          <EmojiPicker onSelect={(e) => { setGroupIcon(e); setShowGroupEmoji(false) }} onClose={() => setShowGroupEmoji(false)} />
        </div>,
        document.body,
      )}
      {showInfo && <InteractionInfo onClose={() => setShowInfo(false)} />}
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
      {startFor && <StartSessionModal project={startFor} onClose={() => setStartFor(null)} />}
      {editFor && <NewProjectModal editProject={editFor} onClose={() => setEditFor(null)} />}
      {deleteFor && (
        <ConfirmDialog
          title={t('confirm.deleteTitle', { name: deleteFor.name })}
          message={t('confirm.deleteMsg')}
          confirmLabel={t('common.delete')}
          error={deleteError}
          onConfirm={onDelete}
          onClose={() => setDeleteFor(null)}
        />
      )}
    </div>
  )
}
