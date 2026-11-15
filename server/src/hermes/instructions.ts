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

const RULE = `## Messages that belong to another project
The operator runs one terminal per project and sometimes sends a message to the wrong one.
Before acting on a message, check whether the request itself is work for another project: it is about another project's code, product or task, and nothing ties it to this one. Mentioning another project in passing (a comparison, a reference, asking you to consult its agent) does not count; when in doubt, it belongs here.
When it looks like another project's work, do not act on it yet. Ask the operator one question, in the operator's language, with these options:
1. Forward it to <project> and drop the subject here
2. Forward it to <project> and keep working on it here too
3. It belongs here, go ahead
4. Sent by mistake, ignore it
Use your question tool when you have one (AskUserQuestion); otherwise ask as text with the numbered options and wait for the answer.
To forward, use dispatch_task and rewrite the request so it stands on its own: the other agent cannot see this conversation.
After options 1 or 4, disregard that subject from then on: do not bring it up, act on it or let it shape later work here. If the operator returns to it, ask again instead of assuming.`

/** Nome entre aspas (JSON): aspas e quebras de linha num nome não viram texto de instrução. */
function describe(p: HermesProject): string {
  const where = [p.group && `group ${JSON.stringify(p.group)}`, p.sector && `sector ${JSON.stringify(p.sector)}`].filter(Boolean)
  return `${JSON.stringify(p.name)}${where.length ? ` (${where.join(', ')})` : ''}`
}

export function buildInstructions(selfId: number, projects: HermesProject[] | undefined): string {
  const self = projects?.find((p) => p.id === selfId)
  const others = (projects ?? []).filter((p) => p.id !== selfId)
  const lines: string[] = []
  lines.push(self
    ? `This terminal belongs to project ${describe(self)}.`
    : 'This terminal belongs to one Claudinei project; list_projects shows the others.')
  if (others.length > 0) {
    const listed = others.slice(0, MAX_LISTED).map(describe).join('; ')
    const rest = others.length - MAX_LISTED
    lines.push(`Other projects: ${listed}${rest > 0 ? `; …and ${rest} more (see list_projects)` : ''}.`)
  }
  lines.push('', RULE)
  return lines.join('\n')
}
