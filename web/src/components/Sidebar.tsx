import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project, SessionInfo } from '../types'
import { createSector, deleteGroup, deleteSector, fetchGroups, fetchProjects, fetchSectors, putSidebarOrder, updateGroup, updateSector, type Group, type SidebarEntry } from '../api'
import { useStore } from '../store'
import { displayStatusKey, dotClassOf, isWaitingForYou, liveSessionsOf, primarySessionOf, startOrReviveEngine, unreadOf } from '../engineSession'
import { buildEntries, entryKey, filterEntries, moveEntry, moveInto, projectsOf, type Entry } from '../sidebarEntries'
import { NewProjectModal } from './NewProjectModal'
import { StartSessionModal } from './StartSessionModal'
import { EngineIcon } from './EngineIcon'
import { EnginePickerMenu } from './EnginePickerMenu'
import { LanguageSwitcher } from './LanguageSwitcher'
import { UsageCard } from './UsageCard'
import { InteractionInfo } from './InteractionInfo'
import { UserMenu } from './UserMenu'
import { IconPicker } from './IconPicker'
import { ColorField } from './ColorField'
import { AppearancePanel } from './AppearancePanel'
import { Icon } from './Icon'
import { AgentFace, faceStateOf } from './AgentFace'
import { MoreIcon } from './MenuIcons'
import { TerminalMenu } from './TerminalMenu'

// Grupos colapsados (estado de VISÃO): por navegador, sobrevive ao reload.
const COLLAPSED_KEY = 'claudinei:collapsedGroups'
const loadCollapsed = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch { return [] }
}

// Setores colapsados: chave própria porque ids de setor e de grupo são independentes
// — compartilhar a lista faria um grupo #3 colapsar o setor #3 junto.
const COLLAPSED_SECTORS_KEY = 'claudinei:collapsedSectors'
const loadCollapsedSectors = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_SECTORS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch { return [] }
}

// Cartões de terminal colapsados: um cartão colapsado vira uma linha só. Chave
// própria pelo mesmo motivo das outras — ids de projeto, grupo e setor são
// independentes entre si.
const COLLAPSED_CARDS_KEY = 'claudinei:collapsedCards'
const loadCollapsedCards = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch { return [] }
}

// Filtro "somente ativos" (estado de VISÃO, como o de grupos colapsados): esconde
// terminais e grupos sem agente de pé. Não toca em nada no servidor.
const ACTIVE_ONLY_KEY = 'claudinei:activeOnly'
const loadActiveOnly = (): boolean => {
  try { return localStorage.getItem(ACTIVE_ONLY_KEY) === '1' } catch { return false }
}


// O que está sendo arrastado (card de terminal, cabeçalho de grupo ou de setor).
type Drag = { kind: 'project' | 'group' | 'sector'; id: number }
const DRAG_PREFIX = { project: 'p', group: 'g', sector: 's' } as const
const dragKeyOf = (d: Drag) => `${DRAG_PREFIX[d.kind]}-${d.id}`

