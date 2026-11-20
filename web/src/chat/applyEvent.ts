import { isCompactSummary } from './history'
import type { ChatItem, ClaudeEvent, ContentBlock } from '../types'

/** Selo da mensagem de retomada que o servidor manda ao agente (cópia de `RESUME_PREFIX` em server/src/restart/boot.ts). */
export const RESUME_PREFIX = '[Claudinei: resume after restart]'
/** Selo da retomada na reabertura do limite de uso (cópia de `LIMIT_RESUME_PREFIX` em server/src/limit/texts.ts). */
export const LIMIT_RESUME_PREFIX = '[Claudinei: resume after usage limit]'

function blockToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b: ContentBlock) => b.text ?? '').join('\n')
  }
  return JSON.stringify(content)
}

/**
 * Mensagens "do usuário" no transcript nem sempre são texto digitado: slash
 * commands do terminal (<command-name>, <local-command-stdout>, caveat) e
 * injeções do harness (<task-notification>, <system-reminder>) chegam como
 * tags cruas — às vezes misturadas ao texto real na MESMA mensagem. Aqui cada
 * mensagem vira 0..n itens limpos: chip de comando, saída dim, nota de sistema
 * e/ou o texto real sem o ruído.
 */
function classifyUserText(text: string): ChatItem[] {
  // caveat de comando local: puro ruído, mensagem inteira some
  if (text.includes('<local-command-caveat>')) return []

  // slash command digitado no terminal (mensagem standalone no transcript)
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim()
    return [{ kind: 'local_command', command: cmd[1].trim(), ...(args ? { args } : {}) }]
  }

  // saída de comando local (standalone); vazia é descartada
  const out = text.match(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/)
  if (out) {
    const body = out[2].trim()
    return body ? [{ kind: 'command_output', text: body, ...(out[1] === 'stderr' ? { isError: true } : {}) }] : []
  }

  // Task de outro terminal: o backend a escreve no stdin do CLI como se fosse uma
  // mensagem digitada (manager.ts, dispatch_task), então no transcript ela é
  // indistinguível de texto do operador — o prefixo é o único sinal que sobrevive.
  // O reminder é retirado antes para não grudar no fim do corpo.
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  const task = cleaned.match(/^\[Task from ([^\]]+)\]:\s*([\s\S]*)$/)
  if (task) return [{ kind: 'task_message', from: task[1].trim(), text: task[2].trim() }]

  // Retomada depois de um reinício do serviço ou da reabertura do limite de
  // uso: quem escreveu foi o próprio Claudinei, em inglês para o agente.
  if (cleaned.startsWith(`${RESUME_PREFIX}:`)) {
    return [{ kind: 'claudinei_message', reason: 'restart', text: cleaned.slice(RESUME_PREFIX.length + 1).trim() }]
  }
  if (cleaned.startsWith(`${LIMIT_RESUME_PREFIX}:`)) {
    return [{ kind: 'claudinei_message', reason: 'limit', text: cleaned.slice(LIMIT_RESUME_PREFIX.length + 1).trim() }]
  }

  const scheduled = cleaned.match(/^\[Agendamento: (.+) #(\d+)\]:\s*([\s\S]*)$/)
  if (scheduled) {
    return [{
      kind: 'scheduled_message',
      name: scheduled[1].trim(), run: Number(scheduled[2]), text: scheduled[3].trim(),
    }]
  }

  // injeções misturáveis ao texto real: extrai notas e limpa o resto
  const items: ChatItem[] = []
  let rest = text
  const notes: ChatItem[] = []
  for (const m of rest.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const summary = m[0].match(/<summary>([\s\S]*?)<\/summary>/)?.[1].trim()
    notes.push({ kind: 'system_note', text: summary || 'tarefa em segundo plano atualizada' })
  }
  rest = rest
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
  if (rest) items.push({ kind: 'user_text', text: rest })
  items.push(...notes)
  return items
}

/**
 * Chave estável do item, para o React e para casar o refetch com o que já está
 * na tela. Com `pos` (byte da linha no arquivo da engine, que só cresce no fim):
 * o 1º item daquela posição é `p<pos>` e os seguintes `p<pos>.1`, `p<pos>.2`…
 * A contagem é POR POSIÇÃO, não por evento: uma linha que vira mais de um evento
 * (Codex) continua a contagem em vez de repetir `p<pos>`. Itens da mesma posição
 * são sempre consecutivos, então basta olhar o último da lista.
 */
function posKey(list: ChatItem[], pos: number): string {
  const base = `p${pos}`
  const last = list[list.length - 1]?.key
  if (last === base) return `${base}.1`
  if (last?.startsWith(`${base}.`)) return `${base}.${Number(last.slice(base.length + 1)) + 1}`
  return base
}

let liveSeq = 0
/** Chave provisória de item ao vivo (sem posição): `l<n>`, única nesta página. O refetch a troca pela `p…` confirmada. */
export function liveKey(): string {
  return `l${++liveSeq}`
}

/** Resultado de ferramenta cuja chamada não está na lista (ficou numa página mais antiga). */
export type OnOrphan = (toolUseId: string, result: string, isError: boolean) => void

/**
 * Núcleo MUTÁVEL: aplica o evento direto em `list` e diz se mexeu. O reduce de
 * uma página inteira usa uma lista só (linear); `applyEvent` copia antes, para o
 * caminho ao vivo continuar imutável.
 */
export function applyEventInto(list: ChatItem[], evt: ClaudeEvent, onOrphan?: OnOrphan): boolean {
  const pos = 'pos' in evt && typeof evt.pos === 'number' ? evt.pos : undefined
  const keyed = (it: ChatItem): ChatItem => ({ ...it, key: pos === undefined ? liveKey() : posKey(list, pos) })
  switch (evt.kind) {
    case 'assistant': {
      const parentId = (evt.raw as any)?.parent_tool_use_id
      const fromSubagent = !!parentId
      // Guardar de QUAL subagente veio (não só QUE veio de um) é o que permite
      // acompanhar vários em paralelo: sem o parentId, as ações de três
      // subagentes simultâneos viram uma lista indistinguível.
      const sub = fromSubagent ? { fromSubagent: true as const, parentId: parentId as string } : {}
      // Erro interno da API do provedor: flag do transcript OU prefixo do texto
      // (o stream ao vivo não carrega a flag; o texto é gerado pelo próprio CLI).
      const flaggedApiError = !!(evt.raw as any)?.isApiErrorMessage
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      let changed = false
      for (const b of blocks) {
        let it: ChatItem | null = null
        if (b.type === 'text' && b.text) {
          const isApiError = flaggedApiError || /^API Error:/i.test(b.text)
          it = { kind: 'assistant_text', text: b.text, ...sub, ...(isApiError ? { isApiError } : {}) }
        }
        else if (b.type === 'thinking' && b.thinking) it = { kind: 'thinking', text: b.thinking, ...sub }
        else if (b.type === 'tool_use' && b.id && b.name) it = { kind: 'tool_call', id: b.id, name: b.name, input: b.input, ...sub }
        if (it) { list.push(keyed(it)); changed = true }
      }
      return changed
    }
    case 'user': {
      const raw = evt.raw as any
      const parentId = raw?.parent_tool_use_id
      const fromSubagent = !!parentId
      // Conteúdo do lado do usuário que a ENGINE injetou (não foi digitado):
      // isMeta (skills/harness) e isCompactSummary (continuação de contexto).
      //
      // `isSynthetic` é a MESMA coisa vista pelo outro lado: o stream-json AO VIVO
      // não manda isMeta — marca o injetado como isSynthetic; só o transcript usa
      // isMeta. Medido no CLI 2.1.223 com o texto idêntico de uma skill: ao vivo
      // {isSynthetic:true}, no histórico {isMeta:true}. Sem os dois, toda skill
      // aparecia como bolha do usuário até o histórico recarregar (o refetch do
      // fim do turno troca o item ao vivo pelo confirmado, com as flags dele).
      // Codex identifica developer/system no adaptador; as flags raw são do Claude.
      const fromEngine = !!(evt.fromEngine || raw?.isMeta || raw?.isCompactSummary || raw?.isSynthetic)
      const marks = { ...(fromSubagent ? { fromSubagent: true as const, parentId: parentId as string } : {}), ...(fromEngine ? { fromEngine } : {}) }
      // Resumo de compactação: a flag vem nos dois caminhos (ao vivo e transcript);
      // o preâmbulo fixo é a rede para um raw sem ela. É da engine por definição.
      const stamp = (it: ChatItem): ChatItem =>
        it.kind === 'user_text' && (raw?.isCompactSummary === true || isCompactSummary(it.text))
          ? { ...it, fromEngine: true, compactSummary: true }
          : it
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      let changed = false
      // O resumo absorve a fronteira imediatamente anterior (e o preTokens dela):
      // a fronteira sozinha não tem o que mostrar, e o resumo sem ela não sabe o tamanho.
      const push = (it: ChatItem) => {
        const stamped = keyed(stamp(it))
        const prev = list[list.length - 1]
        if (stamped.kind === 'user_text' && stamped.compactSummary && prev?.kind === 'compact_boundary') {
          list[list.length - 1] = prev.preTokens !== undefined ? { ...stamped, preTokens: prev.preTokens } : stamped
        } else {
          list.push(stamped)
        }
        changed = true
      }
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          // De trás para a frente: a chamada costuma estar logo antes do resultado.
          // Copia só aquele item — o reduce de milhares de eventos não pode ser quadrático.
          const result = blockToText(b.content)
          const isError = b.is_error === true
          const i = findLastCall(list, b.tool_use_id)
          if (i < 0) { onOrphan?.(b.tool_use_id, result, isError); continue }
          list[i] = { ...list[i], result, isError, ...(fromSubagent ? { fromSubagent } : {}) } as ChatItem
          changed = true
        } else if (b.type === 'text' && b.text) {
          for (const it of classifyUserText(b.text)) push({ ...it, ...marks })
        }
      }
      if (typeof evt.message.content === 'string' && evt.message.content) {
        for (const it of classifyUserText(evt.message.content)) push({ ...it, ...marks })
      }
      return changed
    }
    case 'system': {
      if (evt.subtype === 'message_error' && typeof (evt.raw as any)?.message === 'string') {
        list.push(keyed({ kind: 'command_output', text: (evt.raw as any).message, isError: true }))
        return true
      }
      if (evt.subtype !== 'compact_boundary') return false
      // Ao vivo o stream-json manda compact_metadata.pre_tokens; o transcript
      // grava compactMetadata.preTokens (CLI 2.1.261). Os dois caminhos passam aqui.
      const raw = evt.raw as { compact_metadata?: { pre_tokens?: unknown }; compactMetadata?: { preTokens?: unknown } } | undefined
      const pre = raw?.compact_metadata?.pre_tokens ?? raw?.compactMetadata?.preTokens
      list.push(keyed(typeof pre === 'number' ? { kind: 'compact_boundary', preTokens: pre } : { kind: 'compact_boundary' }))
      return true
    }
    default:
      return false
  }
}

/** `findLastIndex` (ES2023) à mão: o alvo do projeto é ES2022. */
function findLastCall(list: ChatItem[], id: string): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]
    if (it.kind === 'tool_call' && it.id === id) return i
  }
  return -1
}

/** Versão imutável, do caminho ao vivo: devolve a MESMA lista quando o evento não muda nada. */
export function applyEvent(items: ChatItem[], evt: ClaudeEvent): ChatItem[] {
  // Evento que não vira item não paga a cópia.
  if (evt.kind !== 'assistant' && evt.kind !== 'user' && evt.kind !== 'system') return items
  if (evt.kind === 'system' && evt.subtype !== 'message_error' && evt.subtype !== 'compact_boundary') return items
  const next = items.slice()
  return applyEventInto(next, evt) ? next : items
}
