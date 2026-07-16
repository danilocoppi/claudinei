import type { ChatItem, ClaudeEvent, ContentBlock } from '../types'

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

export function applyEvent(items: ChatItem[], evt: ClaudeEvent): ChatItem[] {
  switch (evt.kind) {
    case 'assistant': {
      const parentId = (evt.raw as any)?.parent_tool_use_id
      const fromSubagent = !!parentId
      // Erro interno da API do provedor: flag do transcript OU prefixo do texto
      // (o stream ao vivo não carrega a flag; o texto é gerado pelo próprio CLI).
      const flaggedApiError = !!(evt.raw as any)?.isApiErrorMessage
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      const added: ChatItem[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          const isApiError = flaggedApiError || /^API Error:/i.test(b.text)
          added.push({ kind: 'assistant_text', text: b.text, ...(fromSubagent ? { fromSubagent } : {}), ...(isApiError ? { isApiError } : {}) })
        }
        else if (b.type === 'thinking' && b.thinking) added.push({ kind: 'thinking', text: b.thinking, ...(fromSubagent ? { fromSubagent } : {}) })
        else if (b.type === 'tool_use' && b.id && b.name) added.push({ kind: 'tool_call', id: b.id, name: b.name, input: b.input, ...(fromSubagent ? { fromSubagent } : {}) })
      }
      return added.length ? [...items, ...added] : items
    }
    case 'user': {
      const raw = evt.raw as any
      const fromSubagent = !!raw?.parent_tool_use_id
      // Conteúdo do lado do usuário que a ENGINE injetou (não foi digitado):
      // isMeta (skills/harness) e isCompactSummary (continuação de contexto).
      const fromEngine = !!(raw?.isMeta || raw?.isCompactSummary)
      const marks = { ...(fromSubagent ? { fromSubagent } : {}), ...(fromEngine ? { fromEngine } : {}) }
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      let next = items
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          next = next.map((it) =>
            it.kind === 'tool_call' && it.id === b.tool_use_id
              ? { ...it, result: blockToText(b.content), isError: b.is_error === true, ...(fromSubagent ? { fromSubagent } : {}) }
              : it,
          )
        } else if (b.type === 'text' && b.text) {
          for (const it of classifyUserText(b.text)) next = [...next, { ...it, ...marks }]
        }
      }
      if (typeof evt.message.content === 'string' && evt.message.content) {
        for (const it of classifyUserText(evt.message.content)) next = [...next, { ...it, ...marks }]
      }
      return next
    }
    default:
      return items
  }
}