export function Sidebar() {
  const { t } = useTranslation()
  const { projects, sessions, unread, activeLocalId, view, engines, groups, sectors, schedules, openSession, openDashboard, openBoard, openTasks, setProjects, setGroups, setSectors } = useStore()
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
  const [menuFor, setMenuFor] = useState<{ p: Project; x: number; y: number } | null>(null)
  const [reviveFor, setReviveFor] = useState<{ s: SessionInfo; x: number; y: number } | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [showAppearance, setShowAppearance] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null) // entrada/card alvo (inserir ANTES)
  // Contêiner realçado sob o cursor: 'root', 'g-N' ou 's-N'.
  const [dragOverBox, setDragOverBox] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<number[]>(loadCollapsed)
  const [collapsedSectors, setCollapsedSectors] = useState<number[]>(loadCollapsedSectors)
  const [collapsedCards, setCollapsedCards] = useState<number[]>(loadCollapsedCards)
  // Editor de contêiner (grupo OU setor): mesma anatomia, um discriminador só.
  const [groupMenuFor, setGroupMenuFor] = useState<{ kind: 'group' | 'sector'; id: number; name: string; x: number; y: number } | null>(null)
  const [newSectorAt, setNewSectorAt] = useState<{ x: number; y: number } | null>(null)
  const [newSectorName, setNewSectorName] = useState('')
  const [groupRename, setGroupRename] = useState('')
  const [groupIcon, setGroupIcon] = useState('🗂️')
  const [groupColor, setGroupColor] = useState('#7c5cff')
  const [showGroupEmoji, setShowGroupEmoji] = useState(false)
  const [activeOnly, setActiveOnly] = useState(loadActiveOnly)
  const toggleActiveOnly = () => {
    setActiveOnly((cur) => {
      try { localStorage.setItem(ACTIVE_ONLY_KEY, cur ? '0' : '1') } catch { /* só não persiste */ }
      return !cur
    })
  }

  // A sessão "cara do projeto" no card: prioridade de status (needs_attention >
  // working > starting > in_terminal > idle > paradas); empate → mais recente.
  const sessionOf = (projectId: number): SessionInfo | undefined => primarySessionOf(projectId, sessions)

  // Árvore na ordem visual (setores, grupos e soltos pelo sortOrder unificado).
  const entries: Entry[] = buildEntries(projects, groups, sectors)

  // Arrastar com a lista filtrada corromperia a ordem: applySidebarOrder (backend) só
  // atualiza as entradas RECEBIDAS, com sort_order recomeçando do zero — os escondidos
  // manteriam valores antigos que colidem com esses, e a ordem apareceria embaralhada
  // ao desligar o filtro. Enquanto filtra, não arrasta.
  const canDrag = isAdmin && !activeOnly
  // O terminal ABERTO agora continua visível mesmo parado — mesma condição que acende
  // o card como `active`. Fora do chat/terminal não há pin: o activeLocalId sobrevive
  // à navegação, e um terminal visitado uma vez ficaria pinado para sempre.
  const pinnedLocalId = view === 'chat' || view === 'terminal' ? activeLocalId : undefined
  // Só a VISÃO é filtrada: `entries` (completo) segue sendo a base do applyOrder.
  const visibleEntries = activeOnly ? filterEntries(entries, sessions, pinnedLocalId) : entries

  const toggleGroup = (id: number) => {
    setCollapsed((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)) } catch { /* só não persiste */ }
      return next
    })
  }

  const toggleSector = (id: number) => {
    setCollapsedSectors((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(COLLAPSED_SECTORS_KEY, JSON.stringify(next)) } catch { /* só não persiste */ }
      return next
    })
  }

  const toggleCard = (id: number) => {
    setCollapsedCards((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify(next)) } catch { /* só não persiste */ }
      return next
    })
  }

  /**
   * Recolher/expandir age nos TRÊS níveis de uma vez — setores, grupos e cartões.
   * Meio-termo (recolher só os grupos) deixaria a tela num estado que o operador
   * não pediu e teria de desfazer à mão.
   */
  const collapseAll = (collapse: boolean) => {
    const persist = (key: string, value: number[]) => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* só não persiste */ }
      return value
    }
    setCollapsed(persist(COLLAPSED_KEY, collapse ? groups.map((g) => g.id) : []))
    setCollapsedSectors(persist(COLLAPSED_SECTORS_KEY, collapse ? sectors.map((x) => x.id) : []))
    setCollapsedCards(persist(COLLAPSED_CARDS_KEY, collapse ? projects.map((p) => p.id) : []))
  }

  const refetchAll = async () => {
    setProjects(await fetchProjects())
    setGroups(await fetchGroups())
    setSectors(await fetchSectors())
  }

  const clearDrag = () => { setDrag(null); setOverKey(null); setDragOverBox(null) }

  // Persiste a nova ordem/estrutura completa e sincroniza o store com a resposta.
  // A estrutura enviada É o pertencimento: o backend deriva setor/grupo dela.
  const toApi = (e: Entry): SidebarEntry =>
    e.kind === 'sector'
      ? { kind: 'sector', id: e.s.id, children: e.children.map(toApi) as Extract<SidebarEntry, { kind: 'sector' }>['children'] }
      : e.kind === 'group'
        ? { kind: 'group', id: e.g.id, children: e.items.map((p) => p.id) }
        : { kind: 'project', id: e.p.id }

  const applyOrder = async (next: Entry[]) => {
    try {
      const res = await putSidebarOrder(next.map(toApi))
      setProjects(res.projects)
      setGroups(res.groups)
      setSectors(res.sectors)
    } catch {
      // fallback: ressincroniza do servidor; se ATÉ o refetch falhar (rede fora),
      // só loga — deixar estourar viraria unhandled rejection nos handlers `void`.
      try { await refetchAll() } catch (err) { console.error('[sidebar] refetch após falha de ordenação falhou', err) }
    }
  }

  // Solta na POSIÇÃO do alvo (null = fim da lista). A árvore inteira é recalculada
  // em sidebarEntries — aqui só resta persistir o resultado.
  const dropAt = async (targetKey: string | null) => {
    const d = drag
    clearDrag()
    if (!d) return
    const next = moveEntry(entries, dragKeyOf(d), targetKey)
    if (next !== entries) await applyOrder(next)
  }

  // Solta DENTRO de um contêiner (grupo ou setor): entra no fim dele.
  const dropInto = async (container: string) => {
    const d = drag
    clearDrag()
    if (!d) return
    const next = moveInto(entries, dragKeyOf(d), container)
    if (next !== entries) await applyOrder(next)
  }

  // Soltar no cabeçalho "Terminais": tira de grupo/setor e manda para o topo da raiz.
  const dropOnRoot = async () => {
    await dropAt(entries.length ? entryKey(entries[0]) : null)
  }

  const createSectorNamed = async () => {
    const name = newSectorName.trim()
    if (!name) return
    setNewSectorAt(null); setNewSectorName('')
    try { await createSector(name); await refetchAll() } catch { /* mantém como está */ }
  }

  /**
   * O que o ⏱ do cartão precisa dizer: quantos agendamentos ATIVOS o terminal tem
   * (pausado não age, então não conta), quando é o próximo e se algum vem falhando
   * seguido — cron quebrado que ninguém percebe é o modo clássico de falhar aqui.
   */
  const schedulesOf = (projectId: number) => {
    const active = schedules.filter((s) => s.projectId === projectId && s.enabled)
    if (active.length === 0) return null
    const next = active
      .map((s) => s.nextRunAt)
      .filter((d): d is string => !!d)
      .sort()[0]
    // Uma falha isolada pode ser um tropeço da vez; duas seguidas é o agendamento quebrado.
    return { count: active.length, next, failing: active.some((s) => s.consecutiveFailures >= 2) }
  }

  const renderCard = (p: Project) => {
    const s = sessionOf(p.id)
    const live = liveSessionsOf(p.id, sessions)
    const active = !!s && s.localId === activeLocalId && (view === 'chat' || view === 'terminal')
    const canOpen = !!s && s.status !== 'stopped' && s.status !== 'dead'
    const revivable = !!s && (s.status === 'stopped' || s.status === 'dead')
    const badge = unreadOf(p.id, sessions, unread)
    // Qualquer engine viva esperando acende o chamado: olhar só a sessão principal
    // perderia o caso, porque in_terminal+waiting perde de working na prioridade.
    const waiting = live.some(isWaitingForYou)
    const isCollapsed = collapsedCards.includes(p.id)
    const key = `p-${p.id}`

    /**
     * Iniciar/reviver é a ÚNICA ação de um cartão sem sessão viva. Ela morava na
     * linha de status, que o modo compacto esconde — então precisa acompanhar o
     * cartão quando ele encolhe, e não ser recriada em dois lugares.
     */
    const playButton = revivable ? (
      <button className="term-card__action term-card__action--play" title={t('sidebar.revive')}
              onClick={(e) => {
                e.stopPropagation()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setReviveFor({ s: s!, x: r.left, y: r.bottom + 4 })
              }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5Z" /></svg>
      </button>
    ) : !s ? (
      <button className="term-card__action term-card__action--play" title={t('sidebar.startSession')}
              onClick={(e) => { e.stopPropagation(); setStartFor(p) }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L7.52 3.64A1 1 0 0 0 6 4.5Z" /></svg>
      </button>
    ) : null
    return (
      <div
        key={p.id}
        data-testid="term-card"
        className={[
          'term-card',
          isCollapsed ? 'collapsed' : '',
          waiting ? 'waiting' : '',
          active ? 'active' : '',
          drag?.kind === 'project' && drag.id === p.id ? 'dragging' : '',
          overKey === key && drag !== null && !(drag.kind === 'project' && drag.id === p.id) ? 'drop-target' : '',
        ].filter(Boolean).join(' ')}
        style={{ ['--term-color' as string]: p.color }}
        draggable={canDrag}
        onDragStart={() => setDrag({ kind: 'project', id: p.id })}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOverKey(key) }}
        onDragEnd={clearDrag}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropAt(key) }}
        onClick={() => {
          if (!s || !canOpen) return
          if (s.status === 'in_terminal') openTerminal(s.localId)
          else openSession(s.localId)
        }}
      >
        <div className="term-card__title">
          <AgentFace state={faceStateOf(s)} size={20}
                     title={s ? t(`status.${displayStatusKey(s)}` as 'status.in_terminal') : t('sidebar.noSession')} />
          <Icon className="term-card__icon" value={p.icon} size={15} />
          <span className="term-card__name">{p.name}</span>
          {/* Colapsado, a bolinha sobe para a linha do nome: o modo compacto não
              pode virar um jeito de perder o aviso de "esperando você". */}
          {isCollapsed && live.length > 1 && (
            <span className="term-card__dots">
              {live.map((ls) => (
                <span key={ls.localId} className={dotClassOf(ls)}
                      title={`${engineOf(ls)?.label ?? ls.engine} · ${t(`status.${displayStatusKey(ls)}` as 'status.in_terminal')}`} />
              ))}
            </span>
          )}
          {isCollapsed && playButton}
          {(() => {
            const sch = schedulesOf(p.id)
            if (!sch) return null
            return (
              <span
                data-testid="schedule-badge"
                className={`term-card__sched ${sch.failing ? 'failing' : ''}`}
                title={[
                  t('sidebar.scheduleCount', { count: sch.count }),
                  sch.next ? t('sidebar.scheduleNext', { when: new Date(sch.next).toLocaleString() }) : '',
                  sch.failing ? t('sidebar.scheduleFailing') : '',
                ].filter(Boolean).join(' · ')}
              >
                ⏱{sch.count > 1 ? sch.count : ''}
              </span>
            )
          })()}
          {badge > 0 && <span className="badge">{badge}</span>}
          <button className="term-card__action term-card__action--reveal term-card__caret"
                  title={isCollapsed ? t('sidebar.expandCard') : t('sidebar.collapseCard')}
                  onClick={(e) => { e.stopPropagation(); toggleCard(p.id) }}>
            {isCollapsed ? '⌄' : '⌃'}
          </button>
          {isAdmin && (
            <button className="term-card__action term-card__action--reveal term-card__gear" title={t('sidebar.options')}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenuFor({
                        p,
                        x: Math.max(8, Math.min(r.left, window.innerWidth - 210)),
                        y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 360)),
                      })
                    }}>
              <MoreIcon size={13} />
            </button>
          )}
        </div>
        {!isCollapsed && <div className="term-card__status">
          {s ? (
            <>
              {/* Uma bolinha por engine VIVA (Claude + Codex + Kimi juntos aparecem
                  todas); com uma só, é exatamente a bolinha de sempre. O texto e o
                  ícone ao lado seguem descrevendo a sessão principal. */}
              {/* Duas engines vivas são dois estados, e um rosto só não dá conta:
                  aí as bolinhas voltam. Com uma só, elas repetiriam o rosto. */}
              {live.length > 1 && (
                <span className="term-card__dots">
                  {live.map((ls) => (
                    <span
                      key={ls.localId}
                      className={dotClassOf(ls)}
                      title={`${engineOf(ls)?.label ?? ls.engine} · ${t(`status.${displayStatusKey(ls)}` as 'status.in_terminal')}`}
                    />
                  ))}
                </span>
              )}
              {engineOf(s) && (
                <EngineIcon className="engine-badge" title={engineOf(s)!.label} icon={engineOf(s)!.icon} />
              )}
              <span>{t(`status.${displayStatusKey(s)}` as 'status.in_terminal')}</span>
            </>
          ) : (
            <><span className="status-dot status-none" /><span>{t('sidebar.noSession')}</span></>
          )}
          {playButton}
        </div>}
      </div>
    )
  }

  /** Algum destes terminais espera por você? (usado pelos cabeçalhos fechados) */
  const anyWaiting = (list: Project[]) =>
    list.some((p) => liveSessionsOf(p.id, sessions).some(isWaitingForYou))

  const renderGroup = (g: Group, items: Project[]) => {
    // Grupo vazio só aparece pra admin (é quem pode arrastar algo pra dentro).
    if (items.length === 0 && !isAdmin) return null
    const isCollapsed = collapsed.includes(g.id)
    const badgeSum = items.reduce((acc, p) => acc + unreadOf(p.id, sessions, unread), 0)
    const key = `g-${g.id}`
    // Com o filtro ligado, `items` só tem os ativos — o total real vem do store. O
    // contador vira "3/8" para não parecer que os outros sumiram do grupo.
    const total = projects.filter((p) => p.groupId === g.id).length
    return (
      <div
        key={key}
        data-testid="term-group"
        style={{ ['--group-color' as string]: g.color ?? 'var(--glass-border)' }}
        className={[
          'term-group',
          drag?.kind === 'group' && drag.id === g.id ? 'dragging' : '',
          (dragOverBox === key || overKey === key) && drag !== null && !(drag.kind === 'group' && drag.id === g.id) ? 'drop-target' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); e.stopPropagation(); setDragOverBox(key) } }}
        onDragLeave={() => setDragOverBox((cur) => (cur === key ? null : cur))}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropInto(key) }}
      >
        <div
          // Fechado, o cabeçalho herda o chamado dos filhos escondidos — aberto não,
          // que aí o próprio cartão já grita e dobrar o sinal só faria ruído.
          className={`term-group__header ${isCollapsed && anyWaiting(items) ? 'waiting' : ''}`}
          draggable={canDrag}
          onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'group', id: g.id }) }}
          onDragEnd={clearDrag}
          onClick={() => toggleGroup(g.id)}
        >
          <svg className={`term-group__caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <Icon className="term-group__icon" value={g.icon ?? '🗂️'} size={14} />
          <span className="term-group__name">{g.name}</span>
          <span className="term-group__count">{activeOnly ? `${items.length}/${total}` : total}</span>
          {badgeSum > 0 && <span className="badge">{badgeSum}</span>}
          {isCollapsed && (
            <span className="term-group__dots">
              {items.slice(0, 6).map((p) => {
                const s = sessionOf(p.id)
                return <span key={p.id} className={s ? dotClassOf(s) : 'status-dot status-none'} title={p.name} />
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
                        kind: 'group', id: g.id, name: g.name,
                        x: Math.max(8, Math.min(r.left, window.innerWidth - 250)),
                        y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 320)),
                      })
                    }}>
              <MoreIcon />
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

  /**
   * Setor: mesma anatomia do grupo, um nível acima — só que os filhos podem ser
   * grupos OU terminais, então o corpo delega de volta para `renderEntry`.
   */
  const renderSector = (sec: Group, children: Array<Extract<Entry, { kind: 'group' | 'project' }>>) => {
    if (children.length === 0 && !isAdmin) return null
    const isCollapsed = collapsedSectors.includes(sec.id)
    const key = `s-${sec.id}`
    const shown = children.flatMap(projectsOf)
    // O total conta TUDO que está no setor, inclusive dentro dos grupos dele — um
    // setor marcando 0/9 com nove terminais em grupos confundiria mais que ajudaria.
    const full = entries.find((e): e is Extract<Entry, { kind: 'sector' }> => e.kind === 'sector' && e.s.id === sec.id)
    const total = full ? projectsOf(full).length : shown.length
    const badgeSum = shown.reduce((acc, p) => acc + unreadOf(p.id, sessions, unread), 0)
    return (
      <div
        key={key}
        data-testid="term-sector"
        style={{ ['--sector-color' as string]: sec.color ?? 'var(--glass-border)' }}
        className={[
          'term-sector',
          drag?.kind === 'sector' && drag.id === sec.id ? 'dragging' : '',
          (dragOverBox === key || overKey === key) && drag !== null && !(drag.kind === 'sector' && drag.id === sec.id) ? 'drop-target' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setDragOverBox(key) } }}
        onDragLeave={() => setDragOverBox((cur) => (cur === key ? null : cur))}
        onDrop={(e) => { e.preventDefault(); void dropInto(key) }}
      >
        <div
          className={`term-sector__header ${isCollapsed && anyWaiting(shown) ? 'waiting' : ''}`}
          draggable={canDrag}
          onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'sector', id: sec.id }) }}
          onDragEnd={clearDrag}
          onClick={() => toggleSector(sec.id)}
        >
          <svg className={`term-group__caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <Icon className="term-sector__icon" value={sec.icon ?? '🏢'} size={14} />
          <span className="term-sector__name">{sec.name}</span>
          <span className="term-group__count">{activeOnly ? `${shown.length}/${total}` : total}</span>
          {badgeSum > 0 && <span className="badge">{badgeSum}</span>}
          {isCollapsed && (
            <span className="term-group__dots">
              {shown.slice(0, 6).map((p) => {
                const ps = sessionOf(p.id)
                return <span key={p.id} className={ps ? dotClassOf(ps) : 'status-dot status-none'} title={p.name} />
              })}
            </span>
          )}
          {isAdmin && (
            <button className="term-group__gear" title={t('sidebar.options')}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setGroupRename(sec.name)
                      setGroupIcon(sec.icon ?? '🏢')
                      setGroupColor(sec.color ?? '#58c4dc')
                      setGroupMenuFor({
                        kind: 'sector', id: sec.id, name: sec.name,
                        x: Math.max(8, Math.min(r.left, window.innerWidth - 250)),
                        y: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 320)),
                      })
                    }}>
              <MoreIcon />
            </button>
          )}
        </div>
        {!isCollapsed && (
          <div className="term-sector__body">
            {children.map(renderEntry)}
            {children.length === 0 && <div className="term-group__empty">{t('sidebar.sectorEmpty')}</div>}
          </div>
        )}
      </div>
    )
  }

  const renderEntry = (e: Entry) =>
    e.kind === 'sector' ? renderSector(e.s, e.children) : e.kind === 'group' ? renderGroup(e.g, e.items) : renderCard(e.p)

  return (
    <div className="sidebar">
      <div className="sidebar__top">
        <div className="sidebar__logo" onClick={openDashboard} title={t('sidebar.overview')}>
          <span className="sidebar__logo-star">✳</span> Claudinei
        </div>
        <div className="sidebar__top-actions">
          <button className="sidebar__icon-btn" title={t('appearance.title')}
                  aria-label={t('appearance.title')} onClick={() => setShowAppearance(true)}>🎨</button>
          <UserMenu />
          <LanguageSwitcher />
        </div>
      </div>

      {/* O cabeçalho "Terminais" é a zona de drop do TOPO: terminal sai do grupo,
          grupo vai pra primeira posição. */}
      <div
        className={`term-header ${dragOverBox === 'root' && drag !== null ? 'drop-target' : ''}`}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setDragOverBox('root') } }}
        onDragLeave={() => setDragOverBox((cur) => (cur === 'root' ? null : cur))}
        onDrop={(e) => { e.preventDefault(); void dropOnRoot() }}
      >
        <span className="eyebrow">{t('sidebar.terminals')}</span>
        <label className="switch switch--sm term-header__filter" title={t('sidebar.activeOnlyHint')}>
          <input type="checkbox" checked={activeOnly} onChange={toggleActiveOnly} aria-label={t('sidebar.activeOnly')} />
          <span className="track" />
          <span className="thumb" />
        </label>
        <button className="ghost term-header__icon" title={t('sidebar.collapseAll')}
                onClick={() => collapseAll(true)}>⌃</button>
        <button className="ghost term-header__icon" title={t('sidebar.expandAll')}
                onClick={() => collapseAll(false)}>⌄</button>
        {isAdmin && (
          <button className="ghost term-header__icon" title={t('sidebar.newSector')}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setNewSectorName('')
                    setNewSectorAt({ x: Math.max(8, Math.min(r.left - 60, window.innerWidth - 250)), y: r.bottom + 4 })
                  }}>🏢<span className="term-header__plus">+</span></button>
        )}
        {isAdmin && (
          <button className="ghost term-header__add" title={t('sidebar.addTerminal')} onClick={() => setShowNew(true)}>
            +<span className="term-header__label"> Terminal</span>
          </button>
        )}
      </div>

      <div className="term-list">
        {visibleEntries.map(renderEntry)}
        {projects.length === 0 && (
          <div className="term-list__empty">{t('sidebar.empty')}</div>
        )}
        {/* Tem terminal, mas o filtro escondeu todos: o texto de "crie o primeiro"
            diria a coisa errada aqui. */}
        {projects.length > 0 && activeOnly && visibleEntries.length === 0 && (
          <div className="term-list__empty">{t('sidebar.emptyActive')}</div>
        )}
        {/* zona de drop do FIM da lista (mandar pro final) */}
        {drag !== null && (
          <div
            className={`term-list__endzone ${overKey === 'end' ? 'drop-target' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOverKey('end') }}
            onDragLeave={() => setOverKey((cur) => (cur === 'end' ? null : cur))}
            onDrop={(e) => { e.preventDefault(); void dropAt(null) }}
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

      {menuFor && (
        <TerminalMenu project={menuFor.p} x={menuFor.x} y={menuFor.y} onDone={() => setMenuFor(null)} />
      )}

      {groupMenuFor && createPortal(
        <div className="sess-pop__overlay" onClick={() => setGroupMenuFor(null)}>
          <div className="sess-pop glass" style={{ left: groupMenuFor.x, top: groupMenuFor.y, minWidth: 235 }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__eyebrow">{t(groupMenuFor.kind === 'sector' ? 'sidebar.editSector' : 'sidebar.editGroup')}</div>
            <div className="sess-pop__newgroup">
              <button type="button" className="ghost group-edit__icon" title={t(groupMenuFor.kind === 'sector' ? 'sidebar.sectorIcon' : 'sidebar.groupIcon')}
                      onClick={() => setShowGroupEmoji(true)}><Icon value={groupIcon} size={16} /></button>
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
                const { kind, id } = groupMenuFor
                setGroupMenuFor(null)
                const patch = { name: groupRename.trim(), icon: groupIcon, color: groupColor }
                const save = kind === 'sector' ? updateSector(id, patch) : updateGroup(id, patch)
                void save.then(refetchAll).catch(() => {})
              }}>{t('common.save')}</button>
            </div>
            <div className="sess-pop__item" onClick={() => {
              const { kind, id } = groupMenuFor
              setGroupMenuFor(null)
              void (kind === 'sector' ? deleteSector(id) : deleteGroup(id)).then(refetchAll).catch(() => {})
            }}>
              <span>🗑</span><span>{t(groupMenuFor.kind === 'sector' ? 'sidebar.deleteSector' : 'sidebar.deleteGroup')}</span>
            </div>
            <div className="sess-pop__hint">{t(groupMenuFor.kind === 'sector' ? 'sidebar.deleteSectorHint' : 'sidebar.deleteGroupHint')}</div>
          </div>
        </div>,
        document.body,
      )}

      {newSectorAt && createPortal(
        <div className="sess-pop__overlay" onClick={() => setNewSectorAt(null)}>
          <div className="sess-pop glass" style={{ left: newSectorAt.x, top: newSectorAt.y, minWidth: 230 }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__eyebrow">{t('sidebar.newSector')}</div>
            <div className="sess-pop__newgroup">
              <input
                autoFocus
                value={newSectorName}
                placeholder={t('sidebar.newSectorPlaceholder')}
                onChange={(e) => setNewSectorName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createSectorNamed() }}
              />
              <button title={t('sidebar.newSector')} disabled={!newSectorName.trim()} onClick={() => void createSectorNamed()}>＋</button>
            </div>
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
          <IconPicker value={groupIcon} onSelect={(e) => { setGroupIcon(e); setShowGroupEmoji(false) }} onClose={() => setShowGroupEmoji(false)} />
        </div>,
        document.body,
      )}
      {showAppearance && <AppearancePanel onClose={() => setShowAppearance(false)} />}
      {showInfo && <InteractionInfo onClose={() => setShowInfo(false)} />}
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
      {startFor && <StartSessionModal project={startFor} onClose={() => setStartFor(null)} />}
    </div>
  )
}
