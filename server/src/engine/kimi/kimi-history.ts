// Histórico do Kimi lido do disco (sem subprocesso: o `kimi export` gera ZIP,
// inútil para isto). Layout do data root (ver kimi-home.ts):
//   session_index.jsonl        1 linha por sessão: {sessionId, sessionDir, workDir}
//   sessions/<wd>/<id>/agents/main/wire.jsonl   o log do turno, evento por linha
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFromTail, readPositionedTail, type PositionedLine } from '../../tail.js'
import type { HistoryPage, HistoryPageOptions, PositionedEvent } from '../../history-page.js'
import type { AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'
import { kimiHomeFor } from './kimi-home.js'

interface IndexEntry { sessionId: string; sessionDir: string; workDir: string }

/** Índice de sessões do data root (arquivo pequeno: 1 linha curta por sessão). */
function readIndex(home: string): IndexEntry[] {
  const file = join(home, 'session_index.jsonl')
  if (!existsSync(file)) return []
  const out: IndexEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o?.sessionId && o?.sessionDir) out.push({ sessionId: o.sessionId, sessionDir: o.sessionDir, workDir: o.workDir ?? '' })
    } catch { /* linha corrompida: ignora */ }
  }
  return out
}

/** Última conversa desta pasta (a que o "abrir no terminal" retoma). */
export function latestSessionId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
  const entries = readIndex(kimiHomeFor(projectPath))
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].workDir !== projectPath) continue
    // Conversa de outro terminal da mesma pasta: continua andando para trás.
    if (exclude?.has(entries[i].sessionId)) continue
    return entries[i].sessionId
  }
  return null
}

export function sessionDirOf(projectPath: string, sessionId: string): string | null {
  const entries = readIndex(kimiHomeFor(projectPath))
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sessionId === sessionId) return entries[i].sessionDir
  }
  return null
}

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/**
 * Normaliza um wire.jsonl (agente `main`) para AgentEvent[]. Lê pela cauda pelo
 * mesmo motivo das outras engines: a tela usa os últimos eventos, e um log longo
 * demais fazia a leitura inteira falhar e virar "conversa vazia" (src/tail.ts).
 */
export function parseWire(file: string): Promise<AgentEvent[]> {
  return parseFromTail(file, parseWireText)
}

export function parseWireText(text: string): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const line of text.split('\n')) parseWireLine(line, (e) => events.push(e))
  return events
}

/** O mesmo parser, linha a linha, com o byte de cada linha no evento. */
export function parseWireLines(lines: PositionedLine[]): PositionedEvent[] {
  const events: PositionedEvent[] = []
  for (const { text, pos } of lines) parseWireLine(text, (e) => events.push({ ...e, pos }))
  return events
}

function parseWireLine(line: string, emit: (e: AgentEvent) => void): void {
  const s = line.trim(); if (!s) return
  let o: any; try { o = JSON.parse(s) } catch { return }

  // O texto do usuário vem do turn.prompt. O `context.append_message` que o
  // segue repete o mesmo conteúdo E carrega os system-reminders injetados
  // (plugins/skills) — usá-lo duplicaria a mensagem e poluiria o chat.
  if (o.type === 'turn.prompt' && o.origin?.kind === 'user') {
    const text = (Array.isArray(o.input) ? o.input : [])
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text).join('')
    if (text) emit(user([{ type: 'text', text }], o))
    return
  }

  if (o.type !== 'context.append_loop_event') return
  const evt = o.event
  switch (evt?.type) {
    case 'content.part': {
      const part = evt.part
      if (part?.type === 'text' && part.text) emit(assistant([{ type: 'text', text: part.text }], o))
      else if (part?.type === 'think' && part.think) emit(assistant([{ type: 'thinking', thinking: part.think }], o))
      break
    }
    case 'tool.call':
      emit(assistant([{
        type: 'tool_use',
        id: evt.toolCallId ?? evt.uuid ?? '',
        name: evt.name ?? 'tool',
        input: evt.args ?? {},
      }], o))
      break
    case 'tool.result':
      emit(user([{
        type: 'tool_result',
        tool_use_id: evt.toolCallId ?? evt.parentUuid ?? '',
        content: typeof evt.result?.output === 'string' ? evt.result.output : JSON.stringify(evt.result?.output ?? ''),
        is_error: !!evt.result?.isError,
      }], o))
      break
    // step.begin/step.end/usage.record: sem efeito no chat
  }
}

export interface TurnTokens { input: number; cachedInput: number; output: number; reasoning: number; total: number }

/**
 * Tokens do ÚLTIMO turno, somados dos `step.end` do wire (o stdout do `kimi -p`
 * não expõe usage — só o arquivo tem). Convenção de `total` igual à do Codex:
 * entrada + saída + raciocínio, sem contar o cache lido.
 */
export async function readLastTurnTokens(projectPath: string, sessionId: string): Promise<TurnTokens | undefined> {
  const dir = sessionDirOf(projectPath, sessionId)
  if (!dir) return undefined
  let text: string
  try { text = await readFile(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf8') } catch { return undefined }

  const lines = text.split('\n')
  // Só o turno atual: recomeça a contagem a cada turn.prompt.
  let input = 0, cachedInput = 0, output = 0
  let vistos = 0
  for (const line of lines) {
    const s = line.trim(); if (!s) continue
    let o: any; try { o = JSON.parse(s) } catch { continue }
    if (o.type === 'turn.prompt') { input = 0; cachedInput = 0; output = 0; vistos = 0; continue }
    if (o.type !== 'context.append_loop_event' || o.event?.type !== 'step.end') continue
    const u = o.event.usage
    if (!u) continue
    vistos++
    input += (u.inputOther ?? 0) + (u.inputCacheCreation ?? 0)
    cachedInput += u.inputCacheRead ?? 0
    output += u.output ?? 0
  }
  if (vistos === 0) return undefined
  return { input, cachedInput, output, reasoning: 0, total: input + output }
}

export function readHistory(projectPath: string, sessionId: string): Promise<AgentEvent[]> {
  const dir = sessionDirOf(projectPath, sessionId)
  if (!dir) return Promise.resolve([])
  return parseWire(join(dir, 'agents', 'main', 'wire.jsonl'))
}

/** Uma página do wire.jsonl: os eventos antes de `opts.before`, de trás para a frente. */
export async function readHistoryPage(projectPath: string, sessionId: string, opts: HistoryPageOptions): Promise<HistoryPage> {
  const dir = sessionDirOf(projectPath, sessionId)
  if (!dir) return { events: [], start: 0, atStart: true }
  const r = await readPositionedTail(join(dir, 'agents', 'main', 'wire.jsonl'), parseWireLines, opts)
  return { events: r.items, start: r.start, atStart: r.atStart }
}
