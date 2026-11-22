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

  // Goal (`/goal` do operador): o agente declara o objetivo cumprido e o laço
  // de "continue" do Claudinei para. Vale para o terminal (projeto + motor).
  server.registerTool(
    'goal_done',
    {
      description:
        'Declares that the goal the operator set in this terminal with /goal is fully met, and ends the goal loop: Claudinei stops sending its "Continue toward the goal" messages. '
        + 'Only the main agent calls this; subagents never do. '
        + 'Call it only when the goal is entirely met, every part of the criterion: not when it is partly done, blocked or merely close. '
        + 'If you cannot finish, say so in your reply instead; the loop pauses at its turn cap and the operator decides. '
        + 'The evidence must be concrete and checkable: the commands you ran and their results (test output, build status), the files changed, what the operator can verify without redoing the work. '
        + 'Fails when this terminal has no active goal.',
      inputSchema: {
        evidence: z.string().min(1).max(4000).describe('concrete proof the goal is met: commands run and their results, files changed (at most 4000 characters)'),
      },
    },
    async ({ evidence }) => {
      try {
        await call('/api/hermes/goal-done', {
          method: 'POST',
          body: JSON.stringify({ projectId: PROJECT_ID, engine: ENGINE || 'claude', evidence }),
        })
        return text('goal marked as done; the goal loop has ended')
      } catch (err) {
        const msg = (err as Error).message
        // Sem goal: diz ao agente que não há o que fechar (e não para tentar de novo).
        const hint = /no active goal/i.test(msg)
          ? '. There is nothing to close: goal_done is only for a goal the operator started with /goal in this terminal.'
          : ''
        return { ...text(`goal_done rejected: ${msg}${hint}`), isError: true }
      }
    },
  )

  // Respostas visuais: o agente publica uma página HTML que aparece como cartão
  // na conversa do terminal (projeto + motor). Adiada no Claude, como as demais.
  server.registerTool(
    'show_page',
    {
      description:
        'Shows an HTML page to the operator, as a card in this conversation in Claudinei. '
        + 'Use it when the operator asks for something visual (a chart, diagram, table, mockup, report) or when the answer reads better drawn than written. '
        + 'Pass exactly one of `html` (the whole document) or `path` (an .html or .htm file inside the project folder, absolute or relative to it), never both. '
        + 'When the page is large or will change, write the file and pass `path`. '
        + 'The page runs isolated: no forms, no fetch, XHR or WebSocket, and no access to Claudinei or to the operator\'s session. '
        + 'Scripts, styles, fonts and images load only from https://cdn.jsdelivr.net, https://unpkg.com and https://cdnjs.cloudflare.com, plus Google Fonts for styles and fonts. '
        + 'For Tailwind use <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>. '
        + 'Local images, CSS and JS referenced by relative path are embedded into the page, up to 512 KB for the whole page; what cannot be embedded is reported back. '
        + 'The call does not wait for the operator: it returns as soon as the page is shown. '
        + 'For a page with scripts or a complex layout, call check_page first to see it rendered and catch console errors.',
      inputSchema: {
        html: z.string().max(524288).optional().describe('the whole HTML document (at most 524288 characters); omit when passing path'),
        path: z.string().optional().describe('an .html or .htm file inside the project folder, absolute or relative to it; omit when passing html'),
        title: z.string().min(1).max(120).describe('short title shown on the card (1 to 120 characters)'),
        height: z.number().int().min(120).max(2000).optional().describe('suggested initial height in pixels (120 to 2000)'),
      },
    },
    async ({ html, path, title, height }) => {
      try {
        const r = await call('/api/hermes/pages', {
          method: 'POST',
          body: JSON.stringify({ projectId: PROJECT_ID, engine: ENGINE || 'claude', html, path, title, height }),
        }) as { id: string; bytes: number; warnings?: string[] }
        const head = `page shown to the operator (id ${r.id}, ${Math.max(1, Math.round(r.bytes / 1024))} KB)`
        return text([head, ...(r.warnings ?? [])].join('\n'))
      } catch (err) {
        return { ...text(`show_page rejected: ${(err as Error).message}`), isError: true }
      }
    },
  )

  // A página renderizada no navegador sem tela do servidor, para o agente
  // conferir antes do show_page. Nada é guardado nem mostrado ao operador.
  server.registerTool(
    'check_page',
    {
      description:
        'Renders an HTML page in a headless browser and returns what it looks like, without showing it to the operator. '
        + 'Use it before show_page for a page with scripts or a complex layout, to see it rendered and catch console errors. '
        + 'Pass exactly one of `html` or `path`, the same as show_page, and optionally `width` (360 to 1920 pixels, default 1024). '
        + 'The page is built the way show_page would publish it (local resources embedded, the same network rules), but nothing is stored or shown. '
        + 'Returns a screenshot of the whole page (cut at 2000 px), the content height, and up to 50 console lines, errors first, including requests the page rules blocked. '
        + 'It also returns the path of a copy of the PNG, kept for 30 min, for when tool images do not reach you. '
        + 'If it answers "busy", try again in a few moments.',
      inputSchema: {
        html: z.string().max(524288).optional().describe('the whole HTML document (at most 524288 characters); omit when passing path'),
        path: z.string().optional().describe('an .html or .htm file inside the project folder, absolute or relative to it; omit when passing html'),
        width: z.number().int().min(360).max(1920).optional().describe('viewport width in pixels (360 to 1920, default 1024)'),
      },
    },
    async ({ html, path, width }) => {
      try {
        const r = await call('/api/hermes/pages/check', {
          method: 'POST',
          body: JSON.stringify({ projectId: PROJECT_ID, html, path, width }),
        }) as { png: string; height: number; cropped: boolean; loaded: boolean; console: string[]; file: string }
        const lines = [`content height: ${r.height} px${r.cropped ? ' (screenshot cut at 2000 px)' : ''}`]
        if (!r.loaded) lines.push('the load event did not fire within 10 s; captured anyway')
        lines.push(`screenshot copy: ${r.file} (kept 30 min)`)
        lines.push(r.console.length
          ? `console (${r.console.length} ${r.console.length === 1 ? 'line' : 'lines'}, errors first):\n${r.console.join('\n')}`
          : 'console: empty')
        // Imagem e texto sempre: o motor que descarta a imagem lê o caminho da cópia.
        return {
          content: [
            { type: 'image' as const, data: r.png, mimeType: 'image/png' },
            { type: 'text' as const, text: lines.join('\n') },
          ],
        }
      } catch (err) {
        return { ...text(`check_page failed: ${(err as Error).message}`), isError: true }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
