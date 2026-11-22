// Marcador do terminal: `CLAUDINEI_TERMINAL=<projectId>:<motor>` no ambiente do
// processo da CLI. As CLIs repassam o ambiente ao shell das ferramentas, e os
// servidores que o agente sobe herdam o marcador; a varredura lê o `environ` de
// cada processo que escuta numa porta e sabe de qual terminal ele veio.

export const TERMINAL_MARKER_VAR = 'CLAUDINEI_TERMINAL'

export function terminalMarker(projectId: number, engine: string): string {
  return `${projectId}:${engine}`
}

/** Cópia de `env` com o marcador posto (marker definido) ou apagado (undefined): nunca herda o do serviço. */
export function withMarker(env: NodeJS.ProcessEnv, marker: string | undefined): NodeJS.ProcessEnv {
  const out = { ...env }
  if (marker === undefined) delete out[TERMINAL_MARKER_VAR]
  else out[TERMINAL_MARKER_VAR] = marker
  return out
}

/**
 * Motores cuja CLI NÃO repassa o ambiente ao shell. Para eles a lista de
 * servidores cai no plano B: busca pela pasta de trabalho, com "sem marcador".
 *
 * Conferido em 21/11/2026 com as CLIs reais, um turno em cada, pedindo à
 * ferramenta de shell `echo "MARK=${CLAUDINEI_TERMINAL:-none}"`:
 * - Kimi Code 0.38.0: a ferramenta Bash devolveu `MARK=999:kimi` (repassa; o
 *   bundle monta o ambiente com `{ ...process.env, NO_COLOR, TERM, ... }`).
 *   Sem login do Kimi na máquina, o turno usou um provedor OpenAI-compatível
 *   num data root descartável; a ferramenta de shell não depende do provedor.
 * - OpenCode 0.0.0-beta-202608110357: a ferramenta bash devolveu
 *   `MARK=999:opencode` (repassa).
 * Os dois repassam, então o conjunto fica vazio.
 */
export const ENGINES_FILTERING_ENV: ReadonlySet<string> = new Set<string>()
