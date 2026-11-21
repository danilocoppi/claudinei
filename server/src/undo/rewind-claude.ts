import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { turnKey } from '../../../shared/undo.js'
import type { SessionManager } from '../claude/manager.js'
import { claudeConfigDir } from '../engine/claude-engine.js'
import { transcriptPath } from '../history.js'
import { UserError } from '../user-error.js'
import type { ClaudeCut, RewindAdapter } from './rewind.js'

export type { ClaudeCut }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Mesma defesa do relaunch: o id vira nome de arquivo e argv.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * Partes `text` juntadas com `\n`. A web faz um item por parte (applyEvent.ts),
 * e o occurrenceOf da Task 14 precisa concordar; hoje o Claudinei manda uma
 * parte de texto só por mensagem.
 */
function joinTextParts(parts: any[]): string {
  return parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n')
}

/** Sem `<system-reminder>` e aparado, como na web (classifyUserText); vazio → `null`. */
function cleanText(text: string): string | null {
  if (text.includes('<command-name>')) return null
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return cleaned || null
}

/**
 * O texto de uma entrada do transcript que o operador (ou o Claudinei por ele)
 * mandou; `null` quando a entrada não é mensagem dessas: injeção do CLI
 * (`isMeta`), subagente (`isSidechain`), resumo de compactação, resultado de
 * ferramenta e comando de barra.
 */
function userText(entry: any): string | null {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null
  const content = entry.message?.content
  if (typeof content === 'string') return cleanText(content)
  if (!Array.isArray(content) || content.some((p: any) => p?.type === 'tool_result')) return null
  return cleanText(joinTextParts(content))
}

/**
 * O texto de uma mensagem que entrou no meio do turno: o CLI a grava como
 * `attachment` `queued_command` com `commandMode: 'prompt'` (fato do transcript
 * real, R20), com o prompt em string ou em lista de partes. Outros modos
 * (`bash`…) não são mensagem ao agente.
 */
function queuedText(entry: any): string | null {
  if (!entry || entry.type !== 'attachment' || entry.isMeta || entry.isSidechain) return null
  const att = entry.attachment
  if (att?.type !== 'queued_command' || att.commandMode !== 'prompt') return null
  if (typeof att.prompt === 'string') return cleanText(att.prompt)
  return Array.isArray(att.prompt) ? cleanText(joinTextParts(att.prompt)) : null
}

/**
 * Onde cortar a conversa para voltar à mensagem com a chave `key`: a
 * `occurrence`-ésima ocorrência contando de trás para frente (0 = a última).
 * Devolve o `parentUuid` da entrada, porque o `--resume-session-at` mantém a
 * entrada indicada (ensaio C2, corte inclusivo); `null` nele = era a primeira
 * mensagem. Não achou (ou o transcript sumiu) → `null`.
 *
 * A mensagem enfileirada no meio do turno (`queued_command`) conta como
 * ocorrência, para nunca cair numa mensagem anterior de mesmo texto; se for a
 * escolhida, `null`: cortar no meio do turno não foi ensaiado (R20).
 *
 * Lê linha a linha: o transcript pode ter centenas de MB. Linha quebrada é
 * pulada. Só guarda os candidatos com a chave certa.
 */
export async function findClaudeCut(transcriptFile: string, key: string, occurrence: number): Promise<ClaudeCut | null> {
  if (!Number.isInteger(occurrence) || occurrence < 0 || !key) return null
  const found: Array<{ parentUuid: string | null; queued: boolean }> = []
  const stream = createReadStream(transcriptFile, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Filtro barato antes do JSON.parse: só entradas do usuário e as enfileiradas interessam.
      if (!line.includes('"user"') && !line.includes('queued_command')) continue
      let entry: any
      try { entry = JSON.parse(line) } catch { continue }
      const queued = queuedText(entry)
      const text = queued ?? userText(entry)
      if (text === null || turnKey(text) !== key) continue
      if (typeof entry.uuid !== 'string') continue
      found.push({ parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null, queued: queued !== null })
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  } finally {
    lines.close()
    stream.destroy()
  }
  const at = found.length - 1 - occurrence
  if (at < 0 || found[at].queued) return null
  return { kind: 'claude', parentUuid: found[at].parentUuid }
}

/** Os args que cortam a conversa em `atUuid` e a abrem como `newSessionId` (ensaios C2 e C3). */
export function claudeForkArgs(atUuid: string, newSessionId: string): string[] {
  if (!UUID.test(atUuid)) throw new Error(`ponto de corte inválido: ${JSON.stringify(atUuid)}`)
  if (!UUID.test(newSessionId)) throw new Error(`id de sessão novo inválido: ${JSON.stringify(newSessionId)}`)
  return ['--resume-session-at', atUuid, '--fork-session', '--session-id', newSessionId]
}

export function createClaudeRewind(deps: { manager: Pick<SessionManager, 'relaunch' | 'get'>; newId?: () => string }): RewindAdapter {
  const { manager } = deps
  const newId = deps.newId ?? randomUUID

  /** O id da conversa atual do terminal: o do ctx, senão o que o manager conhece. */
  function currentId(ctx: { localId: string; engineSessionId: string | null }): string | null {
    return ctx.engineSessionId ?? manager.get(ctx.localId)?.engineSessionId ?? null
  }

  return {
    async locate(ctx, key, occurrence) {
      const id = currentId(ctx)
      if (!id || !SESSION_ID.test(id)) return null
      return findClaudeCut(transcriptPath(claudeConfigDir(), ctx.projectPath, id), key, occurrence)
    },

    async apply(ctx, cut) {
      if (cut.kind !== 'claude') throw new Error('corte de outro motor')
      // Era a primeira mensagem: nada fica, conversa nova.
      if (cut.parentUuid === null) {
        await manager.relaunch(ctx.localId, { resumeSessionId: null, holdEngineId: true })
        return {}
      }
      const current = currentId(ctx)
      if (!current) throw new UserError('no_session', 'o terminal não tem conversa do Claude para voltar')
      const forkId = newId()
      // O id novo só vai ao banco no primeiro result (holdEngineId): se o
      // processo morrer antes, o terminal segue na conversa antiga.
      await manager.relaunch(ctx.localId, { resumeSessionId: current, extraArgs: claudeForkArgs(cut.parentUuid, forkId), holdEngineId: true })
      return { newConversationId: forkId }
    },
  }
}
