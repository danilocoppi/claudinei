// Marcador do terminal: `CLAUDINEI_TERMINAL=<instância>:<projectId>:<motor>` no
// ambiente do processo da CLI. As CLIs repassam o ambiente ao shell das
// ferramentas, e os servidores que o agente sobe herdam o marcador; a varredura
// lê o `environ` de cada processo que escuta numa porta e sabe de qual terminal
// ele veio.
//
// A instância é um id curto do banco (ver `markerInstanceId`): duas instâncias
// na mesma máquina (a produção e uma de ensaio, com CLAUDINEI_DB próprio) têm os
// mesmos ids de projeto, e sem ela uma listaria e PARARIA os servidores da
// outra. A varredura e o Parar só aceitam o marcador com o id desta instância.
//
// Formato antigo (`<projectId>:<motor>`, sem id): recusado de propósito.
// Aceitá-lo faria a instância de ensaio aceitá-lo também, reabrindo o buraco.
// Consequência da atualização: um servidor que o agente subiu ANTES dela (e que
// sobreviveu ao reinício) some da coluna e não se para pelo Claudinei; o
// operador o para à mão uma vez. O que as CLIs sobem depois já leva o id.
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export const TERMINAL_MARKER_VAR = 'CLAUDINEI_TERMINAL'

/** 12 hex (48 bits do sha256): curto no `environ`, sem colisão prática entre instâncias. */
const INSTANCE_ID = /^[0-9a-f]{12}$/

/**
 * O id da instância dono do banco `dbPath`: os 12 primeiros hex do sha256 do
 * caminho real (absoluto, links resolvidos; o banco ainda por criar fica no
 * absoluto). Estável entre reinícios do mesmo banco e sem vazar o caminho.
 */
export function markerInstanceId(dbPath: string): string {
  let path = resolve(dbPath)
  try { path = realpathSync(path) } catch { /* ainda não existe: fica o absoluto */ }
  return createHash('sha256').update(path).digest('hex').slice(0, 12)
}

/**
 * A instância deste processo. O serviço a fixa no arranque, pelo banco
 * (`setMarkerInstance(markerInstanceId(config.dbPath))`, no index.ts). Até lá
 * (só nos testes, que não passam pelo index.ts) vale um id aleatório do
 * processo: nunca casa com o de uma instância de verdade.
 */
let instance = randomBytes(6).toString('hex')

export function setMarkerInstance(id: string): void {
  if (!INSTANCE_ID.test(id)) throw new Error(`id de instância fora do formato: ${JSON.stringify(id)}`)
  instance = id
}

export function markerInstance(): string {
  return instance
}

export function terminalMarker(projectId: number, engine: string, inst: string = instance): string {
  return `${inst}:${projectId}:${engine}`
}

/** O marcador pedido tem o id de uma instância (o formato antigo, sem ele, não). */
export function hasInstanceId(marker: string): boolean {
  return INSTANCE_ID.test(marker.slice(0, marker.indexOf(':')))
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
