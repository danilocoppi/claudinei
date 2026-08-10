import type { ChatItem } from './types'

/**
 * Nomes da ferramenta que despacha um subagente. `Task` é o nome antigo, ainda
 * presente em conversas gravadas — conversa velha reaberta continua funcionando.
 */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

export interface RunningSubagent {
  /** id do tool_use — é o `parentId` que os itens dele carregam. */
  id: string
  /** Resumo curto que o orquestrador deu ("Implement Task 1: scaffold"). */
  description: string
  /** 'general-purpose', 'Explore', … */
  type: string
  /** A tarefa completa passada ao subagente. */
  prompt: string
  /** O que ele já executou neste turno, na ordem. */
  activity: ChatItem[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Subagentes ainda em execução, com a atividade de cada um.
 *
 * "Em execução" = o tool_call do Agent ainda não recebeu `result`; quando o
 * tool_result chega, ele sai da lista sozinho. Quem chama deve exibir isto só
 * enquanto a sessão está `working`: num turno interrompido o tool_call fica sem
 * resultado para sempre, e a lista passaria a mentir que há alguém trabalhando.
 */
export function runningSubagents(items: ChatItem[]): RunningSubagent[] {
  const running = new Map<string, RunningSubagent>()
  for (const it of items) {
    if (it.kind !== 'tool_call' || !SUBAGENT_TOOLS.has(it.name) || it.result !== undefined) continue
    const input = (it.input ?? {}) as Record<string, unknown>
    running.set(it.id, {
      id: it.id,
      description: str(input.description),
      type: str(input.subagent_type),
      prompt: str(input.prompt),
      activity: [],
    })
  }
  if (running.size === 0) return []
  // Segunda passada: a atividade pode aparecer antes ou depois na lista, e um
  // parentId de subagente JÁ concluído não pertence a ninguém em execução.
  for (const it of items) {
    const parent = it.parentId ? running.get(it.parentId) : undefined
    parent?.activity.push(it)
  }
  return [...running.values()]
}
