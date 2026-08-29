/**
 * Qual ação está com a janelinha aberta, e onde ela está — guardado no navegador.
 *
 * Sem isto, um F5 no meio de um deploy deixava o processo rodando no servidor sem
 * nada na tela que o mostrasse ou o parasse: o terminal órfão que esta tela veio
 * evitar. Com isto, a página volta e reencontra o mesmo PTY, com o que já saiu —
 * e no mesmo canto, do mesmo tamanho, minimizada se estava minimizada.
 *
 * O que é gravado é só a identidade e a POSE da janela. O conteúdo — a saída do
 * comando — mora no servidor, que é quem tem o buffer e sobrevive ao F5.
 */
export const RUN_KEY = 'claudinei:actionRun'

export interface SavedRun {
  actionId: number
  name: string
  autoClose: boolean
  /** Encolhida na pílula do canto. */
  minimized?: boolean
  /** Canto superior esquerdo, em pixels da viewport. Ausente = pousa no padrão. */
  x?: number
  y?: number
}

export const JANELA = { largura: 720, altura: 420 } as const

/**
 * Traz a janela para dentro da tela.
 *
 * A posição foi gravada numa tela que pode não ser esta: quem arrastou para a
 * direita num monitor grande e abriu no notebook encontraria a janela fora da
 * área visível — sem barra de título para trazê-la de volta, ela estaria perdida
 * de vez. Uma faixa de 120px sempre fica alcançável.
 */
export function dentroDaTela(
  x: number, y: number,
  tela = { w: window.innerWidth, h: window.innerHeight },
): { x: number; y: number } {
  const margem = 120
  return {
    x: Math.min(Math.max(x, -(JANELA.largura - margem)), tela.w - margem),
    y: Math.min(Math.max(y, 0), Math.max(0, tela.h - 40)),
  }
}

export function readRun(): SavedRun | null {
  try {
    const raw = localStorage.getItem(RUN_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SavedRun>
    // Só o que dá para usar: um `actionId` que não é número viraria uma requisição
    // a `/api/actions/undefined/run` a cada boot.
    if (typeof v?.actionId !== 'number' || typeof v?.name !== 'string') return null
    const pos = typeof v.x === 'number' && typeof v.y === 'number'
      ? dentroDaTela(v.x, v.y)
      : {}
    return {
      actionId: v.actionId,
      name: v.name,
      autoClose: !!v.autoClose,
      minimized: !!v.minimized,
      ...pos,
    }
  } catch {
    return null
  }
}

/**
 * Só o que descreve a janela vai para o disco.
 *
 * O objeto do store carrega junto estado de EXECUÇÃO (`attachOnly`, `exited`), e
 * gravar isso seria guardar a resposta de uma pergunta que a próxima sessão ainda
 * vai fazer ao servidor. Guardar demais é como um estado velho passa a mandar num
 * mundo novo.
 */
export function saveRun(run: SavedRun | null): void {
  try {
    if (!run) { localStorage.removeItem(RUN_KEY); return }
    const { actionId, name, autoClose, minimized, x, y } = run
    localStorage.setItem(RUN_KEY, JSON.stringify({ actionId, name, autoClose, minimized, x, y }))
  } catch { /* cota cheia: perde-se a restauração, não a execução */ }
}
