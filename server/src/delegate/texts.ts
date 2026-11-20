/**
 * Textos fixos do aviso de resultado de tarefa delegada: a mensagem do
 * Claudinei que acorda o terminal que delegou. Vai ao agente, então fica em
 * inglês, com o selo que a tela reconhece (como o da retomada do reinício).
 */

/** Selo da mensagem: o agente (e quem lê o chat) sabe que foi o Claudinei. */
export const TASK_RESULT_PREFIX = '[Claudinei: task result]'

/** Corte do resultado de cada tarefa, em caracteres; o texto inteiro segue em list_tasks. */
export const TASK_RESULT_MAX = 4000

/** Uma tarefa que terminou, como o aviso a mostra. */
export interface TaskResultItem {
  id: number
  toProjectName: string
  status: 'completed' | 'failed'
  result: string | null
}

/**
 * Corta o resultado em `TASK_RESULT_MAX` caracteres e, quando corta, termina
 * com o rodapé que manda ao list_tasks. Não parte um par substituto (emoji) ao
 * meio: um meio-caractere solto viraria lixo no agente e na tela.
 */
function cutResult(id: number, result: string): string {
  if (result.length <= TASK_RESULT_MAX) return result
  let end = TASK_RESULT_MAX
  const code = result.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${result.slice(0, end)}\n(full text: list_tasks #${id})`
}

/** Um bloco por tarefa: a linha do cabeçalho e, abaixo, o resultado (cortado). */
function block(t: TaskResultItem): string {
  const head = `Task #${t.id} sent to ${t.toProjectName} ${t.status}.`
  return t.result ? `${head}\n${cutResult(t.id, t.result)}` : head
}

/**
 * A mensagem inteira: o selo uma vez e um bloco por tarefa, na ordem dada,
 * separados por uma linha em branco. Uma tarefa só:
 * `[Claudinei: task result]: Task #<id> sent to <Projeto> completed.` + o resultado.
 */
export function taskResultText(tasks: TaskResultItem[]): string {
  return `${TASK_RESULT_PREFIX}: ${tasks.map(block).join('\n\n')}`
}
