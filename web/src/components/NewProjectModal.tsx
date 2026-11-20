import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { createProject, updateProject, setProjectEngines, fetchProjects, fetchDefaultFolder, fetchGroups, fetchSectors } from '../api'
import { applyPlacement, type Placement, type PlacementMemo } from '../placement'
import { folderSlug } from '../folderName'
import { useStore } from '../store'
import { defaultListed, listedOf } from '../terminalEngines'
import { FolderPicker } from './FolderPicker'
import { IconPicker } from './IconPicker'
import { ColorField } from './ColorField'
import { ProjectPreviewCard } from './ProjectPreviewCard'
import { Icon } from './Icon'
import { EngineIcon } from './EngineIcon'

export function NewProjectModal({ onClose, editProject }: { onClose: () => void; editProject?: Project }) {
  const { t } = useTranslation()
  const setProjects = useStore((s) => s.setProjects)
  const setGroups = useStore((s) => s.setGroups)
  const setSectors = useStore((s) => s.setSectors)
  const groups = useStore((s) => s.groups)
  const sectors = useStore((s) => s.sectors)
  const engines = useStore((s) => s.engines)
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

  // Motores do terminal. Na edição, a lista dele; na criação, `null` até o
  // operador mexer, e vale o padrão do catálogo atual (que pode chegar depois).
  const savedEngines = editProject ? listedOf(editProject) : null
  const [picked, setPicked] = useState<string[] | null>(savedEngines)
  const checked = picked ?? defaultListed(engines)
  const toggleEngine = (id: string) => setPicked((cur) => {
    const base = cur ?? defaultListed(engines)
    return base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
  })
  // Sem catálogo (ainda não carregou), não há o que marcar: o formulário não
  // trava nem mexe na lista.
  const catalogReady = engines.length > 0
  // Ids gravados que esta tela não conhece (motor de outra versão) voltam ao salvar.
  const unknownIds = (savedEngines ?? []).filter((id) => !engines.some((e) => e.id === id))
  const checkedKnown = engines.filter((e) => checked.includes(e.id)).map((e) => e.id)
  const enginesToSave = [...checkedKnown, ...unknownIds]
  const noEngine = catalogReady && checkedKnown.length === 0
  const enginesChanged = !!savedEngines
    && (enginesToSave.length !== savedEngines.length || enginesToSave.some((id) => !savedEngines.includes(id)))

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
        if (enginesChanged) {
          // A rota não avisa as outras telas: o Project devolvido entra no store aqui.
          const updated = await setProjectEngines(editProject.id, enginesToSave)
          setProjects(useStore.getState().projects.map((p) => (p.id === updated.id ? updated : p)))
        }
        await refetchTree()
        onClose()
        return
      }
      if (id === null) {
        id = (await createProject({
          name, path, icon, color,
          ...(newFolder ? { newFolder: folder } : {}),
          ...(catalogReady ? { engines: enginesToSave } : {}),
        })).id
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

          {catalogReady && (
            <div className="project-engines" role="group" aria-label={t('project.engines')}>
              <div className="project-engines__title">{t('project.engines')}</div>
              <div className="project-engines__hint">{t('project.enginesHint')}</div>
              {engines.map((e) => (
                <label key={e.id} className="new-folder__toggle">
                  <input type="checkbox" checked={checked.includes(e.id)} disabled={createdId !== null}
                         onChange={() => toggleEngine(e.id)} />
                  <EngineIcon icon={e.icon} />
                  <span>{e.label}</span>
                  {e.available === false && <span className="engine-picker__missing">{t('chat.engineNotInstalled')}</span>}
                </label>
              ))}
              {noEngine && <span style={{ color: 'var(--err)', fontSize: 13 }}>{t('project.enginesRequired')}</span>}
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
            <button disabled={!name || !path || (newFolder && !folder) || (needsPlaceName && !placeLabel) || noEngine} onClick={submit}>
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
