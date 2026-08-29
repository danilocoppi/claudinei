/**
 * Qual ação está com a janelinha aberta — guardado no navegador.
 *
 * Sem isto, um F5 no meio de um deploy deixava o processo rodando no servidor sem
 * nada na tela que o mostrasse ou o parasse: o terminal órfão que esta tela veio
 * evitar. Com isto, a página volta e reencontra o mesmo PTY, com o que já saiu.
 *
 * O que é gravado é só a identidade da execução. O conteúdo — a saída do comando —
 * mora no servidor, que é quem tem o buffer e é quem sobrevive ao recarregamento.
 */
export const RUN_KEY = 'claudinei:actionRun'

export interface SavedRun { actionId: number; name: string; autoClose: boolean }

export function readRun(): SavedRun | null {
  try {
    const raw = localStorage.getItem(RUN_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SavedRun>
    // Só o que dá para usar: um `actionId` que não é número viraria uma requisição
    // a `/api/actions/undefined/run` a cada boot.
    if (typeof v?.actionId !== 'number' || typeof v?.name !== 'string') return null
    return { actionId: v.actionId, name: v.name, autoClose: !!v.autoClose }
  } catch {
    return null
  }
}

export function saveRun(run: SavedRun | null): void {
  try {
    if (run) localStorage.setItem(RUN_KEY, JSON.stringify(run))
    else localStorage.removeItem(RUN_KEY)
  } catch { /* cota cheia: perde-se a restauração, não a execução */ }
}
