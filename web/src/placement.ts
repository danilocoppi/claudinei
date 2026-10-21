// "Onde fica" um terminal novo: solto, num setor, num grupo — ou num setor/grupo
// criado junto com ele. O pertencimento é único no servidor (grupo OU setor; o
// grupo é que pode morar num setor), então isto é uma escolha só, não dois campos.
import { createGroup, createSector, setGroupSector, setProjectGroup, setProjectSector } from './api'

export type Placement =
  | { kind: 'root' }
  | { kind: 'sector'; id: number }
  | { kind: 'group'; id: number }
  | { kind: 'new-sector'; name: string }
  | { kind: 'new-group'; name: string; sectorId: number | null }

/** O que já foi criado numa tentativa anterior: a retentativa reaproveita em vez de duplicar. */
export interface PlacementMemo { groupId?: number; sectorId?: number; groupInSector?: boolean }

/** Valor do <select> ↔ escolha. Os "novos" só carregam o nome depois, no submit. */
export function placementValue(p: Placement): string {
  if (p.kind === 'sector' || p.kind === 'group') return `${p.kind}:${p.id}`
  return p.kind
}

/**
 * Coloca o terminal no lugar escolhido. Idempotente via `memo`: se a criação do
 * grupo deu certo e a atribuição falhou, a segunda chamada não cria outro grupo.
 */
export async function applyPlacement(projectId: number, p: Placement, memo: PlacementMemo = {}): Promise<void> {
  switch (p.kind) {
    case 'root':
      return
    case 'sector':
      await setProjectSector(projectId, p.id)
      return
    case 'group':
      await setProjectGroup(projectId, p.id)
      return
    case 'new-sector': {
      memo.sectorId ??= (await createSector(p.name)).id
      await setProjectSector(projectId, memo.sectorId)
      return
    }
    case 'new-group': {
      memo.groupId ??= (await createGroup(p.name)).id
      if (p.sectorId !== null && !memo.groupInSector) {
        await setGroupSector(memo.groupId, p.sectorId)
        memo.groupInSector = true
      }
      await setProjectGroup(projectId, memo.groupId)
      return
    }
  }
}
