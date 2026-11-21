import { uploadFile } from '../api'
import { isLargePaste } from '../paste'
import type { ChatItem } from '../types'
import { requestAppend } from './sideStore'

/**
 * Trazer de volta: a última resposta da conversa lateral vai para o FIM do campo
 * da conversa principal (nunca substitui o que o operador já escreveu), com a
 * pergunta que a originou. Não entra na ordem do próximo envio: é só texto no
 * campo, que o operador revisa e manda quando quiser.
 */

/** A pergunta no rótulo vai até 80 caracteres, contando o `…` do corte. */
export const BRING_BACK_QUESTION_MAX = 80

/** Mensagem que o operador digitou (não injetada pelo motor nem de subagente). */
const isOperator = (it: ChatItem): it is Extract<ChatItem, { kind: 'user_text' }> =>
  it.kind === 'user_text' && !it.fromEngine && !it.compactSummary && !it.fromSubagent

/** Texto de resposta do agente da lateral (não o erro da API, não o de um subagente). */
const isAnswer = (it: ChatItem): it is Extract<ChatItem, { kind: 'assistant_text' }> =>
  it.kind === 'assistant_text' && !it.isApiError && !it.fromSubagent && !!it.text.trim()

/**
 * O último texto do agente depois da última mensagem do operador, com essa
 * mensagem. Null quando a última pergunta ainda não tem resposta. Sem pergunta
 * nenhuma (a lateral aberta com `/btw` sozinho), a pergunta é null.
 */
export function lastAnswer(items: ChatItem[]): { question: string | null; answer: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (isOperator(it)) return null
    if (!isAnswer(it)) continue
    for (let j = i - 1; j >= 0; j--) {
      const q = items[j]
      if (isOperator(q)) return { question: q.text, answer: it.text }
    }
    return { question: null, answer: it.text }
  }
  return null
}

/** A pergunta numa linha só e, acima do teto, cortada com `…` (por caractere, sem partir emoji). */
function shortQuestion(question: string): string {
  const one = question.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > BRING_BACK_QUESTION_MAX ? `${chars.slice(0, BRING_BACK_QUESTION_MAX - 1).join('')}…` : one
}

/** `Da conversa lateral («<pergunta>»):\n<texto>`; sem pergunta, só o rótulo. */
export function bringBackText(question: string | null, answer: string): string {
  const q = question?.trim() ? shortQuestion(question) : ''
  return q ? `Da conversa lateral («${q}»):\n${answer}` : `Da conversa lateral:\n${answer}`
}

const dois = (n: number) => String(n).padStart(2, '0')

/** Nome do anexo, na hora local: `lateral-HHMMSS.md`. */
export function bringBackFileName(now: Date = new Date()): string {
  return `lateral-${dois(now.getHours())}${dois(now.getMinutes())}${dois(now.getSeconds())}.md`
}

/**
 * Leva a última resposta da lateral ao campo da principal (`localId`). Acima da
 * régua do colar (`paste.ts`: 10 240 bytes ou 100 linhas), o texto vira o anexo
 * `lateral-HHMMSS.md` e o campo recebe só o token. Rejeita se o upload falhar
 * (nada vai ao campo). Sem resposta, não faz nada.
 */
export async function bringBack(localId: string, items: ChatItem[]): Promise<void> {
  const last = lastAnswer(items)
  if (!last) return
  const text = bringBackText(last.question, last.answer)
  if (!isLargePaste(text)) { requestAppend(localId, text); return }
  const saved = await uploadFile(new File([text], bringBackFileName(), { type: 'text/markdown' }))
  const tok = `[📎 ${saved.name}]`
  requestAppend(localId, tok, [[tok, saved.path]])
}
