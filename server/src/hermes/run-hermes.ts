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

/** Sobe o servidor MCP hermes (stdio) com as 6 tools de colaboração entre agentes. Resolve quando o transporte fecha. */
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

  const server = new McpServer({ name: 'hermes', version: '1.0.0' })

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
        + 'What comes back is a task id: call list_tasks later to read the outcome.',
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
        + 'Call it to collect what you delegated with dispatch_task — a dispatch returns only an id, and this is where the outcome shows up. '
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

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
