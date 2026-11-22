import { useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  createGroup, createSector, deleteAction, fetchActions, fetchGroups,
  fetchLocalApps, fetchProjects, fetchSectors, openLocalApp, setProjectGroup,
  setProjectSector, type Action, type LocalApp,
} from '../api'
import { useStore } from '../store'
import { copyText } from '../clipboard'
import { ClockIcon, CodeIcon, CopyIcon, EditIcon, FolderIcon, PageIcon, PlayIcon, SettleIcon, StarIcon, TerminalIcon, TrashIcon } from './MenuIcons'
import { NewProjectModal } from './NewProjectModal'
import { ActionEditor } from './ActionEditor'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { PagesListDialog } from './PagesListDialog'
import { usePagesStore } from '../pages/pagesStore'
import type { Project } from '../types'
import { ViewportPopover } from './ViewportPopover'
import { WsContext } from '../wsContext'
import { applyTriage, type TriagePatch } from '../triageActions'
import { snoozeUntil, triageStateOf } from '../triageSections'

/** As opções de adiar, na ordem do submenu. */
const SNOOZE_CHOICES = [
  { id: '1h', label: 'triage.snooze1h' },
  { id: 'tomorrow', label: 'triage.snoozeTomorrow' },
  { id: 'monday', label: 'triage.snoozeMonday' },
] as const

/** Abrir no desktop, na ordem em que aparecem no menu. */
const LOCAL_ACTIONS: { id: LocalApp; Icon: typeof FolderIcon; label: string }[] = [
  { id: 'folder', Icon: FolderIcon, label: 'sidebar.openFolder' },
  { id: 'vscode', Icon: CodeIcon, label: 'sidebar.openVscode' },
  { id: 'terminal', Icon: TerminalIcon, label: 'sidebar.openTerminal' },
]

/**
 * O menu de opções de um terminal — o que abre nas três bolinhas.
 *
 * Mora aqui, e não na barra lateral, porque é usado em DOIS lugares: no cartão da
 * lista e no título do terminal aberto. Quem está lendo a conversa não devia ter
 * que voltar à lista para renomear o terminal ou abrir a pasta dele.
 *
 * O componente cuida do ciclo inteiro — o popover, o formulário de edição e a
 * confirmação de exclusão —, e só avisa `onDone` quando tudo acabou. Se ele
 * desmontasse ao fechar o popover, o modal que o item abriu morreria junto.
 *
 * `localId`: o terminal da conversa, só no título do terminal aberto. Com ele e
 * com páginas visuais carregadas, o menu ganha "Páginas desta conversa (n)".
 * No cartão da lateral não vem: a lista de páginas só existe da conversa aberta.
 */
