import { useShallow } from 'zustand/react/shallow'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project, SessionInfo } from '../types'
import { createScratchProject, deleteGroup, deleteSector, fetchGroups, fetchProjects, fetchSectors, putSidebarOrder, updateGroup, updateSector, type Group, type SidebarEntry } from '../api'
import { useStore } from '../store'
import { displayStatusKey, dotClassOf, isWaitingForYou, liveSessionsOf, primarySessionOf, startOrReviveEngine, unreadOf } from '../engineSession'
import { buildEntries, entryKey, filterEntries, moveEntry, moveInto, projectsOf, railRows, type Entry, type RailGuide } from '../sidebarEntries'
import { nextExpiry, splitSections, triageStateOf } from '../triageSections'
import { applyTriage } from '../triageActions'
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
import { InterruptedCardMarker } from './InterruptedNotice'
import { MoreIcon, GearIcon, StarIcon, SearchIcon, BoltIcon } from './MenuIcons'
import { TerminalMenu } from './TerminalMenu'
import { BrandMark } from './BrandMark'
import { WorkingStrip, WorkingRail } from './WorkingStrip'

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
/**
 * O pulso de sonar de quem espera por você.
 *
 * O véu âmbar sozinho era discreto demais: com meia dúzia de terminais na lista,
 * um contorno fino não chama ninguém. São DOIS anéis defasados — com um só, o
 * pulso teria um intervalo morto no meio de cada ciclo.
 *
 * Vive no cartão, e sobe para o grupo (e do grupo para o setor) quando o que
 * espera está escondido dentro de um contêiner fechado: o chamado tem que aparecer
 * onde alguém está olhando.
 */
/**
 * Os traços de profundidade. As pontas do trecho ficam arredondadas — é o que faz
 * o traço ler como um colchete que abre e fecha, em vez de um corte de linha
 * infinita.
 */
const RailGuides = ({ guides }: { guides: RailGuide[] }) => (
  <span className="rail-guide" aria-hidden="true">
    {guides.map((g, i) => (
      <i key={i} className={`${g.start ? 'is-start' : ''} ${g.end ? 'is-end' : ''}`}
         style={{ ['--c' as string]: g.color }} />
    ))}
  </span>
)

const Sonar = () => <span className="sonar" aria-hidden="true"><i /><i /></span>

const ACTIVE_ONLY_KEY = 'claudinei:activeOnly'
const loadActiveOnly = (): boolean => {
  try { return localStorage.getItem(ACTIVE_ONLY_KEY) === '1' } catch { return false }
}
// "Só fixados". A chave guarda o nome antigo ("favoritos") para não perder a
// escolha de quem já a tinha ligado.
const FAVORITES_ONLY_KEY = 'claudinei:favoritesOnly'
const loadFavoritesOnly = (): boolean => {
  try { return localStorage.getItem(FAVORITES_ONLY_KEY) === '1' } catch { return false }
}

// Seções da triagem recolhidas (estado de VISÃO). Adiados e Assentados nascem
// recolhidos: guardam o que o operador tirou da frente.
type TriageSection = 'pinned' | 'snoozed' | 'settled'
const TRIAGE_SECTIONS: readonly TriageSection[] = ['pinned', 'snoozed', 'settled']
const SECTION_LABEL = { pinned: 'sidebar.sectionPinned', snoozed: 'sidebar.sectionSnoozed', settled: 'sidebar.sectionSettled' } as const
const COLLAPSED_TRIAGE_KEY = 'claudinei:collapsedTriage'
const loadCollapsedTriage = (): TriageSection[] => {
  const byDefault: TriageSection[] = ['snoozed', 'settled']
  try {
    const raw = localStorage.getItem(COLLAPSED_TRIAGE_KEY)
    if (raw === null) return byDefault
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is TriageSection => TRIAGE_SECTIONS.includes(x)) : byDefault
  } catch { return byDefault }
}

// O maior atraso que o setTimeout aceita (~24,8 dias); acima disso ele dispara já.
const MAX_TIMER_MS = 2 ** 31 - 1


// O que está sendo arrastado (card de terminal, cabeçalho de grupo ou de setor).
type Drag = { kind: 'project' | 'group' | 'sector'; id: number }
const DRAG_PREFIX = { project: 'p', group: 'g', sector: 's' } as const
const dragKeyOf = (d: Drag) => `${DRAG_PREFIX[d.kind]}-${d.id}`

