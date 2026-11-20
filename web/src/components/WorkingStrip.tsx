import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Project } from '../types'
import { useStore } from '../store'
import { workingRows, type WorkingRow } from '../triageSections'
import { Icon } from './Icon'

/**
 * A faixa Trabalhando: uma linha curta por sessão em atividade (`working`,
 * compactando ou o terminal interativo processando), inclusive dos assentados;
 * os adiados ficam de fora.
 *
 * Ela só LISTA: os cartões continuam no lugar deles, e nada aqui tem rosto ou
 * animação (AGENTS.md: a lateral roda sem GPU). Por isso também lê do store o
 * mínimo — uma string com as linhas, comparada por valor. O status de um terminal
 * fora da faixa muda essa string em nada, e a faixa não renderiza.
 */

// Faixa recolhida (estado de VISÃO, por navegador, como os grupos recolhidos).
const COLLAPSED_KEY = 'claudinei:workingCollapsed'
const loadCollapsed = (): boolean => {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

type Row = WorkingRow & { project: Project }

type StoreState = ReturnType<typeof useStore.getState>

/**
 * O seletor roda a CADA escrita no store, inclusive as do streaming do chat
 * aberto (o caminho caro, segundo o AGENTS.md). Por isso ele só refaz a conta
 * quando `sessions` ou `triage` trocam de referência; nas outras escritas
 * devolve a chave anterior. Uma entrada só basta: a faixa larga e a do trilho
 * nunca estão montadas ao mesmo tempo, e as duas leem a mesma chave.
 *
 * O `Date.now()` só decide se um adiamento ainda vale. Quando um vence, o relógio
 * da lateral limpa o `snoozedUntil` no store — a `triage` muda, e a conta é refeita.
 */
let last: { sessions: StoreState['sessions']; triage: StoreState['triage']; key: string } | null = null
const selectRowsKey = (s: StoreState) => {
  if (last && last.sessions === s.sessions && last.triage === s.triage) return last.key
  last = { sessions: s.sessions, triage: s.triage, key: JSON.stringify(workingRows(s.sessions, s.triage, Date.now())) }
  return last.key
}

function useWorkingRows(): Row[] {
  const key = useStore(selectRowsKey)
  const projects = useStore((s) => s.projects)
  return useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    return (JSON.parse(key) as WorkingRow[])
      .flatMap((r) => {
        const project = byId.get(r.projectId)
        return project ? [{ ...r, project }] : []
      })
      .sort((a, b) => a.project.name.localeCompare(b.project.name) || a.engine.localeCompare(b.engine))
  }, [key, projects])
}

/** Rótulo do motor e do estado de uma linha, e o `title` que junta tudo. */
function useRowText() {
  const { t } = useTranslation()
  const engines = useStore((s) => s.engines)
  return (r: Row) => {
    const engine = engines.find((e) => e.id === r.engine)?.label ?? r.engine
    const state = t(`status.${r.statusKey}` as 'status.working')
    return { engine, state, title: `${r.project.name} · ${engine} · ${state}` }
  }
}

export const WorkingStrip = memo(function WorkingStrip() {
  const { t } = useTranslation()
  const rows = useWorkingRows()
  const rowText = useRowText()
  const openSession = useStore((s) => s.openSession)
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  // Vazia, a faixa some. O lugar dela na lista é o do próprio componente, então
  // sumir aqui não desloca as seções nem os cartões que vêm depois.
  if (rows.length === 0) return null

  const toggle = () => {
    setCollapsed((cur) => {
      try { localStorage.setItem(COLLAPSED_KEY, cur ? '0' : '1') } catch { /* só não persiste */ }
      return !cur
    })
  }

  return (
    <section className="working-strip" data-testid="working-strip">
      <button type="button" className="triage-section__header" aria-expanded={!collapsed} onClick={toggle}>
        <svg className={`triage-caret ${collapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4.5v15a1 1 0 0 0 1.52.86l12.2-7.5a1 1 0 0 0 0-1.72L9.52 3.64A1 1 0 0 0 8 4.5Z" /></svg>
        <span className="eyebrow">{t('sidebar.sectionWorking')}</span>
        <span className="triage-section__count">{rows.length}</span>
      </button>
      {!collapsed && (
        <div className="working-strip__rows">
          {rows.map((r) => {
            const { engine, state, title } = rowText(r)
            return (
              <button key={r.localId} type="button" className="working-strip__row" data-testid="working-row"
                      title={title} onClick={() => openSession(r.localId)}>
                <Icon className="working-strip__icon" value={r.project.icon} size={13} />
                <span className="working-strip__name">{r.project.name}</span>
                <span className="working-strip__engine">{engine}</span>
                <span className="working-strip__state">{state}</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
})

/**
 * A mesma faixa na lateral estreita: só os ícones, logo abaixo dos Fixados. O nome,
 * o motor e o estado vão no `title`.
 */
export const WorkingRail = memo(function WorkingRail() {
  const rows = useWorkingRows()
  const rowText = useRowText()
  const openSession = useStore((s) => s.openSession)
  if (rows.length === 0) return null
  return (
    <div className="rail-working" data-testid="rail-working">
      {rows.map((r) => (
        <div key={r.localId} className="rail-row" data-testid="working-row" title={rowText(r).title}
             onClick={() => openSession(r.localId)}>
          {/* A goteira vazia alinha o ícone com as linhas da árvore. */}
          <span className="rail-guide" aria-hidden="true" />
          <span className="rail-body">
            <span className="rail-chip rail-chip--working"><Icon value={r.project.icon} size={13} /></span>
          </span>
        </div>
      ))}
    </div>
  )
})
