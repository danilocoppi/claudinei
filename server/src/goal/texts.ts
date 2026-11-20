/**
 * Textos fixos do goal (`/goal`): a partida e o "continue" que o Claudinei
 * manda ao agente. Vão ao agente, então ficam em inglês, com o selo que a tela
 * reconhece (como os da retomada e do aviso de tarefa).
 */

/** Selo do "continue rumo ao objetivo". */
export const GOAL_PREFIX = '[Claudinei: goal]'

/** Selo da partida (o `/goal <critério>` do operador). */
export const GOAL_START_PREFIX = '[Claudinei: goal start]'

/** Teto de turnos do goal: partida + continues, sem `goal_done`, até o teto. */
export const GOAL_MAX_TURNS = 20

/** Tamanho máximo do critério, em caracteres. */
export const GOAL_CRITERION_MAX = 2000

/** Tamanho máximo da evidência do `goal_done`, em caracteres. */
export const GOAL_EVIDENCE_MAX = 4000

/** A partida: o critério e a regra de só declarar cumprido quando estiver inteiro. */
export function goalStartText(criterion: string): string {
  return `${GOAL_START_PREFIX}: New goal: ${criterion}. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.`
}

/** O "continue" do turno `turn` (1 a 20). */
export function goalContinueText(criterion: string, turn: number): string {
  return `${GOAL_PREFIX}: Continue toward the goal: ${criterion}. Turn ${turn}/${GOAL_MAX_TURNS}. When it is fully met, call goal_done with the evidence.`
}
