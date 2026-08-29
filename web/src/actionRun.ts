/**
 * Quais ações estão com janela aberta, e onde cada uma está — guardado no navegador.
 *
 * Sem isto, um F5 no meio de um deploy deixava o processo rodando no servidor sem
 * nada na tela que o mostrasse ou o parasse: o terminal órfão que esta tela veio
 * evitar. Com isto, a página volta e reencontra os mesmos PTYs, com o que já saiu —
 * cada um no seu canto, do seu tamanho, minimizado se estava minimizado.
 *
 * O que é gravado é só a identidade e a POSE das janelas. O conteúdo — a saída dos
 * comandos — mora no servidor, que é quem tem o buffer e sobrevive ao F5.
 */
export const RUN_KEY = 'claudinei:actionRun'

export interface SavedRun {
  actionId: number
  name: string
  autoClose: boolean
  /** Encolhida na fileira de pílulas do canto. */
  minimized?: boolean
  /** Canto superior esquerdo, em pixels da viewport. Ausente = pousa no padrão. */
  x?: number
  y?: number
}

export const JANELA = { largura: 720, altura: 420 } as const

/**
 * Onde a n-ésima janela sem posição própria pousa.
 *
 * Em cascata, e não todas no mesmo canto: duas janelas exatamente sobrepostas
 * seriam o mesmo problema que a fileira de pílulas veio resolver — só que pior,
 * porque a de baixo ficaria inalcançável até a de cima sair da frente.
 */
export const PASSO_CASCATA = 28

export function poseDefault(indice: number): { right: number; bottom: number } {
  return { right: 20 + indice * PASSO_CASCATA, bottom: 20 + indice * PASSO_CASCATA }
}

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

/** Uma entrada crua vira uma execução — ou nada, se não der para usar. */
function limpa(v: Partial<SavedRun> | null | undefined): SavedRun | null {
  // Um `actionId` que não é número viraria uma requisição a
  // `/api/actions/undefined/run` a cada boot.
  if (typeof v?.actionId !== 'number' || typeof v?.name !== 'string') return null
  const pos = typeof v.x === 'number' && typeof v.y === 'number' ? dentroDaTela(v.x, v.y) : {}
  return {
    actionId: v.actionId,
    name: v.name,
    autoClose: !!v.autoClose,
    minimized: !!v.minimized,
    ...pos,
  }
}

export function readRuns(): SavedRun[] {
  try {
    const raw = localStorage.getItem(RUN_KEY)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    // Aceita o formato antigo (uma execução solta, de quando só cabia uma janela):
    // quem atualiza no meio de um deploy não pode perder a janela dele por causa
    // do formato do armazenamento.
    const lista = Array.isArray(v) ? v : [v]
    const vistos = new Set<number>()
    return lista
      .map((x) => limpa(x as Partial<SavedRun>))
      .filter((r): r is SavedRun => !!r)
      // A janela é POR AÇÃO: duas entradas do mesmo id seriam dois clientes
      // brigando pelo mesmo PTY, e só uma sobreviveria ao token.
      .filter((r) => !vistos.has(r.actionId) && vistos.add(r.actionId))
  } catch {
    return []
  }
}

export function saveRuns(runs: SavedRun[]): void {
  try {
    if (runs.length === 0) { localStorage.removeItem(RUN_KEY); return }
    // Só o que descreve a janela vai para o disco. O objeto do store carrega junto
    // estado de EXECUÇÃO (`attachOnly`, `exited`), e gravar isso seria guardar a
    // resposta de uma pergunta que a próxima sessão ainda vai fazer ao servidor.
    localStorage.setItem(RUN_KEY, JSON.stringify(
      runs.map(({ actionId, name, autoClose, minimized, x, y }) =>
        ({ actionId, name, autoClose, minimized, x, y })),
    ))
  } catch { /* cota cheia: perde-se a restauração, não a execução */ }
}
