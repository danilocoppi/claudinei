import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { createProject, updateProject, fetchProjects, fetchDefaultFolder, fetchGroups, fetchSectors } from '../api'
import { applyPlacement, type Placement, type PlacementMemo } from '../placement'
import { folderSlug } from '../folderName'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { IconPicker } from './IconPicker'
import { ColorField } from './ColorField'
import { ProjectPreviewCard } from './ProjectPreviewCard'
import { Icon } from './Icon'

export function NewProjectModal({ onClose, editProject }: { onClose: () => void; editProject?: Project }) {
  const { t } = useTranslation()
  const setProjects = useStore((s) => s.setProjects)
  const setGroups = useStore((s) => s.setGroups)
  const setSectors = useStore((s) => s.setSectors)
  const groups = useStore((s) => s.groups)
  const sectors = useStore((s) => s.sectors)
  // Onde o terminal novo fica. Uma escolha só: o pertencimento é único no servidor.
  const [where, setWhere] = useState('root')
  const [placeName, setPlaceName] = useState('')
  const [groupSector, setGroupSector] = useState('')
  // Criado mas não posicionado (a 2ª etapa falhou): a retentativa só refaz a
  // etapa que faltou — sem isto, "Criar" de novo duplicaria o terminal.
  const [createdId, setCreatedId] = useState<number | null>(null)
  const memo = useRef<PlacementMemo>({})
  const [name, setName] = useState(editProject?.name ?? '')
  const [path, setPath] = useState(editProject?.path ?? '')
  const [icon, setIcon] = useState(editProject?.icon ?? '📁')
  const [color, setColor] = useState(editProject?.color ?? '#7c5cff')
  const [error, setError] = useState('')
  const [showFolder, setShowFolder] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  // Pasta nova: `path` vira a pasta-base e o nome da pasta acompanha o do
  // terminal até o operador editá-lo — depois disso, o que ele escreveu vale.
  const [newFolder, setNewFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const folderTouched = useRef(false)
  // A pasta padrão chega do servidor depois do primeiro render; se o operador já
  // escolheu outra no seletor, a resposta atrasada não passa por cima.
  const pathTouched = useRef(false)
  useEffect(() => {
    if (editProject) return
    void fetchDefaultFolder()
      .then((d) => { if (!pathTouched.current && d?.effective) setPath(d.effective) })
      .catch(() => { /* sem pasta padrão: o campo começa vazio, como antes */ })
  }, [editProject])

  const changeName = (value: string) => {
    setName(value)
    if (!folderTouched.current) setFolderName(folderSlug(value))
  }
  const folder = folderName.trim()

  // O banco não recusa mais pasta repetida (dois terminais na mesma pasta são
  // dois projetos). Quem cria duplicata por engano descobre aqui, e quem quer de
  // propósito só segue em frente. Com pasta nova, `path` é só a base.
  const pastaJaUsada = useStore((s) => !editProject && !newFolder && !!path && s.projects.some((p) => p.path === path))

  const placeLabel = placeName.trim()
  const placement = (): Placement => {
    if (where === 'new-sector') return { kind: 'new-sector', name: placeLabel }
    if (where === 'new-group') return { kind: 'new-group', name: placeLabel, sectorId: groupSector ? Number(groupSector) : null }
    const [kind, id] = where.split(':')
    if ((kind === 'sector' || kind === 'group') && id) return { kind, id: Number(id) }
    return { kind: 'root' }
  }
  const needsPlaceName = !editProject && (where === 'new-sector' || where === 'new-group')

  // Grupo e setor novos não aparecem na lateral sem recarregar a árvore inteira.
  const refetchTree = async () => {
    setProjects(await fetchProjects())
    if (!editProject) {
      setGroups(await fetchGroups())
      setSectors(await fetchSectors())
    }
  }

  // Fechar depois de um posicionamento que falhou ainda precisa mostrar o terminal criado.
  const close = () => {
    if (createdId !== null) void refetchTree().catch(() => {})
    onClose()
  }

  const submit = async () => {
    setError('')
    let id = createdId
    try {
      if (editProject) {
        await updateProject(editProject.id, { name, icon, color })
        await refetchTree()
        onClose()
        return
      }
      if (id === null) {
        id = (await createProject({ name, path, icon, color, ...(newFolder ? { newFolder: folder } : {}) })).id
        setCreatedId(id)
      }
    } catch (err) {
      setError((err as Error).message)
      return
    }
    try {
      await applyPlacement(id, placement(), memo.current)
    } catch (err) {
      await refetchTree().catch(() => {})
      setError(t('modal.placementFailed', { msg: (err as Error).message }))
      return
    }
    await refetchTree().catch(() => {})
    onClose()
  }

  // Portal: a .sidebar tem backdrop-filter (vira containing block de
  // position:fixed) — sem portal o overlay fica preso dentro dela.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="glass" style={{ width: 460, borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{editProject ? t('modal.editTerminal') : t('modal.newProject')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input placeholder={t('modal.namePlaceholder')} value={name} disabled={createdId !== null} onChange={(e) => changeName(e.target.value)} />

          {editProject ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '8px 2px' }}>📁 <span>{path}</span></div>
          ) : (
            <button className="ghost" style={{ textAlign: 'left' }} disabled={createdId !== null} onClick={() => setShowFolder(true)}>
              {path ? <>📁 <span>{path}</span></> : t('modal.choosePath')}
            </button>
          )}

          {!editProject && (
            <label className="new-folder__toggle">
              <input type="checkbox" checked={newFolder} onChange={(e) => setNewFolder(e.target.checked)} />
              <span>{t('modal.newFolder')}</span>
            </label>
          )}
          {!editProject && newFolder && (
            <div className="new-folder">
              <input aria-label={t('modal.newFolderName')} placeholder={t('modal.newFolderName')} value={folderName}
                     onChange={(e) => { folderTouched.current = true; setFolderName(e.target.value) }} />
              {folder && path && (
                <span className="new-folder__preview">{t('modal.newFolderPreview', { path: `${path.replace(/\/+$/, '')}/${folder}` })}</span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="ghost" onClick={() => setShowEmoji(true)} style={{ width: 48 }}><Icon value={icon} size={20} /></button>
            <ColorField value={color} onChange={setColor} />
          </div>

          {!editProject && (
            <div className="placement">
              <label className="placement__row">
                <span>{t('modal.placement')}</span>
                <select data-testid="new-terminal-placement" value={where}
                        onChange={(e) => { setWhere(e.target.value); memo.current = {} }}>
                  <option value="root">{t('modal.placementRoot')}</option>
                  {sectors.length > 0 && (
                    <optgroup label={t('modal.placementSectors')}>
                      {sectors.map((sec) => <option key={sec.id} value={`sector:${sec.id}`}>{sec.name}</option>)}
                    </optgroup>
                  )}
                  {groups.length > 0 && (
                    <optgroup label={t('modal.placementGroups')}>
                      {groups.map((g) => {
                        // Grupo dentro de setor: o setor no rótulo desfaz a ambiguidade
                        // de dois grupos com o mesmo nome em setores diferentes.
                        const sec = g.sectorId ? sectors.find((s) => s.id === g.sectorId) : undefined
                        return <option key={g.id} value={`group:${g.id}`}>{sec ? `${sec.name} › ${g.name}` : g.name}</option>
                      })}
                    </optgroup>
                  )}
                  <optgroup label={t('modal.placementCreate')}>
                    <option value="new-sector">{t('modal.placementNewSector')}</option>
                    <option value="new-group">{t('modal.placementNewGroup')}</option>
                  </optgroup>
                </select>
              </label>
              {needsPlaceName && (
                <input data-testid="new-terminal-place-name" value={placeName}
                       placeholder={t(where === 'new-sector' ? 'sidebar.newSectorPlaceholder' : 'sidebar.newGroupPlaceholder')}
                       onChange={(e) => setPlaceName(e.target.value)} />
              )}
              {where === 'new-group' && sectors.length > 0 && (
                <label className="placement__row">
                  <span>{t('modal.placementGroupSector')}</span>
                  <select data-testid="new-terminal-group-sector" value={groupSector} onChange={(e) => setGroupSector(e.target.value)}>
                    <option value="">{t('sidebar.noSector')}</option>
                    {sectors.map((sec) => <option key={sec.id} value={String(sec.id)}>{sec.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}

          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{t('common.preview')}</div>
            <ProjectPreviewCard name={name} icon={icon} color={color} />
          </div>

          {pastaJaUsada && (
            <span style={{ color: 'var(--warn)', fontSize: 13 }}>{t('modal.sharedPathWarning')}</span>
          )}
          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={close}>{t('common.cancel')}</button>
            <button disabled={!name || !path || (newFolder && !folder) || (needsPlaceName && !placeLabel)} onClick={submit}>
              {editProject ? t('common.save') : createdId !== null ? t('modal.retry') : t('common.create')}
            </button>
          </div>
        </div>
      </div>

      {showFolder && (
        <FolderPicker
          initialPath={path || undefined}
          onSelect={(p) => { pathTouched.current = true; setPath(p); setShowFolder(false) }}
          onClose={() => setShowFolder(false)}
        />
      )}
      {showEmoji && (
        <IconPicker value={icon} onSelect={setIcon} onClose={() => setShowEmoji(false)} />
      )}
    </div>,
    document.body,
  )
}
