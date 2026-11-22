import { isAtBottom } from '../scrollFollow'

/**
 * Por quanto tempo, depois de a largura mudar, a tela segue presa no fim.
 *
 * No navegador real (Chromium, conversa longa, Navegador fechando: 625→1250
 * px), a lista virtual remede os itens 15–50 ms depois da troca de largura e
 * recua a posição para manter o item do topo (ex.: 11323→10223). 600 ms cobre
 * essa remedição com folga e é curto o bastante para não brigar com o
 * operador — e qualquer gesto dele solta antes.
 */
export const PRENDER_MS = 600

export interface FimNaLargura {
  /** A altura total da lista mudou (`totalListHeightChanged`): dentro do instante, volta ao fim. */
  alturaMudou(): void
  /** Gesto de rolagem do operador (roda, toque, clique, tecla): solta na hora. */
  gesto(): void
  /** Desliga o observador e o `scroll`. */
  soltar(): void
}

/**
 * A coluna da direita que abre ou fecha (o `browser_open` do agente, Alt+B, o
 * Acompanhamento) muda a LARGURA da rolagem do chat: o texto refaz as quebras
 * de linha, a altura da conversa muda e a tela deixava de estar no fim. Quem
 * estava no fim ANTES da mudança volta para lá, sem animação; quem lia mais
 * acima fica onde estava.
 *
 * Voltar uma vez não basta: depois da troca a lista virtual remede os itens,
 * recua a posição e a altura total muda. Por isso, durante `PRENDER_MS` depois
 * da troca, cada mudança da altura total (`alturaMudou`, que a ChatView liga ao
 * `totalListHeightChanged` da lista) devolve a tela ao fim. O `scroll` NÃO
 * prende: no Chromium, puxar a cada `scroll` brigou com a lista, que devolvia
 * a posição a cada quadro durante todo o prazo. Não é laço: só reage a
 * eventos, e para sozinho no prazo ou no primeiro gesto do operador.
 *
 * "No fim antes" é a última leitura feita na largura antiga: cada `scroll` lê
 * de novo, mas só enquanto a largura é a que o observador conhece — o `scroll`
 * que o próprio reflow provoca (a posição presa no limite, a ancoragem do
 * navegador) já chega na largura nova e não pode apagar o que valia antes. A
 * lista abre no fim, daí o `true` de partida.
 *
 * O `scroll` sozinho não basta: o conteúdo que cresce abaixo da tela sem rolar
 * (um grupo de ações que o operador abre no fim) solta a lista — o botão "ir
 * para o fim" aparece — sem nenhum `scroll`, e `noFim` seguiria valendo. Por
 * isso a lista também precisa estar presa (`presa`). O aviso dela chega em
 * lotes de 50 ms e passa por um render, então no instante da mudança de
 * largura `presa()` ainda é o de antes dela.
 */
export function prenderFimNaLargura(
  el: HTMLElement,
  presa: () => boolean,
  agora: () => number = () => performance.now(),
): FimNaLargura {
  let largura: number | undefined
  let noFim = true
  let ate = -Infinity
  const prendendo = () => agora() < ate
  // Só escreve se saiu do fim (a escrita é um `scroll` a mais para a lista).
  const desce = () => { if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight }
  const rolou = () => {
    if (largura === undefined || el.clientWidth === largura) noFim = isAtBottom(el)
  }
  // Só a largura interessa: a altura que muda sozinha (rodapé do streaming,
  // item novo) já tem quem cuide (onFooterGrow e `followOutput`). O observador
  // só chama quando o tamanho muda de fato, nada roda a cada quadro.
  const observador = new ResizeObserver(() => {
    const w = el.clientWidth
    // A primeira medida é a de partida (a lista pode ainda nem ter descido ao fim).
    if (largura === undefined) { largura = w; return }
    if (w === largura) return
    largura = w
    // Outra troca no meio do instante (a coluna que abre e fecha em seguida)
    // segue presa: o recuo da lista pode já ter soltado `presa()`.
    if (!prendendo() && !(noFim && presa())) return
    ate = agora() + PRENDER_MS
    desce()
  })
  el.addEventListener('scroll', rolou, { passive: true })
  observador.observe(el)
  return {
    alturaMudou: () => { if (prendendo()) desce() },
    gesto: () => { ate = -Infinity },
    soltar: () => {
      el.removeEventListener('scroll', rolou)
      observador.disconnect()
    },
  }
}