export function TerminalMenu({ project, localId, x, y, onDone }: {
  project: Project
  localId?: string
  x: number
  y: number
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'menu' | 'edit' | 'delete' | 'action' | 'pages'>('menu')
  // Todas as páginas da conversa, inclusive as que já têm lugar nela.
  const pageCount = usePagesStore((s) => (localId ? s.byLocal[localId]?.length ?? 0 : 0))
  const [newGroupName, setNewGroupName] = useState('')
  const [newSectorName, setNewSectorName] = useState('')
  const [localApps, setLocalApps] = useState<Partial<Record<LocalApp, boolean>> & { local?: boolean }>({})
  const [actions, setActions] = useState<Action[]>([])
  // Indefinido = criando; definido = editando aquela.
  const [editingAction, setEditingAction] = useState<Action | undefined>()
  const openActionRun = useStore((s) => s.openActionRun)
  const ws = useContext(WsContext)
  const triageItem = useStore((s) => s.triage[project.id])
  const [snoozeOpen, setSnoozeOpen] = useState(false)

  const groups = useStore((s) => s.groups)
  const sectors = useStore((s) => s.sectors)
  const setProjects = useStore((s) => s.setProjects)
  const setGroups = useStore((s) => s.setGroups)
  const setSectors = useStore((s) => s.setSectors)

  /** Mover mexe na árvore inteira: os três precisam voltar juntos. */
  const refetchAll = async () => {
    setProjects(await fetchProjects())
    setGroups(await fetchGroups())
    setSectors(await fetchSectors())
  }

  // Quem decide o que dá para abrir é o SERVIDOR: ele sabe se a requisição é local
  // E se o binário existe. Item morto seria pior que item nenhum.
  useEffect(() => { void fetchLocalApps().then(setLocalApps).catch(() => setLocalApps({})) }, [])

  // Ações aparecem também remoto (decisão 2026-09): elas rodam no SERVIDOR por
  // definição — "disparar o deploy do celular" é o caso de uso — e a régua de
  // acesso é a do projeto, a mesma do chat. Diferente dos "abrir em…", que
  // abririam janela na máquina errada e continuam só locais.
  useEffect(() => {
    void fetchActions(project.id)
      .then((a) => setActions(Array.isArray(a) ? a : []))
      .catch(() => setActions([]))
  }, [project.id])

  const fechaEEntao = (fn: () => void | Promise<unknown>) => () => { onDone(); void fn() }

  // Triagem: o menu fecha e a ação segue (o aviso de desfazer vive no App). O
  // pedido é montado no clique, não ao desenhar: "1 h" conta de quando se clicou.
  const pinned = !!triageItem?.pinned
  const settled = !!triageItem?.settled
  const snoozed = triageStateOf(triageItem, Date.now()) === 'snoozed'
  const triage = (patch: () => TriagePatch, label: 'triage.didPin' | 'triage.didUnpin' | 'triage.didSettle' | 'triage.didUnsettle' | 'triage.didSnooze' | 'triage.didUnsnooze') =>
    fechaEEntao(() => applyTriage(project.id, patch(), t(label, { name: project.name }), ws))

  const criarGrupoEMover = async () => {
    const name = newGroupName.trim()
    if (!name) return
    onDone()
    setNewGroupName('')
    try {
      const g = await createGroup(name)
      await setProjectGroup(project.id, g.id)
      await refetchAll()
    } catch { /* mantém como está */ }
  }

  const criarSetorEMover = async () => {
    const name = newSectorName.trim()
    if (!name) return
    onDone()
    setNewSectorName('')
    try {
      const sec = await createSector(name)
      await setProjectSector(project.id, sec.id)
      await refetchAll()
    } catch { /* mantém como está */ }
  }

  if (phase === 'action') {
    return (
      <ActionEditor
        projectId={project.id}
        action={editingAction}
        onSaved={() => { void fetchActions(project.id).then(setActions).catch(() => {}); setPhase('menu') }}
        onClose={() => setPhase('menu')}
      />
    )
  }
  if (phase === 'edit') return <NewProjectModal editProject={project} onClose={onDone} />
  if (phase === 'delete') return <DeleteProjectDialog project={project} onDeleted={onDone} onClose={onDone} />
  if (phase === 'pages' && localId) return <PagesListDialog localId={localId} onClose={onDone} />

  return createPortal(
    <div className="sess-pop__overlay" onClick={onDone}>
      <ViewportPopover x={x} y={y} minWidth={190}>
        <div className="sess-pop__item" onClick={() => setPhase('edit')}>
          <EditIcon /><span>{t('sidebar.editTerminal')}</span>
        </div>
        {localId && pageCount > 0 && (
          <div className="sess-pop__item" data-testid="menu-pages" onClick={() => setPhase('pages')}>
            <PageIcon /><span>{t('pages.listItem', { n: pageCount })}</span>
          </div>
        )}

        {/* TRIAGEM — fixar, assentar e adiar valem só para quem clicou. O horário
            do adiamento sai daqui já absoluto, no fuso do navegador. */}
        <div className="sess-pop__sep" />
        <div className="sess-pop__item" data-testid="menu-pin"
             onClick={triage(() => ({ pinned: !pinned }), pinned ? 'triage.didUnpin' : 'triage.didPin')}>
          <StarIcon filled={pinned} /><span>{t(pinned ? 'triage.unpin' : 'triage.pin')}</span>
        </div>
        <div className="sess-pop__item" data-testid="menu-settle"
             onClick={triage(() => ({ settled: !settled }), settled ? 'triage.didUnsettle' : 'triage.didSettle')}>
          <SettleIcon /><span>{t(settled ? 'triage.unsettle' : 'triage.settle')}</span>
        </div>
        {/* Submenu que abre no próprio menu, no clique: um flyout lateral sairia
            da tela no cartão encostado na borda e não existe no toque. */}
        <div className="sess-pop__item" data-testid="menu-snooze" aria-expanded={snoozeOpen}
             onClick={() => setSnoozeOpen((o) => !o)}>
          <ClockIcon /><span>{t('triage.snooze')}</span><span className="sess-pop__caret">{snoozeOpen ? '▾' : '▸'}</span>
        </div>
        {snoozeOpen && (
          <>
            {SNOOZE_CHOICES.map((c) => (
              <div key={c.id} className="sess-pop__item sess-pop__item--sub" data-testid={`menu-snooze-${c.id}`}
                   onClick={triage(() => ({ snoozedUntil: snoozeUntil(c.id, new Date()).toISOString() }), 'triage.didSnooze')}>
                <span>{t(c.label)}</span>
              </div>
            ))}
            {snoozed && (
              <div className="sess-pop__item sess-pop__item--sub" data-testid="menu-unsnooze"
                   onClick={triage(() => ({ snoozedUntil: null }), 'triage.didUnsnooze')}>
                <span>{t('triage.unsnooze')}</span>
              </div>
            )}
          </>
        )}

        {/* NESTA MÁQUINA — o rótulo não é enfeite: estas ações somem quando se
            acessa de outro computador. Sem ele, o menu só encolheria, sem dizer
            por quê. */}
        <div className="sess-pop__sep" />
        <div className="sess-pop__eyebrow">{t('sidebar.onThisMachine')}</div>
        {LOCAL_ACTIONS.filter((a) => localApps[a.id]).map((a) => (
          <div key={a.id} className="sess-pop__item"
               onClick={fechaEEntao(() => openLocalApp(project.id, a.id).catch(() => {}))}>
            <a.Icon /><span>{t(a.label as 'sidebar.openFolder')}</span>
          </div>
        ))}
        <div className="sess-pop__item" onClick={fechaEEntao(() => copyText(project.path))}>
          <CopyIcon /><span>{t('sidebar.copyPath')}</span>
        </div>

        {/* AÇÕES — comandos que este terminal repete com um clique. São deste
            terminal só (o mesmo `npm run deploy` publica coisas diferentes em
            pastas diferentes) e rodam SEMPRE no servidor — remoto, o aviso ao
            lado do título deixa isso dito antes do clique. */}
        {(
          <>
            <div className="sess-pop__sep" />
            <div className="sess-pop__eyebrow sess-pop__eyebrow--row">
              <span>
                {t('actions.section')}
                {!localApps.local && <span className="sess-pop__hint"> · {t('actions.remoteHint')}</span>}
              </span>
              <button className="sess-pop__add" data-testid="action-new" title={t('actions.new')}
                      onClick={() => { setEditingAction(undefined); setPhase('action') }}>＋</button>
            </div>
            {actions.length === 0 && <div className="sess-pop__empty">{t('actions.empty')}</div>}
            {actions.map((a) => (
              <div key={a.id} className="sess-pop__item sess-pop__item--act" data-testid={`action-${a.id}`}
                   onClick={() => {
                     // O menu fecha; a caixinha vive no App e segue rodando.
                     onDone()
                     openActionRun({ actionId: a.id, name: a.name, autoClose: a.autoClose })
                   }}>
                <PlayIcon />
                <span className="sess-pop__act-name">{a.name}</span>
                {a.running && <span className="sess-pop__act-live" title={t('actions.running')} />}
                <button className="sess-pop__act-btn" title={t('common.edit')}
                        onClick={(e) => { e.stopPropagation(); setEditingAction(a); setPhase('action') }}>
                  <EditIcon />
                </button>
                <button className="sess-pop__act-btn sess-pop__act-btn--danger" title={t('common.delete')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void deleteAction(a.id)
                            .then(() => setActions((prev) => prev.filter((x) => x.id !== a.id)))
                            .catch(() => {})
                        }}>
                  <TrashIcon />
                </button>
              </div>
            ))}
          </>
        )}
        <div className="sess-pop__sep" />

        {/* Grupo e setor em dropdown: com uma dúzia de cada, a lista de itens
            transformava o popover numa página rolante. */}
        <label className="sess-pop__field">
          <span>{t('sidebar.group')}</span>
          <select data-testid="menu-group" value={project.groupId ?? ''}
                  onChange={(e) => {
                    const groupId = e.target.value ? Number(e.target.value) : null
                    onDone()
                    void setProjectGroup(project.id, groupId).then(refetchAll).catch(() => {})
                  }}>
            <option value="">{t('sidebar.noGroup')}</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="sess-pop__newgroup">
          <input
            value={newGroupName}
            placeholder={t('sidebar.newGroupPlaceholder')}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void criarGrupoEMover() }}
          />
          <button title={t('sidebar.newGroup')} disabled={!newGroupName.trim()}
                  onClick={() => void criarGrupoEMover()}>＋</button>
        </div>
        {/* Setor mora aqui pelo mesmo motivo que grupo: é onde se responde "onde este
            terminal fica". Antes, criar setor era um botão na barra de cima — longe do
            terminal que ia para dentro dele, e escondido atrás de um ícone.
            E aparece SEMPRE, mesmo sem nenhum setor cadastrado: ele é o único caminho
            para o primeiro, e um campo que só nasce depois de existir o que ele cria
            não teria como ser usado. */}
        <label className="sess-pop__field">
          <span>{t('sidebar.sector')}</span>
          <select data-testid="menu-sector" value={project.sectorId ?? ''}
                  onChange={(e) => {
                    const sectorId = e.target.value ? Number(e.target.value) : null
                    onDone()
                    void setProjectSector(project.id, sectorId).then(refetchAll).catch(() => {})
                  }}>
            <option value="">{t('sidebar.noSector')}</option>
            {sectors.map((sec) => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
          </select>
        </label>
        <div className="sess-pop__newgroup">
          <input
            data-testid="menu-new-sector"
            value={newSectorName}
            placeholder={t('sidebar.newSectorPlaceholder')}
            onChange={(e) => setNewSectorName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void criarSetorEMover() }}
          />
          <button title={t('sidebar.newSector')} disabled={!newSectorName.trim()}
                  onClick={() => void criarSetorEMover()}>＋</button>
        </div>

        {/* O irreversível por último, separado e tingido. Antes era o SEGUNDO item
            do menu, encostado em Editar — no ponto de maior tráfego do ponteiro. */}
        <div className="sess-pop__sep" />
        <div className="sess-pop__item sess-pop__item--danger"
             onClick={() => setPhase('delete')}>
          <TrashIcon /><span>{t('sidebar.deleteTerminal')}</span>
        </div>
      </ViewportPopover>
    </div>,
    document.body,
  )
}
