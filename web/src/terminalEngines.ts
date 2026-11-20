import type { EngineMeta, Project, SessionInfo } from './types'
import { sessionForEngine, isLive } from './engineSession'

/**
 * Motores por terminal: cada terminal guarda em `project.engines` a lista dos
 * motores que usa, e só eles aparecem nas abas e nas listas de escolha. Aqui
 * moram as regras puras dessa lista, para a tela inteira decidir igual.
 */

/**
 * A lista do terminal como veio do servidor, inclusive ids que esta tela não
 * conhece (um motor removido numa versão futura): quem grava a lista precisa
 * devolvê-los. Ausente, vazia ou quebrada vale como só o Claude, a mesma
 * leitura que o servidor faz.
 */
export function listedOf(project: Pick<Project, 'engines'> | undefined): string[] {
  const raw = project?.engines
  if (!Array.isArray(raw)) return ['claude']
  const valid = raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return valid.length > 0 ? valid : ['claude']
}

/**
 * Os motores que ganham aba no cabeçalho do terminal, na ordem do store.
 *
 * Aparece quem está na lista e instalado, e também quem o operador não pode
 * perder de vista mesmo fora dela: a sessão viva, a conversa aberta na tela
 * (chegou por link, notificação ou histórico) e o trabalho interrompido pelo
 * reinício, que precisa do Continuar. Um id da lista que o store não conhece
 * é ignorado.
 */
export function tabEngines(a: {
  engines: EngineMeta[]
  listed: string[]
  projectId: number
  sessions: Record<string, SessionInfo>
  activeLocalId: string | null
  interrupted: (engine: string) => boolean
}): EngineMeta[] {
  const active = a.activeLocalId ? a.sessions[a.activeLocalId] : undefined
  const activeEngine = active && active.projectId === a.projectId ? active.engine : null
  return a.engines.filter((e) =>
    (a.listed.includes(e.id) && e.available !== false)
    || isLive(sessionForEngine(a.projectId, e.id, a.sessions))
    || e.id === activeEngine
    || a.interrupted(e.id))
}

/**
 * Motores oferecidos nas listas de escolha (iniciar sessão, menu do cartão,
 * agendamento): os da lista, na ordem do store. `keep` mantém o motor de um
 * agendamento que já existe, mesmo que ele tenha saído da lista.
 */
export function pickableEngines(engines: EngineMeta[], listed: string[], keep?: string | null): EngineMeta[] {
  return engines.filter((e) => listed.includes(e.id) || (!!keep && e.id === keep))
}

/** Motores fora da lista do terminal, na ordem do store: é o que o "+" oferece. */
export function hiddenEngines(engines: EngineMeta[], listed: string[]): EngineMeta[] {
  return engines.filter((e) => !listed.includes(e.id))
}
