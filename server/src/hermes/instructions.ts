/**
 * Instructions do MCP Hermes: o texto que cada motor (Claude, Codex, Kimi,
 * OpenCode) recebe no `initialize` e põe no contexto do agente.
 *
 * O operador roda um terminal por projeto e às vezes manda a mensagem no
 * terminal errado. Sem orientação, o agente encaminhava a tarefa ao projeto
 * certo e seguia tratando o assunto alheio ali, contaminando a conversa. A
 * regra: perguntar antes de agir, com quatro saídas, e desconsiderar o assunto
 * quando o operador mandar. Ver
 * docs/superpowers/specs/2026-11-14-mensagem-no-terminal-errado-design.md.
 */
export interface HermesProject {
  id: number
  name: string
  group?: string
  sector?: string
  hasActiveSession?: boolean
}

/** Teto da lista de outros projetos: o resto o agente vê com list_projects. */
const MAX_LISTED = 60
/**
 * Orçamento do texto inteiro. O Claude Code corta as instructions de servidor
 * MCP em 4096 caracteres guardando o começo (CLI 2.1.323); por isso a regra vem
 * primeiro e a lista, que cresce com os projetos, ocupa só o que sobra.
 */
const MAX_CHARS = 3800

const RULE = `## Messages that belong to another project
The operator runs one terminal per project and sometimes sends a message to the wrong one.
Messages that start with [Task from …] or [Question from agent of …] come from another project's agent and were routed here on purpose: do not apply this check to them.
Before acting on a message, check whether the request itself is work for another project: it is about another project's code, product or task, and nothing ties it to this one. Mentioning another project in passing (a comparison, a reference, asking you to consult its agent) does not count; when in doubt, it belongs here.
When it looks like another project's work, do not act on it yet. Ask the operator one question, in the operator's language, with these options:
1. Forward it to <project> and drop the subject here
2. Forward it to <project> and keep working on it here too
3. It belongs here, go ahead
4. Sent by mistake, ignore it
Use your question tool when you have one (AskUserQuestion); otherwise ask as text with the numbered options and wait for the answer.
To forward, use dispatch_task and rewrite the request so it stands on its own: the other agent cannot see this conversation.
After options 1 or 4, disregard that subject from then on: do not bring it up, act on it or let it shape later work here. If the operator returns to it, ask again instead of assuming.`

/**
 * Acompanhamento de tarefas longas (src/progress.ts), obrigatório por decisão do
 * operador. Como sugestão, o Claude pulava tarefas de 40-80 s (medido em sessões
 * reais); por isso o texto é de obrigação, vai nas instructions (todos os
 * motores) e, no Claude, também no prompt de sistema (--append-system-prompt).
 */
export const PROGRESS_RULE = `## Progress tracking (required)
Every request that makes you change files or work through three or more steps must be tracked with update_progress (load it with ToolSearch first if it is deferred): call it before you start, listing every planned step; again each time a step finishes or changes status; when you are blocked or need the operator; and at the end, with every step done. Skip it only for questions, explanations and a single quick command. Subagents never call it.`

/** Nome entre aspas (JSON): aspas e quebras de linha num nome não viram texto de instrução. */
function describe(p: HermesProject): string {
  const where = [p.group && `group ${JSON.stringify(p.group)}`, p.sector && `sector ${JSON.stringify(p.sector)}`].filter(Boolean)
  return `${JSON.stringify(p.name)}${where.length ? ` (${where.join(', ')})` : ''}`
}

export function buildInstructions(selfId: number, projects: HermesProject[] | undefined): string {
  const self = projects?.find((p) => p.id === selfId)
  const others = (projects ?? []).filter((p) => p.id !== selfId)
  const head = [
    self
      ? `This terminal belongs to project ${describe(self)}.`
      : 'This terminal belongs to one Claudinei project; list_projects shows the others.',
    '',
    RULE,
    '',
    PROGRESS_RULE,
  ].join('\n')
  if (others.length === 0) return head
  // Cabe quem couber no orçamento (e no teto de nomes); o resto vira contagem.
  const prefix = '\n\nOther projects: '
  const listed: string[] = []
  for (const p of others.slice(0, MAX_LISTED)) {
    const next = [...listed, describe(p)].join('; ')
    const suffix = `; …and ${others.length - listed.length - 1} more (see list_projects).`
    if (head.length + prefix.length + next.length + suffix.length > MAX_CHARS) break
    listed.push(describe(p))
  }
  const rest = others.length - listed.length
  const tail = rest > 0 ? `${listed.length ? '; ' : ''}…and ${rest} more (see list_projects).` : '.'
  return `${head}${prefix}${listed.join('; ')}${tail}`
}

/**
 * Busca os projetos na API e monta o texto. Para motores que não leem as
 * instructions dos servidores MCP (o Codex) e recebem a regra pela própria
 * conversa. Nunca falha nem segura a sessão: sem resposta em `timeoutMs`,
 * devolve a regra genérica.
 */
export async function loadInstructions(opts: { api: string; projectId: number; token?: string; timeoutMs?: number }): Promise<string> {
  const projects = await fetch(`${opts.api}/api/hermes/projects`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .then((list) => (Array.isArray(list) ? (list as HermesProject[]) : undefined))
    .catch(() => undefined)
  return buildInstructions(opts.projectId, projects)
}
