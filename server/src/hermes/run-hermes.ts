// Servidor MCP "hermes": expõe ao Claude de um projeto ferramentas para
// falar com o Claude de OUTROS projetos e com o board compartilhado.
// Injetado por sessão via `claude --mcp-config` (ver server/src/claude/session.ts).
// Lógica extraída de server/hermes/hermes-mcp.mjs (Task 1 do binário único) para
// ficar importável tanto pelo modo `--hermes` do entry (server/src/index.ts)
// quanto pelo shim .mjs em dev.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { loadInstructions } from './instructions.js'

interface Project {
  name: string
  hasActiveSession: boolean
}

interface AskResponse {
  answer: string
}

interface BoardPost {
  projectName: string
  title: string
  content: string
}

interface DispatchResponse {
  id: number
}

interface OrchestratorTask {
  id: number
  status: string
  toProjectName: string
  toEngine?: string | null
  description: string
  result?: string
}

/** Sobe o servidor MCP hermes (stdio) com as tools de colaboração entre agentes e o acompanhamento de tarefas. Resolve quando o transporte fecha. */
export async function runHermes(opts: { api: string; projectId: number; serviceToken?: string; serviceTokenFile?: string; engine?: string }): Promise<void> {
  const { api: API, projectId: PROJECT_ID, engine: ENGINE } = opts

  // Lido do ARQUIVO a cada chamada (não cacheado): o servidor reescreve o
  // arquivo no revoke-all, então sessões longas continuam funcionando com o
  // token novo sem reiniciar o MCP.
  const currentToken = (): string | undefined => {
    if (opts.serviceTokenFile) {
      try { return readFileSync(opts.serviceTokenFile, 'utf8').trim() } catch { return opts.serviceToken }
    }
    return opts.serviceToken
  }

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const token = currentToken()
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText)
    return body
  }

  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

  // Quem é este terminal e quem são os outros, para as instructions. Nunca
  // segura a subida: sem resposta em 3 s, sobe com a regra genérica.
  const instructions = await loadInstructions({ api: API, projectId: PROJECT_ID, token: currentToken() })

  const server = new McpServer({ name: 'hermes', version: '1.0.0' }, { instructions })

  server.registerTool(
    'list_projects',
    {
      description:
        'Lists the Claudinei projects you can reach and whether each one has an agent session running right now. '
        + 'Call it before ask_agent or dispatch_task: the names it prints are the routing key those tools expect, so copy them verbatim. '
        + 'Returns one line per project, with "(active)" marking the ones with a live session; your own project is in the list too, so skip your own name. '
        + 'A project with no active session can still receive dispatch_task (the task waits in the queue), but cannot answer ask_agent.',
      inputSchema: {},
    },
    async () => {
      const projs = (await call('/api/hermes/projects')) as Project[]
      return text(projs.map((p) => `${p.name}${p.hasActiveSession ? ' (active)' : ''}`).join('\n') || 'no projects')
    },
  )

  server.registerTool(
    'ask_agent',
    {
      description:
        "Asks the agent of another project a question and waits for its answer, which comes back as this tool's result. "
        + 'Use it when you cannot continue without the answer; when you just want work done, use dispatch_task instead. '
        + 'The call blocks for up to 120 seconds and fails when the target project has no idle session — an agent in the middle of a turn is skipped, not queued, so a busy project returns an error to retry later or to replace with dispatch_task. '
        + "What comes back is the other agent's own reply text, not a delivery status.",
      inputSchema: {
        project: z.string().describe('exact project name, as list_projects prints it'),
        question: z.string().describe('the question, self-contained: the other agent cannot see your conversation'),
      },
    },
    async ({ project, question }) => {
      const r = (await call('/api/hermes/ask', {
        method: 'POST',
        body: JSON.stringify({ fromProjectId: PROJECT_ID, toProjectName: project, question }),
      })) as AskResponse
      return text(r.answer)
    },
  )

  server.registerTool(
    'post_to_board',
    {
      description:
        'Publishes a notice to the shared board, visible to every agent and to the operator. '
        + 'Use it for what others may need but nobody asked for yet: a decision taken, an interface that changed, a trap found. '
        + 'It notifies nobody and waits for nothing — another agent only sees it when that agent calls read_board. '
        + 'Rejected above the size limits below.',
      inputSchema: {
        title: z.string().describe('one-line subject, at most 500 characters'),
        content: z.string().describe('the body of the notice, at most 50000 characters'),
      },
    },
    async ({ title, content }) => {
      await call('/api/hermes/board', {
        method: 'POST',
        body: JSON.stringify({ projectId: PROJECT_ID, title, content }),
      })
      return text('posted to board')
    },
  )

  server.registerTool(
    'read_board',
    {
      description:
        'Reads the latest notices posted to the shared board, by other agents and by you. '
        + 'Call it when picking up work or before coordinating, to see what has already been decided elsewhere. '
        + 'Returns the posts as text, each one prefixed with the project that wrote it; the board is shared by every project, so entries unrelated to yours are normal.',
      inputSchema: {
        limit: z.number().optional().describe('how many posts to read (default 50)'),
      },
    },
    async ({ limit }) => {
      const posts = (await call(`/api/hermes/board${limit ? `?limit=${limit}` : ''}`)) as BoardPost[]
      return text(posts.map((p) => `[${p.projectName}] ${p.title}: ${p.content}`).join('\n\n') || 'board empty')
    },
  )

  server.registerTool(
    'dispatch_task',
    {
      description:
        "Delegates a task to another project's agent and returns immediately, without waiting for the work to be done. "
        + 'Use it to run work in parallel; when you cannot continue without the answer, use ask_agent instead. '
        + 'The task is queued even when the target has no session running, so it does not fail for unavailability — it starts once that project has an agent. '
        + 'There is no time limit: the task runs as long as the other agent needs to finish its turn. '
        + 'What comes back is a task id. '
        + 'You will be woken with the result in a Claudinei message when the task ends; you do not need to poll list_tasks.',
      inputSchema: {
        project: z.string().describe('exact project name, as list_projects prints it'),
        task: z.string().describe('what to do, self-contained: the other agent cannot see your conversation'),
      },
    },
    async ({ project, task }) => {
      const r = (await call('/api/orchestrator/dispatch', {
        method: 'POST',
        body: JSON.stringify({ fromProjectId: PROJECT_ID, toProjectName: project, description: task, ...(ENGINE ? { fromEngine: ENGINE } : {}) }),
      })) as DispatchResponse
      return text(`task dispatched (id ${r.id})`)
    },
  )

  server.registerTool(
    'list_tasks',
    {
      description:
        'Lists dispatched tasks with the status of each one (queued, in_progress, completed, failed) and the result text once it is ready. '
        + 'You do not need it to learn that a task ended: the result of what you delegated with dispatch_task arrives on its own in a Claudinei message, cut when it is long. '
        + 'Call it to reread a result in full or to see how delegated work is progressing. '
        + 'Each line carries the task id, so match on the id the dispatch gave you rather than on position.',
      inputSchema: {},
    },
    async () => {
      const tasks = (await call('/api/orchestrator/tasks')) as OrchestratorTask[]
      return text(
        tasks
          .map((t) => `#${t.id} [${t.status}] ${t.toProjectName}${t.toEngine ? ` (${t.toEngine})` : ''}: ${t.description}${t.result ? ` → ${t.result}` : ''}`)
          .join('\n') || 'no tasks',
      )
    },
  )

  // Acompanhamento de tarefas longas (src/progress.ts): o estado inteiro do
  // terminal — projeto + motor desta sessão — vai à coluna do Claudinei.
  server.registerTool(
    'update_progress',
    {
      description:
        "Publishes the progress of a long task to the operator's progress column in Claudinei, so they can follow it without reading the chat. "
        + 'Required for every request that makes you change files or work through three or more steps; skip it only for questions, explanations and a single quick command. '
        + 'Call it before you start (with all planned tasks), each time a task finishes or changes status, when you get blocked or need the operator, and when the whole task ends (every task done). '
        + 'Do not call it on every tool use. Each call replaces the whole state, so always send the full list. '
        + 'Carry over into `waiting` every item from the previous state that still depends on the operator, unless they answered it. '
        + 'A newer long task (yours, a scheduled routine or a task dispatched by another project) replaces the previous one. '
        + 'Only the main agent calls this; subagents never do. Write the texts in the operator\'s language. '
        + 'If the call is rejected, fix what the error says and call again.',
      inputSchema: {
        title: z.string().describe('the long task, in a few words'),
        now: z.object({
          title: z.string().describe('what you are doing right now'),
          detail: z.string().optional().describe('one or two sentences of detail'),
        }),
        tasks: z.array(z.object({
          name: z.string(),
          status: z.enum(['pending', 'in_progress', 'review', 'blocked', 'done']),
          note: z.string().optional().describe('short note: commit, finding, why it is blocked'),
        })).describe('every planned task, in order (at most 40)'),
        waiting: z.array(z.string()).optional().describe('what depends on the operator: decisions, answers, approvals (at most 10)'),
      },
      // O Claude adia ferramentas de MCP (o modelo só vê o nome) — e, adiada,
      // esta nunca era usada. Sempre carregada, com a descrição; as outras do
      // Hermes seguem adiadas.
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async (state) => {
      try {
        await call('/api/hermes/progress', {
          method: 'POST',
          body: JSON.stringify({ projectId: PROJECT_ID, engine: ENGINE || 'claude', state }),
        })
        return text('progress updated')
      } catch (err) {
        return { ...text(`progress rejected: ${(err as Error).message}`), isError: true }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
