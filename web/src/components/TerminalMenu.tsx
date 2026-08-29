import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  createGroup, createSector, deleteAction, deleteProject, fetchActions, fetchGroups,
  fetchLocalApps, fetchProjects, fetchSectors, openLocalApp, setProjectGroup,
  setProjectSector, type Action, type LocalApp,
} from '../api'
import { useStore } from '../store'
import { copyText } from '../clipboard'
import { CodeIcon, CopyIcon, EditIcon, FolderIcon, PlayIcon, TerminalIcon, TrashIcon } from './MenuIcons'
import { NewProjectModal } from './NewProjectModal'
import { ActionEditor } from './ActionEditor'
import { ConfirmDialog } from './ConfirmDialog'
import type { Project } from '../types'

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
 */
export function TerminalMenu({ project, x, y, onDone }: {
  project: Project
  x: number
  y: number
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'menu' | 'edit' | 'delete' | 'action'>('menu')
  const [newGroupName, setNewGroupName] = useState('')
  const [newSectorName, setNewSectorName] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [localApps, setLocalApps] = useState<Partial<Record<LocalApp, boolean>> & { local?: boolean }>({})
  const [actions, setActions] = useState<Action[]>([])
  // Indefinido = criando; definido = editando aquela.
  const [editingAction, setEditingAction] = useState<Action | undefined>()
  const openActionRun = useStore((s) => s.openActionRun)

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

  // Só busca as ações onde elas podem rodar. Pela rede, o botão abriria um shell na
  // máquina de OUTRA pessoa — o servidor recusa, e a lista aqui só faria prometer.
  useEffect(() => {
    if (!localApps.local) return
    void fetchActions(project.id).then(setActions).catch(() => setActions([]))
  }, [localApps.local, project.id])

  const fechaEEntao = (fn: () => void | Promise<unknown>) => () => { onDone(); void fn() }

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

  const excluir = async () => {
    try {
      await deleteProject(project.id)
      setProjects(await fetchProjects())
      onDone()
    } catch (err) {
      setDeleteError((err as Error).message)
    }
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
  if (phase === 'delete') {
    return (
      <ConfirmDialog
        title={t('confirm.deleteTitle', { name: project.name })}
        message={t('confirm.deleteMsg')}
        confirmLabel={t('common.delete')}
        error={deleteError}
        onConfirm={excluir}
        onClose={onDone}
      />
    )
  }

  return createPortal(
    <div className="sess-pop__overlay" onClick={onDone}>
      <div className="sess-pop glass" style={{ left: x, top: y, minWidth: 190 }} onClick={(e) => e.stopPropagation()}>
        <div className="sess-pop__item" onClick={() => setPhase('edit')}>
          <EditIcon /><span>{t('sidebar.editTerminal')}</span>
        </div>

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

        {/* AÇÕES — comandos que este terminal repete com um clique. Ficam dentro de
            "nesta máquina" porque é onde elas rodam, e são deste terminal só: o
            mesmo `npm run deploy` publica coisas diferentes em pastas diferentes. */}
        {localApps.local && (
          <>
            <div className="sess-pop__sep" />
            <div className="sess-pop__eyebrow sess-pop__eyebrow--row">
              <span>{t('actions.section')}</span>
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
             onClick={() => { setDeleteError(''); setPhase('delete') }}>
          <TrashIcon /><span>{t('sidebar.deleteTerminal')}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
