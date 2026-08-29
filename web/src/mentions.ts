/**
 * Referência a outro terminal no meio do texto: `@@` abre a lista, e o que fica
 * escrito é o NOME exato dele.
 *
 * O nome, e não um id, porque é o nome que as ferramentas de colaboração recebem:
 * `dispatch_task` e `ask_agent` pedem `project: string`, e o servidor resolve com
 * comparação exata (ignorando maiúsculas) contra a lista de projetos. Uma
 * referência que não fosse o nome exato viraria
 * `project "..." does not exist` na mão do agente.
 */

/** Como a referência aparece no texto: delimitada, porque nome tem espaço. */
export const marcaDe = (nome: string) => `@[${nome}]`

/**
 * O gatilho está logo antes do cursor?
 *
 * Exige que o `@@` comece palavra — sem isso, colar um e-mail com `@@` ou digitar
 * dentro de uma palavra abriria a lista no meio da frase, sem ninguém pedir.
 */
export function mentionAt(text: string, cursor: number): number | null {
  const ate = text.slice(0, cursor)
  if (!ate.endsWith('@@')) return null
  const inicio = cursor - 2
  const anterior = inicio > 0 ? text[inicio - 1] : ' '
  return /[\s([{]/.test(anterior) ? inicio : null
}

/** Troca o `@@` pela referência, e devolve onde o cursor deve ficar. */
export function applyMention(
  text: string, cursor: number, nome: string,
): { text: string; cursor: number } {
  const inicio = mentionAt(text, cursor)
  if (inicio === null) return { text, cursor }
  // Espaço no fim: quem escolheu um terminal vai continuar a frase, e ter de
  // digitar o espaço à mão seria uma cerimônia por escolha.
  const marca = `${marcaDe(nome)} `
  return {
    text: text.slice(0, inicio) + marca + text.slice(cursor),
    cursor: inicio + marca.length,
  }
}

/**
 * Filtra a lista pelo que se digitou na busca.
 *
 * Sem acento e sem caixa: procurar "sessao" tem de achar "Sessão", senão o campo
 * de busca só serve para quem já sabe escrever o nome exatamente como está.
 */
const dobra = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function filterTerminals<T extends { name: string }>(itens: T[], busca: string): T[] {
  const q = dobra(busca.trim())
  if (!q) return itens
  // Todos os pedaços, em qualquer ordem: "adm vaexa" acha "Vaexa - Admin".
  const partes = q.split(/\s+/)
  return itens.filter((i) => { const n = dobra(i.name); return partes.every((p) => n.includes(p)) })
}
