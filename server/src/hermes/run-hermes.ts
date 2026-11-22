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
    if (!res.ok) {
      // O `code` e a `hint` do corpo seguem no erro: as ferramentas do navegador os mostram ao agente.
      const b = body as { error?: string; code?: string; hint?: string }
      throw Object.assign(new Error(b.error || res.statusText), { code: b.code, hint: b.hint })
    }
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

  // Navegador embutido (server/src/browser/): a aba do terminal (projeto + motor)
  // num Chromium do servidor, que o operador vê ao vivo na coluna do Claudinei.
  // Cada ferramenta chama `POST /api/hermes/browser/<op>`; erro nunca vira
  // exceção: volta como `isError`, com o texto, o código e a dica do servidor.
  // As regras vão nas descrições: as instructions não ganham linha (orçamento).
  {
    type BrowserResult = { text: string; status: string; png?: string; path?: string }
    const LIVE = "The operator sees this same page live in Claudinei's side column (Browser view) and can take control at any time."
    const SCHEMES = 'Only http:, https: and about:blank URLs are allowed; file:, chrome:, data: and javascript: are refused.'
    const NO_EVAL = 'There is no evaluate (you cannot run your own JavaScript in the page) and no file upload. Downloads are blocked: fetch files with curl in the shell.'
    const READS = 'Reading (browser_snapshot, browser_screenshot, browser_console) works even while the operator is in control.'
    const STATUS = 'The result ends with a status line: URL, title, who is in control, and new notices (a pending dialog, a blocked download, control handed back).'

    const browser = async (op: string, args: Record<string, unknown>): Promise<BrowserResult> =>
      (await call(`/api/hermes/browser/${op}`, {
        method: 'POST',
        // Os argumentos antes: o terminal desta sessão sempre prevalece.
        body: JSON.stringify({ ...args, projectId: PROJECT_ID, engine: ENGINE || 'claude' }),
      })) as BrowserResult
    const failed = (tool: string, err: unknown) => {
      const e = err as Error & { code?: string; hint?: string }
      const code = e.code ? ` (${e.code})` : ''
      return { ...text(`${tool} failed${code}: ${e.message}${e.hint ? `\n${e.hint}` : ''}`), isError: true }
    }
    /** O handler comum: chama a rota e devolve o texto com a linha de estado. */
    const plain = (op: string) => async (args: Record<string, unknown>) => {
      try {
        const r = await browser(op, args)
        return text(`${r.text}\n${r.status}`)
      } catch (err) {
        return failed(`browser_${op}`, err)
      }
    }

    server.registerTool(
      'browser_open',
      {
        description:
          "Opens this terminal's browser tab (a headless Chromium on the Claudinei server), or reuses the one already open, and navigates it to url when you pass one. "
          + `${LIVE} `
          + 'Use it to see and test the web app you are working on: open your dev servers by http://127.0.0.1:<port> (the port the server printed), since the browser runs on the same machine as your shell. '
          + `${SCHEMES} `
          + 'Next, call browser_snapshot to read the page and get the refs that browser_act needs. The other browser_* tools work on the tab this one opens. '
          + `${NO_EVAL} `
          + 'An unused tab closes by itself after 30 minutes; call browser_close when you are done. '
          + `${STATUS}`,
        inputSchema: {
          url: z.string().optional().describe('page to load (http:, https: or about:blank); omit to keep the current page'),
        },
      },
      plain('open'),
    )

    server.registerTool(
      'browser_navigate',
      {
        description:
          "Navigates this terminal's browser tab: pass url to load a page, or action ('back', 'forward' or 'reload') to move through history; exactly one of the two. "
          + `${SCHEMES} `
          + 'reload also brings back a page that crashed. Refs from an earlier browser_snapshot stop working once the page changes: take a new snapshot. '
          + 'Needs the tab browser_open opens. Fails while the operator is in control; do not retry in a loop. '
          + `${READS} `
          + `${NO_EVAL} `
          + `${LIVE} `
          + `${STATUS}`,
        inputSchema: {
          url: z.string().optional().describe('page to load (http:, https: or about:blank)'),
          action: z.enum(['back', 'forward', 'reload']).optional().describe('history move, instead of url'),
        },
      },
      async ({ url, action }) => {
        if ((url === undefined) === (action === undefined)) {
          return { ...text("browser_navigate failed: pass exactly one of url or action ('back' | 'forward' | 'reload')"), isError: true }
        }
        return plain('navigate')({ url, action })
      },
    )

    server.registerTool(
      'browser_snapshot',
      {
        description:
          "Reads the page in this terminal's browser tab as an accessibility tree: one line per element with its role, its accessible name and a ref such as [ref=e6]. "
          + "Pass that ref to browser_act to use the element (ref 'e6'). Refs belong to the latest snapshot: after the page changes, take a new one. "
          + 'Password field values come out as ••••. A pending dialog (alert, confirm, prompt) shows at the top, and the page stays blocked until browser_act action=dialog answers it. '
          + 'The output is cut at 60000 characters with a notice; pass a smaller depth to read fewer levels of the tree. '
          + `${READS} `
          + 'Prefer it to browser_screenshot to find elements: it is text, cheaper and gives refs. '
          + `${LIVE} `
          + `${STATUS}`,
        inputSchema: {
          depth: z.number().int().positive().optional().describe('how many levels of the tree to read (default: all)'),
        },
      },
      plain('snapshot'),
    )

    server.registerTool(
      'browser_act',
      {
        description:
          "Acts on the page in this terminal's browser tab as a user would. action is one of: "
          + 'click; type (key by key, appending to the field); fill (replaces the field value); press (a key or chord such as Enter or Control+A, sent to the ref element or, without ref, to the page); '
          + 'hover; select (picks the option whose value or label is text); scroll (mouse wheel by dx, dy pixels); dialog (answers a pending alert, confirm or prompt with accept=true|false; text answers a prompt). '
          + 'click, type, fill, hover and select need a ref from the latest browser_snapshot ([ref=e6] → ref e6). A ref from before the page changed is refused: take a new browser_snapshot and use the new ref. '
          + 'While a dialog is pending, every action except dialog fails at once. '
          + 'Fails while the operator is in control: do not retry in a loop, ask the operator to hand control back if you need it. '
          + `${READS} `
          + `${NO_EVAL} `
          + `${LIVE} `
          + 'The result says what was done (clicked \'Send\') and the status line: URL, title, who is in control, new notices.',
        inputSchema: {
          action: z.enum(['click', 'type', 'fill', 'press', 'hover', 'select', 'scroll', 'dialog']),
          ref: z.string().optional().describe('element ref from the latest browser_snapshot, e.g. e6'),
          text: z.string().optional().describe('text for type and fill, option for select, answer for a prompt dialog'),
          key: z.string().optional().describe('key for press, e.g. Enter, Tab, Control+A'),
          dx: z.number().optional().describe('horizontal scroll in pixels'),
          dy: z.number().optional().describe('vertical scroll in pixels (positive goes down)'),
          accept: z.boolean().optional().describe('for dialog: true accepts, false dismisses'),
        },
      },
      plain('act'),
    )

    server.registerTool(
      'browser_wait',
      {
        description:
          "Waits on this terminal's browser tab for one condition: text appears on the page, textGone disappears, the URL matches url (exact or a glob such as **/login), or a number of seconds passes. Give exactly one. "
          + 'Capped at 30 seconds: past that it fails with a timeout, and you can check the page with browser_snapshot and wait again. '
          + 'Use it after an action that loads or updates the page, instead of sleeping in the shell. '
          + `${READS} `
          + `${LIVE} `
          + `${STATUS}`,
        inputSchema: {
          text: z.string().optional().describe('wait until this text is visible'),
          textGone: z.string().optional().describe('wait until this text is no longer visible'),
          url: z.string().optional().describe('wait until the URL matches (exact or glob)'),
          seconds: z.number().optional().describe('just wait this long (at most 30)'),
        },
      },
      plain('wait'),
    )

    server.registerTool(
      'browser_screenshot',
      {
        description:
          "Takes a PNG screenshot of this terminal's browser tab: the visible viewport, or the whole page with fullPage=true. "
          + 'The image comes in the result; it is also saved to a file, whose path comes in the text, for when you cannot see tool images (open the file instead). '
          + 'Use it to check layout and visuals; to find elements and refs, browser_snapshot is cheaper. Fails while a dialog is pending. '
          + `${READS} `
          + `${LIVE} `
          + `${STATUS}`,
        inputSchema: {
          fullPage: z.boolean().optional().describe('capture the whole scrollable page instead of the viewport'),
        },
      },
      async ({ fullPage }) => {
        try {
          const r = await browser('screenshot', { fullPage })
          return {
            content: [
              { type: 'image' as const, data: r.png ?? '', mimeType: 'image/png' },
              { type: 'text' as const, text: `saved at ${r.path}\n${r.status}` },
            ],
          }
        } catch (err) {
          return failed('browser_screenshot', err)
        }
      },
    )

    server.registerTool(
      'browser_console',
      {
        description:
          "Returns the last 50 console messages and uncaught page errors of this terminal's browser tab, oldest first, one per line as [type] text. "
          + 'Use it to debug the web app you are testing: after a click that did nothing or a blank page, look here for errors. '
          + `${READS} `
          + `${LIVE} `
          + `${STATUS}`,
        inputSchema: {},
      },
      plain('console'),
    )

    server.registerTool(
      'browser_close',
      {
        description:
          "Closes this terminal's browser tab and discards its cookies and session; closing a tab that is already closed is fine. "
          + "The page also leaves the operator's live view in Claudinei's side column. "
          + 'Call it when you are done with the browser; the next browser_open starts a new tab. '
          + 'Keep the tab open while you still need it, for instance to stay logged in.',
        inputSchema: {},
      },
      plain('close'),
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
