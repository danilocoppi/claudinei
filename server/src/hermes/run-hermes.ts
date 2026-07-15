// Servidor MCP "hermes": expõe ao Claude de um projeto ferramentas para
// falar com o Claude de OUTROS projetos e com o board compartilhado.
// Injetado por sessão via `claude --mcp-config` (ver server/src/claude/session.ts).
// Lógica extraída de server/hermes/hermes-mcp.mjs (Task 1 do binário único) para
// ficar importável tanto pelo modo `--hermes` do entry (server/src/index.ts)
// quanto pelo shim .mjs em dev.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
export async function runHermes(opts: { api: string; projectId: number; serviceToken?: string; engine?: string }): Promise<void> {
  const { api: API, projectId: PROJECT_ID, serviceToken, engine: ENGINE } = opts

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
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
      description: 'Lists the other Claudinei projects and whether each one has an active session (with whom you can talk).',
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
        'Sends a question to the Claude agent of ANOTHER project and returns its answer. Use to request information or coordinate. The target project needs an active session.',
      inputSchema: {
        project: z.string().describe('name of the target project'),
        question: z.string().describe('the question'),
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
      description: 'Publishes a notice/finding to the shared board, visible to all agents and the operator.',
      inputSchema: {
        title: z.string(),
        content: z.string(),
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
      description: 'Reads the latest notices posted to the shared board by agents.',
      inputSchema: {
        limit: z.number().optional(),
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
        'Delegates a TASK to the agent of another project without waiting (asynchronous). Use to coordinate parallel work. Check list_tasks afterwards to see the result.',
      inputSchema: {
        project: z.string().describe('name of the target project'),
        task: z.string().describe('the task to be executed'),
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
      description: 'Lists the dispatched tasks and the status of each one (queued/in_progress/completed/failed), with the result when ready.',
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