export function Sidebar() {
  const { t, i18n } = useTranslation()
  const { projects, sessions, unread, activeLocalId, view, engines, groups, sectors, schedules, openSession, openDashboard, openBoard, openTasks, setProjects, setGroups, setSectors } = useStore(useShallow((s) => ({ projects: s.projects, sessions: s.sessions, unread: s.unread, activeLocalId: s.activeLocalId, view: s.view, engines: s.engines, groups: s.groups, sectors: s.sectors, schedules: s.schedules, openSession: s.openSession, openDashboard: s.openDashboard, openBoard: s.openBoard, openTasks: s.openTasks, setProjects: s.setProjects, setGroups: s.setGroups, setSectors: s.setSectors })))
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
  const [groupRename, setGroupRename] = useState('')
  const [groupIcon, setGroupIcon] = useState('🗂️')
  const [groupError, setGroupError] = useState('')
  const [groupColor, setGroupColor] = useState('#7c5cff')
  const [showGroupEmoji, setShowGroupEmoji] = useState(false)
  const [activeOnly, setActiveOnly] = useState(loadActiveOnly)
  const [favoritesOnly, setFavoritesOnly] = useState(loadFavoritesOnly)
  // O aviso de falha de qualquer ação de triagem (⭐ ou menu), daqui ou do chat.
  const triageError = useStore((s) => s.triageError)
  // Busca pelo nome: estado TRANSITÓRIO, de propósito fora do localStorage. Uma
  // busca esquecida que voltasse no próximo carregamento faria a lista parecer
  // vazia sem motivo aparente.
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [scratchDraft, setScratchDraft] = useState<Pick<Project, 'name' | 'icon' | 'color'> | null>(null)
  const [pendingFavoriteIds, setPendingFavoriteIds] = useState<number[]>([])
  const railMode = useStore((s) => s.railMode)
  const toggleRail = useStore((s) => s.toggleRail)
  const triage = useStore((s) => s.triage)
  const setTriageItem = useStore((s) => s.setTriageItem)
  const [collapsedTriage, setCollapsedTriage] = useState<TriageSection[]>(loadCollapsedTriage)
  // Bate quando o relógio dos adiados dispara (ver o efeito abaixo).
  const [clock, setClock] = useState(0)
  const toggleActiveOnly = () => {
    setActiveOnly((cur) => {
      try { localStorage.setItem(ACTIVE_ONLY_KEY, cur ? '0' : '1') } catch { /* só não persiste */ }
      return !cur
    })
  }
  const toggleFavoritesOnly = () => {
    setFavoritesOnly((cur) => {
      try { localStorage.setItem(FAVORITES_ONLY_KEY, cur ? '0' : '1') } catch { /* só não persiste */ }
      return !cur
    })
  }
  /**
   * A ⭐ fixa e desafixa, para o usuário logado (triagem), pela mesma porta do
   * menu: muda na hora, entra no desfazer, e se o servidor recusar volta e o aviso
   * aparece. A estrela fica desabilitada enquanto o pedido não volta.
   */
  const togglePin = async (p: Project) => {
    const pinned = !useStore.getState().triage[p.id]?.pinned
    setPendingFavoriteIds((ids) => [...ids, p.id])
    try {
      // Fixar não marca como lido: não há o que mandar pelo WebSocket.
      await applyTriage(p.id, { pinned }, t(pinned ? 'triage.didPin' : 'triage.didUnpin', { name: p.name }), null)
    } finally {
      setPendingFavoriteIds((ids) => ids.filter((id) => id !== p.id))
    }
  }

  const toggleTriageSection = (id: TriageSection) => {
    setCollapsedTriage((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      try { localStorage.setItem(COLLAPSED_TRIAGE_KEY, JSON.stringify(next)) } catch { /* só não persiste */ }
      return next
    })
  }

  /**
   * O relógio dos adiados: UM setTimeout para o próximo vencimento, rearmado
   * quando a triagem muda — nada de intervalo batendo à toa. Ao vencer, o
   * `snoozedUntil` sai do store (o servidor já lê o vencido como não adiado), e
   * com isso a lateral e a faixa Trabalhando releem a triagem. O `clock` rearma
   * quando o disparo veio antes do vencimento (atraso maior que o do setTimeout).
   */
  useEffect(() => {
    const at = nextExpiry(triage, Date.now())
    if (at === null) return
    const id = setTimeout(() => {
      const now = Date.now()
      for (const item of Object.values(useStore.getState().triage)) {
        if (item.snoozedUntil !== null && Date.parse(item.snoozedUntil) <= now) setTriageItem({ ...item, snoozedUntil: null })
      }
      setClock((c) => c + 1)
    }, Math.min(at - Date.now(), MAX_TIMER_MS))
    return () => clearTimeout(id)
  }, [triage, clock, setTriageItem])

  /**
   * Terminal temporário: abre a escolha de engine/modelo com um RASCUNHO, sem criar
   * nada. Só ao iniciar a sessão o servidor reserva a pasta em ~/.claudinei/scratch
   * e cria o terminal — cancelar não deixa terminal nem pasta para trás.
   */
  const openScratch = () => {
    const now = new Date()
    const when = `${now.toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' })} ${now.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}`
    setScratchDraft({ name: t('sidebar.scratchName', { when }), icon: '🧪', color: '#7c5cff' })
  }

  const createScratch = async (name: string): Promise<Project> => {
    let created: Project
    try {
      created = await createScratchProject({ name })
    } catch (err) {
      throw new Error(t('sidebar.scratchError', { message: (err as Error).message }))
    }
    try {
      setProjects(await fetchProjects())
    } catch {
      // O terminal existe no servidor; sem a lista nova, ao menos ele entra nesta.
      setProjects([...useStore.getState().projects, created])
    }
    // Uma busca ligada esconderia o terminal que acabou de nascer.
    setQuery('')
    return created
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
  // A busca só vale com o campo à vista: na régua ela esconderia terminais sem que
  // nada na tela dissesse por quê.
  const searching = !railMode && query.trim() !== ''
  const filtering = activeOnly || favoritesOnly || searching
  const canDrag = isAdmin && !filtering
  // Só a VISÃO é filtrada: `entries` (completo) segue sendo a base do applyOrder.
  const visibleEntries = filtering ? filterEntries(entries, sessions, activeOnly, favoritesOnly, searching ? query : '', (id) => !!triage[id]?.pinned) : entries
  // As seções dependem só da triagem e da hora, nunca do status das sessões: um
  // cartão só muda de seção por ação do operador, por um adiamento que vence ou
  // por um assentado que o servidor acorda. A hora é lida a cada render; o relógio
  // acima garante um render quando um adiamento vence.
  const now = Date.now()
  const sections = splitSections(visibleEntries, triage, now)

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

  /** "volta às 15:00" hoje; "volta seg. 9:00" em outro dia (adiar vai no máximo até segunda). */
  const snoozeLabel = (until: string) => {
    const at = new Date(until)
    const time = at.toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' })
    return at.toDateString() === new Date(now).toDateString()
      ? t('sidebar.snoozedBackAt', { time })
      : t('sidebar.snoozedBackOn', { day: at.toLocaleDateString(i18n.language, { weekday: 'short' }), time })
  }

  /**
   * O cartão de terminal, o MESMO nas seções e na árvore (`key={p.id}`). Fora da
   * árvore (`where = 'section'`) ele não arrasta nem recebe arraste: a ordem dos
   * Fixados é a global, e soltar num deles mexeria numa posição que não se vê.
   */
  const renderCard = (p: Project, where: 'tree' | 'section' = 'tree') => {
    const inTree = where === 'tree'
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
    const pinned = !!triage[p.id]?.pinned
    const snoozedUntil = triageStateOf(triage[p.id], now) === 'snoozed' ? triage[p.id]!.snoozedUntil : null

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
        draggable={canDrag && inTree}
        onDragStart={inTree ? () => setDrag({ kind: 'project', id: p.id }) : undefined}
        onDragOver={inTree ? (e) => { e.preventDefault(); e.stopPropagation(); setOverKey(key) } : undefined}
        onDragEnd={inTree ? clearDrag : undefined}
        onDrop={inTree ? (e) => { e.preventDefault(); e.stopPropagation(); void dropAt(key) } : undefined}
        onClick={() => {
          if (!s || !canOpen) return
          if (s.status === 'in_terminal') openTerminal(s.localId)
          else openSession(s.localId)
        }}
      >
        {waiting && <Sonar />}
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
          <InterruptedCardMarker projectId={p.id} />
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
          <button className={`term-card__action term-card__favorite ${pinned ? 'is-favorite' : ''}`}
                  type="button" disabled={pendingFavoriteIds.includes(p.id)} aria-pressed={pinned}
                  aria-label={t(pinned ? 'sidebar.unpin' : 'sidebar.pin', { name: p.name })}
                  title={t(pinned ? 'sidebar.unpin' : 'sidebar.pin', { name: p.name })}
                  onClick={(e) => { e.stopPropagation(); void togglePin(p) }}>
            <StarIcon size={15} filled={pinned} />
          </button>
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
                        x: r.left,
                        y: r.bottom + 4,
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
        {snoozedUntil && <div className="term-card__snooze">{snoozeLabel(snoozedUntil)}</div>}
      </div>
    )
  }

  /** Algum destes terminais espera por você? (usado pelos cabeçalhos fechados) */
  const anyWaiting = (list: Project[]) =>
    list.some((p) => liveSessionsOf(p.id, sessions).some(isWaitingForYou))

  const renderGroup = (g: Group, items: Project[]) => {
    // Grupo vazio só aparece pra admin (é quem pode arrastar algo pra dentro).
    if (items.length === 0 && !isAdmin) return null
    // Buscando, o fechado abre: o resultado não pode ficar escondido num grupo
    // recolhido. Só a visão muda — o que está salvo volta ao limpar a busca.
    const isCollapsed = !searching && collapsed.includes(g.id)
    const badgeSum = items.reduce((acc, p) => acc + unreadOf(p.id, sessions, unread), 0)
    const key = `g-${g.id}`
    // Com filtros ligados, `items` só tem os terminais visíveis — o total real
    // vem do store. O contador vira "3/8" para não parecer que sumiram do grupo.
    // Vale também para quem foi para Fixados, Adiados ou Assentados.
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
          {isCollapsed && anyWaiting(items) && <Sonar />}
          <svg className={`term-group__caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <Icon className="term-group__icon" value={g.icon ?? '🗂️'} size={14} />
          <span className="term-group__name">{g.name}</span>
          <span className="term-group__count">{filtering || items.length !== total ? `${items.length}/${total}` : total}</span>
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
                      setGroupError('')
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
            {items.map((p) => renderCard(p))}
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
    const isCollapsed = !searching && collapsedSectors.includes(sec.id)
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
          {isCollapsed && anyWaiting(shown) && <Sonar />}
          <svg className={`term-group__caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <Icon className="term-sector__icon" value={sec.icon ?? '🏢'} size={14} />
          <span className="term-sector__name">{sec.name}</span>
          <span className="term-group__count">{filtering || shown.length !== total ? `${shown.length}/${total}` : total}</span>
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
                      setGroupError('')
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

  /**
   * Fixados, Adiados ou Assentados. Cada seção é um contêiner próprio, sempre
   * montado no mesmo lugar — vazia, só some da tela (`display: none`). Assim um
   * cartão que chega ou sai de uma seção não desloca os cartões das outras.
   * Buscando, a recolhida abre, como os grupos.
   */
  const renderSection = (id: TriageSection, list: Project[]) => {
    const isCollapsed = !searching && collapsedTriage.includes(id)
    return (
      <section data-testid={`triage-${id}`} className={`triage-section triage-section--${id}`}
               style={list.length === 0 ? { display: 'none' } : undefined}>
        <button type="button" className="triage-section__header" aria-expanded={!isCollapsed}
                onClick={() => toggleTriageSection(id)}>
          <svg className={`triage-caret ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
          <span className="eyebrow">{t(SECTION_LABEL[id])}</span>
          <span className="triage-section__count">{list.length}</span>
        </button>
        {!isCollapsed && (
          <div className="triage-section__body">{list.map((p) => renderCard(p, 'section'))}</div>
        )}
      </section>
    )
  }

  /**
   * A RÉGUA: a barra inteira em 62px, com os estados e os ícones.
   *
   * A profundidade não cabe em recuo, então vira contagem de traços — um por
   * contêiner que envolve a linha, na cor do próprio contêiner (ver railRows). O
   * traço do ancestral do terminal ABERTO acende: é o que responde "onde eu estou"
   * sem um único rótulo na tela.
   */
  const renderRail = () => {
    const fechado = (k: string) => collapsed.includes(Number(k.slice(2))) && k.startsWith('g-')
      || collapsedSectors.includes(Number(k.slice(2))) && k.startsWith('s-')
    // Assentados e adiados ficam fora do trilho: a um clique de abrir a lateral larga.
    const linhas = railRows(sections.tree, fechado)
    const abertoEm = activeLocalId ? sessions[activeLocalId]?.projectId : undefined

    const linhaDoTerminal = (p: Project, key: string, guides: RailGuide[]) => {
      const live = liveSessionsOf(p.id, sessions)
      const principal = primarySessionOf(p.id, sessions)
      const badge = unreadOf(p.id, sessions, unread)
      const esperando = live.some(isWaitingForYou)
      return (
        <div key={key} title={p.name}
             className={`rail-row ${abertoEm === p.id && (view === 'chat' || view === 'terminal') ? 'active' : ''}`}
             onClick={() => (principal ? openSession(principal.localId) : setStartFor(p))}>
          <RailGuides guides={guides} />
          <span className="rail-body">
            {esperando && <Sonar />}
            {/* Rosto e ícone viram UM objeto: lado a lado, em 62px, viravam dois
                borrões brigando por espaço. O ícone monta no canto do rosto —
                o estado continua sendo o que se lê primeiro, e a identidade do
                terminal vem grudada nele. */}
            <span className="rail-mark">
              <AgentFace state={faceStateOf(principal)} size={22} />
              <Icon className="rail-ico" value={p.icon} size={12} />
            </span>
            {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
          </span>
        </div>
      )
    }

    return (
      <div className="rail" data-testid="rail">
        {/* Fixados no topo, depois os ícones da faixa Trabalhando, depois a árvore.
            O bloco dos Fixados fica montado mesmo vazio, como as seções largas. */}
        <div className="rail-pinned" data-testid="rail-pinned"
             style={sections.pinned.length === 0 ? { display: 'none' } : undefined}>
          {sections.pinned.map((p) => linhaDoTerminal(p, `p-${p.id}`, []))}
        </div>
        <WorkingRail />
        {linhas.map((l) => {
          if (l.kind !== 'project') {
            const c = l.group!
            return (
              <div key={l.key} className="rail-row" title={c.name}
                   onClick={() => (l.kind === 'sector' ? toggleSector(c.id) : toggleGroup(c.id))}>
                <RailGuides guides={l.guides} />
                <span className="rail-body">
                  <span className={`rail-chip ${l.collapsed ? 'closed' : ''}`}
                        style={{ ['--c' as string]: c.color ?? 'var(--accent)' }}>
                    <Icon value={c.icon ?? (l.kind === 'sector' ? '🏢' : '🗂️')} size={13} />
                  </span>
                </span>
              </div>
            )
          }
          return linhaDoTerminal(l.project!, l.key, l.guides)
        })}
      </div>
    )
  }

  return (
    <div className={`sidebar ${railMode ? 'rail-mode' : ''}`}>
      <div className="sidebar__top">
        <div className="sidebar__logo" onClick={openDashboard} title={t('sidebar.overview')}>
          <BrandMark /> <span className="sidebar__logo-text">Claudinei</span>
        </div>
        <div className="sidebar__top-actions">
          <button className="sidebar__icon-btn sidebar__rail-btn"
                  title={t(railMode ? 'sidebar.expandSidebar' : 'sidebar.collapseSidebar')}
                  onClick={toggleRail}>{railMode ? '»' : '«'}</button>
          <button className="sidebar__icon-btn" title={t('appearance.title')}
                  aria-label={t('appearance.title')} onClick={() => setShowAppearance(true)}><GearIcon size={14} /></button>
          <UserMenu />
          <LanguageSwitcher />
        </div>
      </div>

      {railMode ? renderRail() : (<>
      {/* O cabeçalho "Terminais" é a zona de drop do TOPO: terminal sai do grupo,
          grupo vai pra primeira posição. */}
      <div
        className={`term-header ${dragOverBox === 'root' && drag !== null ? 'drop-target' : ''}`}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setDragOverBox('root') } }}
        onDragLeave={() => setDragOverBox((cur) => (cur === 'root' ? null : cur))}
        onDrop={(e) => { e.preventDefault(); void dropOnRoot() }}
      >
        <span className="eyebrow">{t('sidebar.terminals')}</span>
        <div className="term-header__filters">
          <label className="switch switch--sm term-header__filter" title={t('sidebar.activeOnlyHint')}>
            <input type="checkbox" checked={activeOnly} onChange={toggleActiveOnly} aria-label={t('sidebar.activeOnly')} />
            <span className="track" />
            <span className="thumb" />
          </label>
          <label className="term-header__favorite-filter" title={t('sidebar.pinnedOnlyHint')}>
            <StarIcon size={13} filled={favoritesOnly} />
            <span className="switch switch--sm term-header__filter">
              <input type="checkbox" checked={favoritesOnly} onChange={toggleFavoritesOnly} aria-label={t('sidebar.pinnedOnly')} />
              <span className="track" />
              <span className="thumb" />
            </span>
          </label>
        </div>
        <button className="ghost term-header__icon" title={t('sidebar.collapseAll')}
                onClick={() => collapseAll(true)}>⌃</button>
        <button className="ghost term-header__icon" title={t('sidebar.expandAll')}
                onClick={() => collapseAll(false)}>⌄</button>
        {isAdmin && (
          <button className="ghost term-header__icon term-header__scratch" type="button"
                  title={t('sidebar.scratchHint')} aria-label={t('sidebar.scratchTerminal')}
                  onClick={openScratch}>
            <BoltIcon size={13} />
          </button>
        )}
        {isAdmin && (
          <button className="ghost term-header__add" title={t('sidebar.addTerminal')} onClick={() => setShowNew(true)}>
            +<span className="term-header__label"> Terminal</span>
          </button>
        )}
      </div>

      {projects.length > 0 && (
        <div className="term-search" role="search">
          <SearchIcon size={13} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('sidebar.search')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Primeiro Escape limpa; com o campo vazio, devolve o foco à página.
              e.preventDefault()
              if (query) setQuery('')
              else e.currentTarget.blur()
            }}
          />
          {query && (
            <button type="button" className="term-search__clear"
                    aria-label={t('sidebar.searchClear')} title={t('sidebar.searchClear')}
                    onClick={() => { setQuery(''); searchRef.current?.focus() }}>×</button>
          )}
        </div>
      )}

      <div className="term-list">
        {triageError && <div className="term-list__error" role="alert">{t(triageError)}</div>}
        {/* De cima para baixo: Trabalhando, Fixados, a árvore, Adiados, Assentados.
            Cada uma num contêiner fixo nesta ordem — trocar de seção é trocar de
            pai, então só a triagem (nunca o status de uma sessão) faz isso. */}
        <WorkingStrip />
        {renderSection('pinned', sections.pinned)}
        <div className="term-tree" data-testid="term-tree">{sections.tree.map(renderEntry)}</div>
        {renderSection('snoozed', sections.snoozed)}
        {renderSection('settled', sections.settled)}
        {projects.length === 0 && (
          <div className="term-list__empty">{t('sidebar.empty')}</div>
        )}
        {/* Tem terminal, mas o filtro escondeu todos: o texto de "crie o primeiro"
            diria a coisa errada aqui. */}
        {projects.length > 0 && filtering && visibleEntries.length === 0 && (
          <div className="term-list__empty">{searching
            ? t(activeOnly || favoritesOnly ? 'sidebar.searchEmptyFiltered' : 'sidebar.searchEmpty', { query: query.trim() })
            : t(activeOnly && favoritesOnly ? 'sidebar.emptyFiltered' : activeOnly ? 'sidebar.emptyActive' : 'sidebar.emptyPinned')}</div>
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

      </>)}

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
                const patch = { name: groupRename.trim(), icon: groupIcon, color: groupColor }
                const save = kind === 'sector' ? updateSector(id, patch) : updateGroup(id, patch)
                // Fechar ANTES de saber o resultado era o que sumia com o motivo: o
                // servidor recusava o ícone e a tela não tinha o que dizer.
                setGroupError('')
                void save
                  .then(refetchAll)
                  .then(() => setGroupMenuFor(null))
                  .catch((err: Error) => setGroupError(err.message))
              }}>{t('common.save')}</button>
            </div>
            {groupError && <div className="sess-pop__error" role="alert">{groupError}</div>}
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
      {scratchDraft && (
        <StartSessionModal project={scratchDraft} create={() => createScratch(scratchDraft.name)} onClose={() => setScratchDraft(null)} />
      )}
    </div>
  )
}
